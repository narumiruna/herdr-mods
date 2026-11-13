import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ASSET_LIMIT, AssetCache, CACHE_LIMIT, digest } from "../reader/cache.js"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

let base
let cache
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"></svg>'
const job = "reader-job-1234"
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markdown-cache-")))
  cache = await new AssetCache(join(base, "profile")).init()
})
afterEach(async () => {
  vi.mocked(lstat).mockReset()
  await rm(base, { recursive: true, force: true })
})

async function sparseAsset(index, size = ASSET_LIMIT) {
  const name = `${digest(`fixture-${index}`)}.svg`
  const path = join(cache.assets, name)
  const handle = await open(path, "wx")
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  await utimes(path, new Date(1000 + index), new Date(1000 + index))
  return name
}

it("creates only a temporary profile cache and writes immutable digest-named assets", async () => {
  const asset = await cache.put(svg, "svg")
  expect(asset).toBe(`data/better-files/assets/${digest(svg)}.svg`)
  expect(await readFile(join(cache.home, asset), "utf8")).toBe(svg)
  expect(await cache.put(svg, "svg")).toBe(asset)
  expect(await readdir(cache.assets)).toEqual([basename(asset)])
  expect((await lstat(join(cache.home, asset))).mode & 0o777).toBe(0o600)
})

