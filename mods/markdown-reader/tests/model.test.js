import { describe, expect, it, vi } from "vitest"
import { ReaderSession, validateManifest, validEntry } from "../model.js"

const entry = { root: "/workspace", file: "/workspace/notes.md", on: null }
const asset = `data/markdown-reader/assets/${"a".repeat(64)}.svg`
const manifest = (job = "reader-job-0001", extra = {}) => ({
  version: 1,
  job,
  ...entry,
  source: "# Good",
  signature: "signature-1",
  blocks: [{ id: "block-1", type: "html", html: "<h1>Good</h1>" }],
  assets: [],
  links: {},
  anchors: {},
  warnings: [],
  dependencies: [entry.file],
  ...extra,
})
function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function setup() {
  let index = 0
  const io = {
    request: vi.fn(async () => ({ job: `reader-job-${String(++index).padStart(4, "0")}` })),
    render: vi.fn(async (request) => manifest(request.job)),
    cancel: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    renew: vi.fn(async () => {}),
  }
  return { io, session: new ReaderSession(io, entry) }
}

it("validates local entry props and rejects remote identity before any I/O", () => {
  expect(validEntry({ ...entry, ignored: true })).toEqual(entry)
  expect(validEntry({ file: entry.file, root: entry.root })).toEqual(entry)
  for (const value of [undefined, {}, { file: "", root: "/" }, { root: "/" }]) {
    expect(() => validEntry(value)).toThrow("explicit")
  }
  const io = { request: vi.fn() }
  for (const on of [false, "remote", "", 0]) {
    expect(() => new ReaderSession(io, { ...entry, on })).toThrow("Remote Markdown")
  }
  expect(io.request).not.toHaveBeenCalled()
})

describe("manifest validation", () => {
  it("accepts safe recursive blocks, links and immutable asset paths", () => {
    const value = manifest(undefined, {
      assets: [asset],
      blocks: [
        {
          id: "group",
          type: "container",
          children: [
            { id: "graphic", type: "graphic", asset, width: 100, height: 50 },
            { id: "code", type: "code", source: "const x = 1" },
            { id: "error", type: "error", source: "invalid" },
          ],
        },
      ],
      links: {
        "https://herdr-markdown.invalid/link/0": { kind: "external", url: "https://example.test/" },
        "https://herdr-markdown.invalid/link/1": { kind: "local", ...entry },
        "https://herdr-markdown.invalid/link/2": { kind: "fragment", fragment: "heading" },
      },
    })
    expect(validateManifest(value)).toBe(value)
  })

  it.each([
    { version: 2 },
    { job: "short" },
    { job: "../reader-job" },
    { source: null },
    { signature: undefined },
    { blocks: {} },
    { assets: null },
    { links: null },
    { anchors: null },
  ])("rejects malformed response fields %j", (change) => {
    expect(() => validateManifest(manifest(undefined, change))).toThrow()
  })

  it.each([
    "/tmp/asset.svg",
    "../assets/asset.svg",
    `data/markdown-reader/assets/../${"a".repeat(64)}.svg`,
    `data/markdown-reader/assets/${"a".repeat(64)}.html`,
    `file:///tmp/${"a".repeat(64)}.svg`,
  ])("rejects unsafe asset path %s", (path) => {
    expect(() => validateManifest(manifest(undefined, { assets: [path] }))).toThrow(
      "unsafe asset path",
    )
  })

  it.each([
    { asset: "../escape.svg", width: 1, height: 1 },
    { asset, width: 0, height: 1 },
    { asset, width: 1, height: -1 },
    { asset, width: Infinity, height: 1 },
    { asset, width: 1, height: NaN },
    { asset, width: 16385, height: 1 },
    { asset, width: 5000, height: 5000 },
  ])("rejects invalid graphics %j", (graphic) => {
    expect(() =>
      validateManifest(
        manifest(undefined, {
          assets: [asset],
          blocks: [{ id: "graphic", type: "graphic", ...graphic }],
        }),
      ),
    ).toThrow("invalid graphic")
  })

  it("rejects an asset referenced by a block but absent from the manifest asset list", () => {
    expect(() =>
      validateManifest(
        manifest(undefined, {
          blocks: [{ id: "graphic", type: "graphic", asset, width: 1, height: 1 }],
        }),
      ),
    ).toThrow("invalid graphic")
  })

  it.each([
    { id: "x", type: "container", children: null },
    { id: "x", type: "html", html: null },
    { id: "x", type: "code", source: null },
    { id: "x", type: "execute", source: "command" },
    { type: "html", html: "text" },
  ])("rejects malformed block %j", (block) => {
    expect(() => validateManifest(manifest(undefined, { blocks: [block] }))).toThrow()
  })

  it("bounds recursive depth and total block count", () => {
    let nested = { id: "leaf", type: "html", html: "text" }
    for (let i = 0; i < 42; i++)
      nested = { id: `group-${i}`, type: "container", children: [nested] }
    expect(() => validateManifest(manifest(undefined, { blocks: [nested] }))).toThrow("too complex")
    expect(() =>
      validateManifest(
        manifest(undefined, {
          blocks: Array.from({ length: 1001 }, (_, i) => ({
            id: `b-${i}`,
            type: "code",
            source: "x",
          })),
        }),
      ),
    ).toThrow("too complex")
  })

  it.each([
    ["https://real-site.test/link/0", { kind: "external", url: "https://example.test" }],
    ["https://herdr-markdown.invalid/link/0", { kind: "external", url: "javascript:alert(1)" }],
    ["https://herdr-markdown.invalid/link/0", { kind: "external", url: "file:///etc/passwd" }],
    ["https://herdr-markdown.invalid/link/0", { kind: "local", file: "/workspace/a.md" }],
    ["https://herdr-markdown.invalid/link/0", { kind: "unknown" }],
  ])("rejects unsafe navigation token %s with %j", (url, target) => {
    expect(() => validateManifest(manifest(undefined, { links: { [url]: target } }))).toThrow()
  })

  it.each([
    { file: "notes.md" },
    { root: "workspace" },
    { file: "/outside/notes.md" },
    { file: "/workspace/../outside.md" },
  ])("rejects manifest document paths %j", (change) => {
    expect(() => validateManifest(manifest(undefined, change))).toThrow()
  })

  it.each(["relative.md", "/outside/a.md", "/workspace/../outside.md"])(
    "rejects local navigation path %s outside its workspace",
    (file) => {
      expect(() =>
        validateManifest(
          manifest(undefined, {
            links: {
              "https://herdr-markdown.invalid/link/0": { kind: "local", root: entry.root, file },
            },
          }),
        ),
      ).toThrow()
    },
  )
})

