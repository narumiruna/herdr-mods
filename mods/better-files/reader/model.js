const ASSET = /^data\/better-files\/assets\/[a-f0-9]{64}\.(?:svg|png|jpg|gif|webp)$/
const JOB = /^[a-z0-9-]{8,100}$/

function absolutePath(value) {
  return (
    typeof value === "string" &&
    /^(?:\/(?!\/)|[a-z]:[\\/])/i.test(value) &&
    !value.split(/[\\/]/).some((part) => part === "." || part === "..") &&
    ![...value].some((char) => char.charCodeAt(0) < 32)
  )
}

function contained(root, file) {
  if (!absolutePath(root) || !absolutePath(file)) return false
  let base = root.replace(/\\/g, "/").replace(/\/$/, "")
  let target = file.replace(/\\/g, "/")
  if (/^[a-z]:/i.test(base)) {
    base = base.toLowerCase()
    target = target.toLowerCase()
  }
  return target === base || target.startsWith(`${base}/`)
}

export function validEntry(entry) {
  if (entry?.on !== null && entry?.on !== undefined)
    throw new Error("Remote Markdown is not supported. No local file was read.")
  if (
    typeof entry?.file !== "string" ||
    typeof entry.root !== "string" ||
    !entry.file ||
    !entry.root
  )
    throw new Error("Open a Markdown file with explicit file and workspace root props")
  if (!contained(entry.root, entry.file))
    throw new Error("An absolute file inside the workspace root is required")
  return { file: entry.file, root: entry.root, on: null }
}

export function validateManifest(value) {
  if (
    value?.version !== 1 ||
    !JOB.test(value.job) ||
    typeof value.file !== "string" ||
    typeof value.root !== "string" ||
    typeof value.source !== "string" ||
    typeof value.signature !== "string" ||
    !Array.isArray(value.blocks) ||
    !Array.isArray(value.assets) ||
    !value.links ||
    !value.anchors
  )
    throw new Error("Invalid reader helper response")
  if (!contained(value.root, value.file)) throw new Error("Helper returned an unsafe document path")
  if (value.assets.some((asset) => typeof asset !== "string" || !ASSET.test(asset)))
    throw new Error("Helper returned an unsafe asset path")
  let count = 0
  const inspect = (block, depth) => {
    if (++count > 1000 || depth > 40 || typeof block?.id !== "string")
      throw new Error("Helper document is too complex")
    if (block.type === "graphic") {
      if (
        !ASSET.test(block.asset) ||
        !value.assets.includes(block.asset) ||
        !Number.isFinite(block.width) ||
        !Number.isFinite(block.height) ||
        block.width <= 0 ||
        block.height <= 0 ||
        block.width > 16384 ||
        block.height > 16384 ||
        block.width * block.height > 16000000
      )
        throw new Error("Helper returned an invalid graphic")
    } else if (block.type === "container") {
      if (!Array.isArray(block.children)) throw new Error("Invalid document container")
      for (const child of block.children) inspect(child, depth + 1)
    } else if (block.type === "html") {
      if (typeof block.html !== "string") throw new Error("Invalid document text")
    } else if (!["code", "error"].includes(block.type) || typeof block.source !== "string")
      throw new Error("Invalid document block")
  }
  for (const block of value.blocks) inspect(block, 0)
  for (const [url, target] of Object.entries(value.links)) {
    if (
      !/^https:\/\/herdr-markdown\.invalid\/link\/\d+$/.test(url) ||
      !["local", "external", "fragment"].includes(target?.kind)
    )
      throw new Error("Invalid helper link")
    if (
      target.kind === "local" &&
      (target.root !== value.root || !contained(value.root, target.file))
    )
      throw new Error("Invalid local link")
    if (target.kind === "external" && !/^(?:https?:\/\/|mailto:)/i.test(target.url))
      throw new Error("Invalid external link")
  }
  return value
}

export class ReaderSession {
  constructor(io, entry) {
    this.io = io
    this.entry = validEntry(entry)
    this.manifest = null
    this.error = ""
    this.busy = false
    this.closed = false
    this.serial = 0
    this.pending = null
    this.current = null
    this.renewals = new Map()
    this.retiring = new Set()
  }

  retire(request) {
    const cleanup = this.release(request)
    this.retiring.add(cleanup)
    void cleanup.then(
      () => this.retiring.delete(cleanup),
      () => this.retiring.delete(cleanup),
    )
  }

  async release(request) {
    await this.renewals.get(request)
    await this.io.release(request).catch(() => {})
  }

  async refresh(options) {
    if (this.closed) return false
    const serial = ++this.serial
    const previousPending = this.pending
    this.pending = null
    this.busy = true
    this.error = ""
    let request
    try {
      if (previousPending) await this.io.cancel(previousPending).catch(() => {})
      if (this.closed || serial !== this.serial) return false
      request = await this.io.request(this.entry, options)
      if (this.closed || serial !== this.serial) {
        await this.io.release(request)
        return false
      }
      this.pending = request
      const manifest = validateManifest(await this.io.render(request))
      if (manifest.job !== request.job) throw new Error("Helper returned another reader's job")
      if (this.closed || serial !== this.serial) {
        await this.io.release(request)
        return false
      }
      this.pending = null
      if (this.manifest?.signature === manifest.signature) {
        await this.io.release(request)
        return false
      }
      const previous = this.current
      this.current = request
      this.manifest = manifest
      if (previous) this.retire(previous)
      return true
    } catch (error) {
      if (request) await this.io.release(request).catch(() => {})
      if (!this.closed && serial === this.serial)
        this.error = String(error?.message || error).slice(0, 2000)
      return false
    } finally {
      if (serial === this.serial) {
        this.pending = null
        this.busy = false
      }
    }
  }

  async heartbeat() {
    const current = this.current
    if (this.closed || !current || !this.manifest || this.renewals.has(current)) return
    const renewal = this.io.renew(current, this.manifest.assets).catch(() => {})
    this.renewals.set(current, renewal)
    try {
      await renewal
    } finally {
      this.renewals.delete(current)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.serial++
    const pending = this.pending
    const current = this.current
    this.pending = null
    this.current = null
    this.busy = false
    if (pending) await this.io.cancel(pending).catch(() => {})
    if (current) await this.release(current)
    await Promise.allSettled(this.retiring)
  }
}