it("uses a separate namespace without migrating or deleting old reader data", async () => {
  const old = join(cache.home, "data", "markdown-reader")
  const entries = [
    ["requests", "expired-job-1234.json"],
    ["leases", "expired-job-1234.json"],
    ["renders", `${digest("old-render")}.json`],
    ["assets", `${digest("old-asset")}.svg`],
  ]
  for (const [directory, name] of entries) {
    await mkdir(join(old, directory), { recursive: true })
    const path = join(old, directory, name)
    await writeFile(path, "old reader data")
    await utimes(path, new Date(1000), new Date(1000))
  }
  const fresh = await new AssetCache(cache.home).init()
  expect(fresh.directory).toBe(join(cache.home, "data", "better-files"))
  expect(await readdir(fresh.assets)).toEqual([])
  expect(await fresh.put(svg, "svg")).toMatch(/^data\/better-files\/assets\//)
  for (const [directory, name] of entries)
    expect(await readFile(join(old, directory, name), "utf8")).toBe("old reader data")
})

it("collects expired job files and abandoned temporary assets but preserves active leases", async () => {
  const expired = join(cache.directory, "requests", "expired-job-1234.json")
  const cancel = `${expired}.cancel`
  const active = join(cache.directory, "requests", "active-job-1234.json")
  const temporary = join(cache.assets, ".aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
  for (const path of [expired, cancel, active, temporary]) {
    await writeFile(path, "{}")
    await utimes(path, new Date(1000), new Date(1000))
  }
  await cache.lease("active-job-1234", [])
  await cache.collect()
  expect(await readdir(join(cache.directory, "requests"))).toEqual(["active-job-1234.json"])
  expect(await readdir(cache.assets)).not.toContain(".aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
})

describe("collection races", () => {
  const entries = [
    ["leases", "reader-job-1234.json"],
    ["requests", "reader-job-1234.json"],
    ["requests", "reader-job-1234.json.cancel"],
    ["assets", ".aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    ["renders", ".aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
  ]

  it.each(entries)("skips %s/%s removed between readdir and lstat", async (directory, name) => {
    const path = join(cache.directory, directory, name)
    await writeFile(path, "{")
    await utimes(path, new Date(1000), new Date(1000))
    const actual = await vi.importActual("node:fs/promises")
    vi.mocked(lstat).mockImplementationOnce(async (target) => {
      expect(target).toBe(path)
      await rm(path)
      return actual.lstat(target)
    })
    await expect(cache.collect()).resolves.toBeUndefined()
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(cache.directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(entries)("propagates other lstat errors for %s/%s", async (directory, name) => {
    const path = join(cache.directory, directory, name)
    await writeFile(path, "{")
    await utimes(path, new Date(1000), new Date(1000))
    const error = Object.assign(new Error("lstat denied"), { code: "EACCES" })
    vi.mocked(lstat).mockRejectedValueOnce(error)
    await expect(cache.collect()).rejects.toBe(error)
    expect(await readFile(path, "utf8")).toBe("{")
    await expect(lstat(join(cache.directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([".json", ".json.cancel"])(
    "propagates non-ENOENT errors when checking the lease for a stale request%s",
    async (suffix) => {
      const path = join(cache.directory, "requests", `reader-job-1234${suffix}`)
      await writeFile(path, "{}")
      await utimes(path, new Date(1000), new Date(1000))
      const actual = await vi.importActual("node:fs/promises")
      const error = Object.assign(new Error("lease lstat denied"), { code: "EACCES" })
      vi.mocked(lstat).mockImplementationOnce(actual.lstat).mockRejectedValueOnce(error)
      await expect(cache.collect()).rejects.toBe(error)
      expect(await readFile(path, "utf8")).toBe("{}")
      await expect(lstat(join(cache.directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" })
    },
  )
})

it("fails closed if a host lease renewal is temporarily incomplete", async () => {
  const name = basename(await cache.put(svg, "svg"))
  await writeFile(join(cache.directory, "leases", "reader-job-1234.json"), "{")
  expect(await cache.protectedAssets()).toEqual(new Set([name]))
})

it("separates renderer kind, source, theme, fonts and width in deterministic keys", () => {
  const options = { width: 800, dark: false, fontFamily: "sans-serif" }
  const key = cache.key("math", "x", options)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(cache.key("math", "x", { ...options })).toBe(key)
  for (const other of [
    cache.key("mermaid", "x", options),
    cache.key("math", "y", options),
    cache.key("math", "x", { ...options, width: 900 }),
    cache.key("math", "x", { ...options, dark: true }),
    cache.key("math", "x", { ...options, fontFamily: "serif" }),
  ])
    expect(other).not.toBe(key)
})

it("rejects empty, oversized and unapproved asset formats", async () => {
  await expect(cache.put("", "svg")).rejects.toThrow("4 MiB")
  await expect(cache.put(Buffer.alloc(ASSET_LIMIT + 1), "png")).rejects.toThrow("4 MiB")
  await expect(cache.put(svg, "html")).rejects.toThrow("asset type")
  await expect(cache.put(svg, "../svg")).rejects.toThrow("asset type")
  expect(await readdir(cache.assets)).toEqual([])
})

it("rejects a symlink in the cache directory chain", async () => {
  const home = join(base, "unsafe")
  await mkdir(home)
  await symlink(cache.home, join(home, "data"))
  await expect(new AssetCache(home).init()).rejects.toThrow("symbolic links")
})

it("does not accept an existing asset symlink or change its outside target", async () => {
  const outside = join(base, "outside.svg")
  await writeFile(outside, "private")
  await symlink(outside, join(cache.assets, `${digest(svg)}.svg`))
  await expect(cache.put(svg, "svg")).rejects.toThrow()
  expect(await readFile(outside, "utf8")).toBe("private")
})

it("does not reuse a corrupt existing digest-named asset", async () => {
  await writeFile(join(cache.assets, `${digest(svg)}.svg`), "corrupt")
  await expect(cache.put(svg, "svg")).rejects.toThrow()
})

it("does not accept an existing asset directory", async () => {
  await mkdir(join(cache.assets, `${digest(svg)}.svg`))
  await expect(cache.put(svg, "svg")).rejects.toThrow()
})

it("round-trips render metadata and verifies the asset digest on every hit", async () => {
  const key = cache.key("math", "x", {})
  const result = { asset: await cache.put(svg, "svg"), width: 10, height: 20 }
  await cache.remember(key, result)
  await expect(cache.rendered(key)).resolves.toEqual({ ...result, svg })
  await writeFile(join(cache.home, result.asset), "tampered")
  await expect(cache.rendered(key)).resolves.toBeNull()
})

it("leases new assets and cached render hits for the current job before returning", async () => {
  const asset = await cache.put(svg, "svg", job)
  const path = join(cache.directory, "leases", `${job}.json`)
  expect(JSON.parse(await readFile(path, "utf8")).assets).toEqual([basename(asset)])
  const key = cache.key("math", "x", {})
  await cache.remember(key, { asset, width: 10, height: 20 })
  const nextJob = "another-job-1234"
  const nextCache = await new AssetCache(cache.home).init()
  expect(await nextCache.rendered(key, nextJob)).toMatchObject({ asset, svg })
  expect(
    JSON.parse(await readFile(join(cache.directory, "leases", `${nextJob}.json`), "utf8")).assets,
  ).toEqual([basename(asset)])
})

it("releases the cache lock after an action fails and serializes concurrent writes", async () => {
  await expect(
    cache.locked(async () => {
      throw new Error("action failed")
    }),
  ).rejects.toThrow("action failed")
  await expect(lstat(join(cache.directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" })
  const assets = await Promise.all(Array.from({ length: 5 }, () => cache.put(svg, "svg")))
  expect(new Set(assets).size).toBe(1)
  expect(await readdir(cache.assets)).toEqual([basename(assets[0])])
  await expect(lstat(join(cache.directory, ".lock"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("treats invalid keys, malformed metadata and unsafe asset paths as misses", async () => {
  for (const key of ["../outside", "", "a".repeat(63), "A".repeat(64)]) {
    await expect(cache.rendered(key)).resolves.toBeNull()
  }
  const key = digest("metadata")
  const path = join(cache.directory, "renders", `${key}.json`)
  for (const value of [
    "not json",
    "x".repeat(4097),
    JSON.stringify({ asset: "../../outside.svg" }),
    JSON.stringify({ asset: `data/markdown-reader/assets/${digest(svg)}.svg` }),
  ]) {
    await writeFile(path, value)
    await expect(cache.rendered(key)).resolves.toBeNull()
  }
})

it("does not read a rendered asset through a symlink", async () => {
  const key = digest("symlink")
  const asset = `data/better-files/assets/${digest(svg)}.svg`
  const outside = join(base, "external.svg")
  await writeFile(outside, svg)
  await symlink(outside, join(cache.home, asset))
  await cache.remember(key, { asset, width: 10, height: 20 })
  await expect(cache.rendered(key)).resolves.toBeNull()
})

it("treats a symlinked render metadata file as a cache miss", async () => {
  const asset = await cache.put(svg, "svg")
  const outside = join(base, "outside-metadata.json")
  await writeFile(outside, JSON.stringify({ asset, width: 10, height: 20 }))
  const key = digest("metadata-symlink")
  await symlink(outside, join(cache.directory, "renders", `${key}.json`))
  expect(await cache.rendered(key)).toBeNull()
})

it("rejects unsafe remember keys before writing outside renders", async () => {
  await expect(cache.remember("../escaped", { asset: "unsafe" })).rejects.toThrow()
  await expect(lstat(join(cache.directory, "escaped.json"))).rejects.toMatchObject({
    code: "ENOENT",
  })
})

describe("bounded storage and leases", () => {
  it("evicts the oldest unused asset while retaining current reader assets", async () => {
    const names = []
    for (let index = 0; index < CACHE_LIMIT / ASSET_LIMIT; index++)
      names.push(await sparseAsset(index))
    await cache.lease(job, [`data/better-files/assets/${names[0]}`])
    await cache.put("new asset", "svg")
    const remaining = await readdir(cache.assets)
    expect(remaining).toContain(names[0])
    expect(remaining).not.toContain(names[1])
    expect(remaining).toHaveLength(16)
  })

  it("fails safely when all cache assets have current leases", async () => {
    const assets = []
    for (let index = 0; index < CACHE_LIMIT / ASSET_LIMIT; index++) {
      assets.push(`data/better-files/assets/${await sparseAsset(index)}`)
    }
    await cache.lease(job, assets)
    await expect(cache.put("new asset", "svg")).rejects.toThrow("active assets")
    expect(await readdir(cache.assets)).toHaveLength(16)
  })

  it("deduplicates current leases, renews them, and removes expired leases", async () => {
    const asset = await cache.put(svg, "svg")
    const path = join(cache.directory, "leases", `${job}.json`)
    await cache.lease(job, [asset, asset])
    const lease = JSON.parse(await readFile(path, "utf8"))
    expect(lease.assets).toEqual([basename(asset)])
    expect(lease.expires).toBeGreaterThan(Date.now())
    expect(await cache.protectedAssets()).toEqual(new Set([basename(asset)]))
    await writeFile(path, JSON.stringify({ ...lease, expires: Date.now() - 1 }))
    expect(await cache.protectedAssets()).toEqual(new Set())
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
    await cache.lease(job, [asset])
    expect(await cache.protectedAssets()).toEqual(new Set([basename(asset)]))
  })

  it("rejects unsafe lease jobs and invalid asset names", async () => {
    for (const name of ["../job", "short", "A".repeat(8), "a".repeat(101)]) {
      await expect(cache.lease(name, [])).rejects.toThrow("reader job")
    }
    await expect(cache.lease(job, ["../../bad.svg"])).rejects.toThrow("leased asset")
  })

  it("caps render metadata to 512 entries", async () => {
    for (let index = 0; index < 512; index++) {
      const path = join(cache.directory, "renders", `${digest(String(index))}.json`)
      await writeFile(path, "{}")
      await utimes(path, new Date(index * 1000), new Date(index * 1000))
    }
    await cache.remember(digest("new"), {
      asset: await cache.put(svg, "svg"),
      width: 10,
      height: 20,
    })
    const names = await readdir(join(cache.directory, "renders"))
    expect(names).toHaveLength(512)
    expect(names).not.toContain(`${digest("0")}.json`)
    expect(names).toContain(`${digest("new")}.json`)
  })
})
