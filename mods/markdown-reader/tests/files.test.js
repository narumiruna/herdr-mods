import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  boundedRead,
  classifyURL,
  loadDocument,
  localPath,
  MAX_DOCUMENT_BYTES,
  within,
  workspaceFile,
} from "../files.js"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original()
  return { ...actual, open: vi.fn(actual.open) }
})

let base
let root
let file
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "markdown-files-")))
  root = join(base, "workspace")
  await fs.mkdir(root)
  file = join(root, "中文 notes.MD")
  await fs.writeFile(file, "# Hello 世界\n")
  vi.mocked(fs.open).mockClear()
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe("local document loading", () => {
  it("returns canonical paths and complete UTF-8 source", async () => {
    const alias = join(base, "workspace-alias")
    await fs.symlink(root, alias)
    expect(await loadDocument({ root: alias, file: join(alias, "中文 notes.MD") })).toEqual({
      root,
      file,
      source: "# Hello 世界\n",
    })
  })

  it.each([false, "remote-host", "", 0, {}])(
    "rejects remote identity %j before any file open",
    async (on) => {
      await expect(loadDocument({ on, file: "/missing.md", root: "/missing" })).rejects.toThrow(
        "Remote Markdown",
      )
      expect(fs.open).not.toHaveBeenCalled()
    },
  )

  it.each([null, undefined])("accepts local identity %j", async (on) => {
    await expect(loadDocument({ root, file, on })).resolves.toMatchObject({ file })
  })

  it("rejects a missing document before opening it", async () => {
    await expect(loadDocument({ root, file: join(root, "missing.md") })).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(fs.open).not.toHaveBeenCalled()
  })

  it("rejects non-Markdown files before reading bytes", async () => {
    const other = join(root, "notes.txt")
    await fs.writeFile(other, "text")
    await expect(loadDocument({ root, file: other })).rejects.toThrow(".markdown")
    expect(fs.open).not.toHaveBeenCalled()
  })

  it.each([
    ["binary", Buffer.from("text\0hidden"), /Binary/],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]), /encoded|encoding|UTF/i],
  ])("rejects %s instead of replacing or truncating it", async (_name, bytes, error) => {
    await fs.writeFile(file, bytes)
    await expect(loadDocument({ root, file })).rejects.toThrow(error)
  })

  it("accepts the exact document limit and rejects one more byte", async () => {
    await fs.writeFile(file, "a".repeat(MAX_DOCUMENT_BYTES))
    expect((await loadDocument({ root, file })).source).toHaveLength(MAX_DOCUMENT_BYTES)
    await fs.appendFile(file, "b")
    await expect(loadDocument({ root, file })).rejects.toThrow("byte limit")
  })

  it("rejects an oversized file before calling read on its handle and closes it", async () => {
    const read = vi.fn()
    const close = vi.fn()
    vi.mocked(fs.open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 101 }),
      read,
      close,
    })
    await expect(boundedRead(file, 100)).rejects.toThrow("100 byte limit")
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("opens nonblocking before checking regular-file type and rejects changed identities", async () => {
    const read = vi.fn()
    const close = vi.fn()
    vi.mocked(fs.open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => false, size: 0 }),
      read,
      close,
    })
    await expect(boundedRead(file, 100)).rejects.toThrow("regular file")
    const { constants } = await import("node:fs")
    expect(fs.open.mock.calls[0][1] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    vi.mocked(fs.open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 1, ino: 2, dev: 1, mtimeMs: 1 }),
      read,
      close,
    })
    await expect(boundedRead(file, 100, { size: 1, ino: 1, dev: 1, mtimeMs: 1 })).rejects.toThrow(
      "changed before",
    )
  })

  it("rejects a file used as the workspace root", async () => {
    await expect(workspaceFile(file, file)).rejects.toThrow("directory")
  })

  it("rejects directories and does not follow a final symlink in boundedRead", async () => {
    await expect(boundedRead(root, 100)).rejects.toThrow("regular file")
    const alias = join(root, "alias.md")
    await fs.symlink(file, alias)
    await expect(boundedRead(alias, 100)).rejects.toThrow()
  })
})

describe("workspace containment", () => {
  it.each([
    ["/work", "/work", true],
    ["/work", "/work/sub/a.md", true],
    ["/work", "/work-other/a.md", false],
    ["/work", "/a.md", false],
  ])("within(%s, %s) is %s", (parent, child, expected) => {
    expect(within(parent, child)).toBe(expected)
  })

  it.each([
    ["relative", "/absolute.md"],
    ["/absolute", "relative.md"],
    [null, "/absolute.md"],
  ])("requires absolute root and file: %j, %j", async (parent, child) => {
    await expect(workspaceFile(parent, child)).rejects.toThrow("absolute")
  })

  it("rejects traversal and sibling-prefix paths", async () => {
    const outside = join(base, "outside.md")
    await fs.writeFile(outside, "secret")
    await expect(workspaceFile(root, join(root, "../outside.md"))).rejects.toThrow("outside")
    const sibling = `${root}-other`
    await fs.mkdir(sibling)
    await fs.writeFile(join(sibling, "a.md"), "secret")
    await expect(workspaceFile(root, join(sibling, "a.md"))).rejects.toThrow("outside")
    expect(fs.open).not.toHaveBeenCalled()
  })

  it("rejects file and directory symlinks that escape the canonical root", async () => {
    await fs.writeFile(join(base, "secret.md"), "secret")
    await fs.symlink(join(base, "secret.md"), join(root, "escape.md"))
    await fs.symlink(base, join(root, "escape-dir"))
    for (const target of [join(root, "escape.md"), join(root, "escape-dir/secret.md")]) {
      await expect(loadDocument({ root, file: target })).rejects.toThrow("outside")
    }
    expect(fs.open).not.toHaveBeenCalled()
  })

  it("permits an internal symlink but returns its canonical target", async () => {
    const alias = join(root, "internal.md")
    await fs.symlink(file, alias)
    await expect(workspaceFile(root, alias)).resolves.toEqual({ root, file })
  })
})

describe("URL policy", () => {
  it.each(["https://example.test/a", "http://example.test/a", "mailto:reader@example.test"])(
    "marks %s as explicit external navigation, not a local resource",
    (href) => expect(classifyURL(href, file)).toMatchObject({ kind: "external", url: href }),
  )

  it.each([
    "//host/file.md",
    "file:///etc/passwd",
    "data:text/html,test",
    "javascript:alert(1)",
    "ftp://host/file",
    "ws://host",
    "",
    "a\\b.md",
    "a\n.md",
    "https://host/\u0000",
    "#bad%zz",
    "bad%zz.md",
    "notes.md?query=1",
  ])("blocks dangerous or malformed URL %j", (href) => {
    expect(classifyURL(href, file)).toEqual({ kind: "blocked" })
  })

  it("decodes fragments and resolves relative paths from the document directory", () => {
    expect(classifyURL("#%E4%B8%AD%E6%96%87", file)).toEqual({ kind: "fragment", fragment: "中文" })
    expect(classifyURL("./other%20note.md#section", file)).toEqual({
      kind: "local",
      file: join(root, "other note.md"),
      fragment: "section",
    })
    expect(localPath(root, file, "../outside.md")).toBeNull()
    expect(localPath(root, file, "%2e%2e/outside.md")).toBeNull()
    expect(localPath(root, file, "https://example.test")).toBeNull()
    expect(localPath(root, file, "inside.md")).toMatchObject({ file: join(root, "inside.md") })
  })
})