describe("reader session lifecycle", () => {
  it("loads a document, renews its current lease, and releases on idempotent close", async () => {
    const { io, session } = setup()
    const options = { width: 800 }
    expect(await session.refresh(options)).toBe(true)
    expect(io.request).toHaveBeenCalledExactlyOnceWith(entry, options)
    expect(session.busy).toBe(false)
    expect(session.error).toBe("")
    expect(session.manifest.source).toBe("# Good")
    const current = session.current
    await session.heartbeat()
    expect(io.renew).toHaveBeenCalledExactlyOnceWith(current, [])
    await session.close()
    await session.close()
    expect(io.release).toHaveBeenCalledExactlyOnceWith(current)
    await session.heartbeat()
    expect(await session.refresh(options)).toBe(false)
    expect(io.request).toHaveBeenCalledTimes(1)
    expect(io.renew).toHaveBeenCalledTimes(1)
  })

  it("retains the exact current manifest and view for the same signature", async () => {
    const { io, session } = setup()
    await session.refresh({})
    const previous = session.manifest
    const current = session.current
    expect(await session.refresh({ width: 900 })).toBe(false)
    expect(session.manifest).toBe(previous)
    expect(session.current).toBe(current)
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0002" })
    await session.close()
  })

  it("releases the old current request only after a replacement is accepted", async () => {
    const { io, session } = setup()
    await session.refresh({})
    const old = session.current
    const pending = deferred()
    io.render.mockReturnValueOnce(pending.promise)
    const refresh = session.refresh({})
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledTimes(2))
    expect(io.release).not.toHaveBeenCalled()
    pending.resolve(manifest("reader-job-0002", { signature: "signature-2" }))
    expect(await refresh).toBe(true)
    expect(io.release).toHaveBeenCalledExactlyOnceWith(old)
    expect(session.manifest.signature).toBe("signature-2")
    await session.close()
  })

  it("retains the last good document and reports a later failure without losing its lease", async () => {
    const { io, session } = setup()
    await session.refresh({})
    const previous = session.manifest
    const current = session.current
    io.render.mockRejectedValueOnce(new Error("renderer failed"))
    expect(await session.refresh({})).toBe(false)
    expect(session.manifest).toBe(previous)
    expect(session.current).toBe(current)
    expect(session.error).toBe("renderer failed")
    expect(session.busy).toBe(false)
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0002" })
    await session.close()
  })

  it("retains the last good document when asynchronous request creation fails", async () => {
    const { io, session } = setup()
    await session.refresh({})
    const previous = session.manifest
    io.request.mockRejectedValueOnce(new Error("cannot create request"))
    expect(await session.refresh({})).toBe(false)
    expect(session.manifest).toBe(previous)
    expect(session.error).toBe("cannot create request")
    expect(io.release).not.toHaveBeenCalled()
    await session.close()
  })

  it("rejects another reader's job and releases the failed request", async () => {
    const { io, session } = setup()
    io.render.mockResolvedValueOnce(manifest("different-reader-1234"))
    expect(await session.refresh({})).toBe(false)
    expect(session.manifest).toBeNull()
    expect(session.error).toMatch(/another reader/)
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0001" })
  })

  it("bounds error text and ignores renewal or release cleanup failures", async () => {
    const { io, session } = setup()
    await session.refresh({})
    io.renew.mockRejectedValueOnce(new Error("lease failed"))
    await expect(session.heartbeat()).resolves.toBeUndefined()
    io.render.mockRejectedValueOnce(new Error("x".repeat(3000)))
    io.release.mockRejectedValue(new Error("release failed"))
    expect(await session.refresh({})).toBe(false)
    expect(session.error).toHaveLength(2000)
    await expect(session.close()).resolves.toBeUndefined()
  })
})

