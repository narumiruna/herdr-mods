import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { boundedRead } from "./files.js"

export const CACHE_LIMIT = 64 * 1024 * 1024
export const ASSET_LIMIT = 4 * 1024 * 1024
export const ASSET_NAME = /^[a-f0-9]{64}\.(?:svg|png|jpg|gif|webp)$/
export const JOB_NAME = /^[a-z0-9-]{8,100}$/
export const RENDER_VERSION = "2-mermaid12.3-mathjax3.2-vega6.4"
export const digest = (value) => createHash("sha256").update(value).digest("hex")

async function safeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory())
    throw new Error("Cache directories must not be symbolic links")
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return null
  }
}

export class AssetCache {
  constructor(appHome) {
    if (typeof appHome !== "string" || !appHome) throw new Error("An app home is required")
    this.home = resolve(appHome)
    this.directory = join(this.home, "data", "markdown-reader")
    this.assets = join(this.directory, "assets")
    this.usedAssets = new Set()
  }

  async init() {
    for (const path of [
      this.home,
      join(this.home, "data"),
      this.directory,
      this.assets,
      join(this.directory, "renders"),
      join(this.directory, "leases"),
      join(this.directory, "requests"),
    ]) {
      await safeDirectory(path)
    }
    await this.collect()
    return this
  }

  async collect() {
    await this.locked(async () => {
      const leases = join(this.directory, "leases")
      for (const name of await readdir(leases)) {
        if (!/^[a-z0-9-]{8,100}\.json$/.test(name)) continue
        const path = join(leases, name)
        try {
          const lease = JSON.parse((await boundedRead(path, 65536)).toString("utf8"))
          if (lease.expires > Date.now() && lease.expires <= Date.now() + 120000) continue
          await rm(path, { force: true })
        } catch (error) {
          if (error.code !== "ENOENT") {
            const info = await lstatIfPresent(path)
            if (info && Date.now() - info.mtimeMs > 120000) await rm(path, { force: true })
          }
        }
      }
      const requests = join(this.directory, "requests")
      for (const name of await readdir(requests)) {
        if (!/^[a-z0-9-]{8,100}\.json(?:\.cancel)?$/.test(name)) continue
        const path = join(requests, name)
        const info = await lstatIfPresent(path)
        if (!info || Date.now() - info.mtimeMs <= 120000) continue
        const job = name.replace(/\.json(?:\.cancel)?$/, "")
        if (await lstatIfPresent(join(leases, `${job}.json`))) continue
        await rm(path, { force: true })
      }
      if ((await readdir(requests)).length > 512 || (await readdir(leases)).length > 512)
        throw new Error("Too many active Markdown reader jobs")
      for (const directory of [this.assets, join(this.directory, "renders")]) {
        for (const name of await readdir(directory)) {
          if (/^\.[a-f0-9-]{36}$/.test(name)) {
            const path = join(directory, name)
            const info = await lstatIfPresent(path)
            if (info && Date.now() - info.mtimeMs > 120000) await rm(path, { force: true })
          }
        }
      }
    })
  }

