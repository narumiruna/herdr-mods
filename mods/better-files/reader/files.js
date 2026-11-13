import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const MAX_DOCUMENT_BYTES = 1024 * 1024
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export function within(root, file) {
  const path = relative(root, file)
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
  )
}

export async function boundedRead(file, limit, expected) {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("Not a regular file")
    if (
      expected &&
      (stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.mtimeMs !== expected.mtimeMs ||
        stat.size !== expected.size)
    )
      throw new Error("File changed before reading")
    if (stat.size > limit) throw new Error(`File exceeds the ${limit} byte limit`)
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size, null)
      if (!next.bytesRead) break
      size += next.bytesRead
    }
    if (size > limit) throw new Error(`File exceeds the ${limit} byte limit`)
    if (size > stat.size) throw new Error("File changed while reading")
    const after = await handle.stat()
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs
    )
      throw new Error("File changed while reading")
    return buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
}

export async function workspaceFile(root, file) {
  if (
    typeof root !== "string" ||
    typeof file !== "string" ||
    !isAbsolute(root) ||
    !isAbsolute(file)
  ) {
    throw new Error("An absolute file and workspace root are required")
  }
  const canonicalRoot = await realpath(root)
  if (!(await lstat(canonicalRoot)).isDirectory())
    throw new Error("Workspace root must be a directory")
  const canonicalFile = await realpath(file)
  if (!within(canonicalRoot, canonicalFile)) throw new Error("File is outside the workspace root")
  return { root: canonicalRoot, file: canonicalFile }
}

export async function workspaceRead(location, limit) {
  const expected = await lstat(location.file)
  const bytes = await boundedRead(location.file, limit, expected)
  const after = await workspaceFile(location.root, location.file)
  const info = await lstat(location.file)
  if (
    after.root !== location.root ||
    after.file !== location.file ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino ||
    info.mtimeMs !== expected.mtimeMs ||
    info.size !== expected.size
  )
    throw new Error("Workspace file changed while reading")
  return bytes
}

export async function loadDocument(request) {
  if (request.on !== null && request.on !== undefined) {
    throw new Error("Remote Markdown is not supported. No local file was read.")
  }
  const location = await workspaceFile(request.root, request.file)
  if (!/\.(?:md|markdown)$/i.test(location.file)) throw new Error("Select a .md or .markdown file")
  const bytes = await workspaceRead(location, MAX_DOCUMENT_BYTES)
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (source.includes("\0")) throw new Error("Binary files cannot be read as Markdown")
  return { ...location, source }
}

export function classifyURL(value, file) {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return { kind: "blocked" }
  if (value.startsWith("#")) {
    try {
      return { kind: "fragment", fragment: decodeURIComponent(value.slice(1)) }
    } catch {
      return { kind: "blocked" }
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value)
      if (["https:", "http:", "mailto:"].includes(url.protocol)) {
        return { kind: "external", url: url.href }
      }
    } catch {}
    return { kind: "blocked" }
  }
  if (value.startsWith("//") || !value) return { kind: "blocked" }
  try {
    const url = new URL(value, pathToFileURL(file))
    if (url.protocol !== "file:" || url.search) return { kind: "blocked" }
    return {
      kind: "local",
      file: fileURLToPath(url),
      fragment: decodeURIComponent(url.hash.slice(1)),
    }
  } catch {
    return { kind: "blocked" }
  }
}

export function localPath(root, file, href) {
  const target = classifyURL(href, file)
  if (target.kind !== "local" || !within(root, resolve(target.file))) return null
  return target
}