describe("stale asynchronous results", () => {
  it("does not cancel the displayed current job while releasing an older lease", async () => {
    const { io, session } = setup()
    await session.refresh({})
    const cleanup = deferred()
    io.release.mockImplementationOnce(() => cleanup.promise)
    io.render.mockResolvedValueOnce(manifest("reader-job-0002", { signature: "replacement" }))
    const replacing = session.refresh({})
    await vi.waitFor(() => expect(session.manifest.signature).toBe("replacement"))
    expect(session.pending).toBeNull()
    io.render.mockRejectedValueOnce(new Error("next render failed"))
    expect(await session.refresh({})).toBe(false)
    expect(io.cancel).not.toHaveBeenCalled()
    expect(session.current.job).toBe("reader-job-0002")
    expect(session.manifest.signature).toBe("replacement")
    cleanup.resolve()
    await replacing
    await session.close()
  })

  it("cancels an old render and discards its late successful result", async () => {
    const { io, session } = setup()
    const first = deferred()
    io.render.mockReturnValueOnce(first.promise)
    const oldRefresh = session.refresh({ width: 800 })
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledOnce())
    expect(await session.refresh({ width: 900 })).toBe(true)
    const accepted = session.manifest
    expect(io.cancel).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0001" })
    first.resolve(manifest("reader-job-0001", { signature: "stale" }))
    expect(await oldRefresh).toBe(false)
    expect(session.manifest).toBe(accepted)
    expect(session.error).toBe("")
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0001" })
    await session.close()
  })

  it("does not let an old render failure replace the current error or busy state", async () => {
    const { io, session } = setup()
    const old = deferred()
    const current = deferred()
    io.render.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = session.refresh({})
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledOnce())
    const second = session.refresh({})
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledTimes(2))
    old.reject(new Error("stale failure"))
    expect(await first).toBe(false)
    expect(session.busy).toBe(true)
    expect(session.error).toBe("")
    current.resolve(manifest("reader-job-0002"))
    expect(await second).toBe(true)
    expect(session.busy).toBe(false)
    await session.close()
  })

  it("releases a request that finishes creation after a newer refresh without rendering it", async () => {
    const { io, session } = setup()
    const creation = deferred()
    io.request.mockReturnValueOnce(creation.promise)
    const old = session.refresh({})
    expect(await session.refresh({})).toBe(true)
    const accepted = session.manifest
    creation.resolve({ job: "late-creation-1234" })
    expect(await old).toBe(false)
    expect(io.render).toHaveBeenCalledTimes(1)
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "late-creation-1234" })
    expect(session.manifest).toBe(accepted)
    await session.close()
  })

  it("releases a request created after close and never starts its renderer", async () => {
    const { io, session } = setup()
    const creation = deferred()
    io.request.mockReturnValueOnce(creation.promise)
    const refresh = session.refresh({})
    await session.close()
    await session.close()
    creation.resolve({ job: "late-creation-1234" })
    expect(await refresh).toBe(false)
    expect(io.render).not.toHaveBeenCalled()
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "late-creation-1234" })
    expect(session.manifest).toBeNull()
  })

  it("cancels pending work once on close and releases its eventual result", async () => {
    const { io, session } = setup()
    const rendered = deferred()
    io.render.mockReturnValueOnce(rendered.promise)
    const refresh = session.refresh({})
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledOnce())
    await session.close()
    await session.close()
    expect(io.cancel).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0001" })
    rendered.resolve(manifest())
    expect(await refresh).toBe(false)
    expect(io.release).toHaveBeenCalledExactlyOnceWith({ job: "reader-job-0001" })
    expect(session.manifest).toBeNull()
  })
})