  async locked(action) {
    const lock = join(this.directory, ".lock")
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 })
        break
      } catch (error) {
        if (error.code !== "EEXIST" || attempt >= 100)
          throw new Error("Markdown cache is busy; retry shortly")
        try {
          const age = Date.now() - (await lstat(lock)).mtimeMs
          if (age > 30000) await rm(lock, { recursive: true, force: true })
          else await new Promise((done) => setTimeout(done, 20))
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
      }
    }
    try {
      return await action()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }

  async protectedAssets() {
    const protectedNames = new Set()
    const leases = join(this.directory, "leases")
    for (const name of await readdir(leases)) {
      if (!/^[a-z0-9-]{8,100}\.json$/.test(name)) continue
      try {
        const path = join(leases, name)
        const lease = JSON.parse((await boundedRead(path, 65536)).toString("utf8"))
        if (
          lease.expires > Date.now() &&
          lease.expires <= Date.now() + 120000 &&
          Array.isArray(lease.assets)
        ) {
          for (const asset of lease.assets) if (ASSET_NAME.test(asset)) protectedNames.add(asset)
        } else await rm(path, { force: true })
      } catch (error) {
        // The host cannot renew leases atomically. Fail closed during a partial renewal.
        if (error.code !== "ENOENT") {
          for (const asset of await readdir(this.assets))
            if (ASSET_NAME.test(asset)) protectedNames.add(asset)
        }
      }
    }
    return protectedNames
  }

  async protect(job, name) {
    this.usedAssets.add(`data/markdown-reader/assets/${name}`)
    if (job) await this.lease(job, [...this.usedAssets])
  }

  async put(value, extension, job) {
    const bytes = Buffer.from(value)
    if (!bytes.length || bytes.length > ASSET_LIMIT)
      throw new Error("Rendered asset exceeds the 4 MiB limit")
    const name = `${digest(bytes)}.${extension}`
    if (!ASSET_NAME.test(name)) throw new Error("Invalid asset type")
    await this.locked(async () => {
      const target = join(this.assets, name)
      try {
        const info = await lstat(target)
        if (!info.isFile()) throw new Error("Invalid existing Markdown asset")
        const existing = await boundedRead(target, ASSET_LIMIT)
        if (digest(existing) !== name.split(".")[0])
          throw new Error("Corrupt existing Markdown asset")
        await utimes(target, new Date(), new Date())
        await this.protect(job, name)
        return
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
      const protectedNames = await this.protectedAssets()
      const entries = []
      for (const existing of await readdir(this.assets)) {
        if (!ASSET_NAME.test(existing)) continue
        const info = await lstat(join(this.assets, existing))
        if (!info.isFile()) throw new Error("Invalid entry in the Markdown asset cache")
        entries.push({ name: existing, size: info.size, time: info.mtimeMs })
      }
      let total = entries.reduce((sum, entry) => sum + entry.size, 0)
      for (const entry of entries.sort((a, b) => a.time - b.time)) {
        if (total + bytes.length <= CACHE_LIMIT) break
        if (protectedNames.has(entry.name)) continue
        await rm(join(this.assets, entry.name))
        total -= entry.size
      }
      if (total + bytes.length > CACHE_LIMIT)
        throw new Error("Markdown cache is full of active assets; close another reader and retry")
      const temporary = join(this.assets, `.${randomUUID()}`)
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" })
        await rename(temporary, target)
        await this.protect(job, name)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    return `data/markdown-reader/assets/${name}`
  }

  key(kind, source, options) {
    return digest(JSON.stringify([RENDER_VERSION, kind, source, options]))
  }

  async rendered(key, job) {
    if (!/^[a-f0-9]{64}$/.test(key)) return null
    return this.locked(async () => {
      try {
        const path = join(this.directory, "renders", `${key}.json`)
        const result = JSON.parse((await boundedRead(path, 4096)).toString("utf8"))
        const name = result.asset?.split("/").pop()
        if (!ASSET_NAME.test(name) || result.asset !== `data/markdown-reader/assets/${name}`)
          return null
        const assetPath = join(this.assets, name)
        const info = await lstat(assetPath)
        if (!info.isFile() || info.size > ASSET_LIMIT) return null
        const bytes = await boundedRead(assetPath, ASSET_LIMIT)
        if (digest(bytes) !== name.split(".")[0]) return null
        await utimes(assetPath, new Date(), new Date())
        await this.protect(job, name)
        return { ...result, svg: bytes.toString("utf8") }
      } catch {
        return null
      }
    })
  }

  async remember(key, result) {
    if (!/^[a-f0-9]{64}$/.test(key) || !ASSET_NAME.test(result.asset?.split("/").pop()))
      throw new Error("Invalid render cache entry")
    await this.locked(async () => {
      const directory = join(this.directory, "renders")
      const entries = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      if (entries.length >= 512) {
        const oldest = await Promise.all(
          entries.map(async (name) => ({
            name,
            time: (await stat(join(directory, name))).mtimeMs,
          })),
        )
        for (const entry of oldest.sort((a, b) => a.time - b.time).slice(0, entries.length - 511))
          await rm(join(directory, entry.name), { force: true })
      }
      const target = join(directory, `${key}.json`)
      const temporary = join(directory, `.${randomUUID()}`)
      try {
        await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" })
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  async lease(job, assets) {
    if (!JOB_NAME.test(job)) throw new Error("Invalid reader job")
    const names = assets.map((asset) => asset.split("/").pop())
    if (names.some((name) => !ASSET_NAME.test(name))) throw new Error("Invalid leased asset")
    const target = join(this.directory, "leases", `${job}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        JSON.stringify({ expires: Date.now() + 60000, assets: [...new Set(names)] }),
        { mode: 0o600, flag: "wx" },
      )
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
