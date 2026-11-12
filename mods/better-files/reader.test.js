import { run } from "herdr"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { markdownEntry, markdownRoot } from "./markdown.js"

const ui = vi.hoisted(() => {
  const ids = new Set()
  const text = []
  const element = () => {
    const node = new Proxy(
      {},
      {
        get(_target, key) {
          return (...args) => {
            if (key === "id") ids.add(args[0])
            if (key === "child" && typeof args[0] === "string") text.push(args[0])
            if (key === "when" && args[0]) args[1](node)
            return node
          }
        },
      },
    )
    return node
  }
  return { ids, text, element }
})

vi.mock("gpui-kit", () => ({ View: class {}, div: ui.element, image: ui.element }))
vi.mock("gpui-base", () => ({
  Button: { new: (id) => ui.element().id(id) },
  Editor: { new: ui.element },
  EditorState: { new: vi.fn() },
  ScrollHandle: { new: () => ({ release: vi.fn(), scroll_to_item: vi.fn() }) },
  Scrollbar: { vertical: ui.element },
  TextView: { html: (id, html) => ui.element().id(id).child(html) },
  h_flex: ui.element,
  v_flex: ui.element,
}))
vi.mock("herdr", () => ({
  closeOverlay: vi.fn(),
  nextCommand: vi.fn(),
  props: () => ({}),
  run: vi.fn(),
  settings: () => ({ dark: false }),
  theme: () => ({}),
  watchFolder: vi.fn(),
  window: () => ({ platform: "windows" }),
}))
vi.mock("./reader/runtime.js", () => ({ createIO: () => ({}) }))

import Reader from "./reader/main.js"

function open(entry) {
  const view = new Reader()
  const cx = {
    focus_handle: () => ({ focus: vi.fn(), release: vi.fn() }),
    notify: vi.fn(),
    spawn: vi.fn(),
    timer: { every: vi.fn(), after: vi.fn(() => ({ cancel: vi.fn() })) },
  }
  view.refresh = vi.fn(() => {
    view.session.busy = true
  })
  view.init(entry, cx)
  return { view, cx }
}

function noPicker() {
  for (const id of [
    "reader-open",
    "reader-root-input",
    "reader-file-input",
    "reader-open-submit",
  ]) {
    expect(ui.ids.has(id)).toBe(false)
  }
  expect(ui.text).not.toContain("Open local Markdown")
  expect(ui.text).not.toContain("Workspace root")
  expect(ui.text).not.toContain("Open file")
}

beforeEach(() => {
  vi.clearAllMocks()
  ui.ids.clear()
  ui.text.length = 0
})

describe("direct embedded reader", () => {
  it("starts loading the selected Markdown file without file or root input", () => {
    const cwd = "C:\\work\\project"
    const entry = markdownEntry("AGENTS.md", {
      cwd,
      root: markdownRoot(cwd, "C:\\profile\\herdr-app"),
      on: null,
      space: "space",
    })
    const { view, cx } = open(entry)
    expect(view.session.entry).toEqual(entry)
    expect(view.refresh).toHaveBeenCalledOnce()
    view.render(cx)
    expect(ui.text).toContain("Reading Markdown…")
    noPicker()
  })

  it("shows rendered content directly when the document is ready", () => {
    const { view, cx } = open({ file: "/project/README.md", root: "/project", on: null })
    view.session.busy = false
    view.session.manifest = {
      file: "/project/README.md",
      source: "# Ready",
      warnings: [],
      blocks: [{ id: "ready", type: "html", html: "<h1>Ready</h1>" }],
    }
    view.render(cx)
    expect(ui.text).toContain("<h1>Ready</h1>")
    noPicker()
  })

  it.each([
    {},
    { file: "/project/README.md", root: "/other", on: null },
    { file: "/project/README.md", root: "/project", on: "remote" },
  ])("shows an error, never the setup form, for invalid props: %j", (entry) => {
    const { view, cx } = open(entry)
    expect(view.session).toBeUndefined()
    expect(view.error).not.toBe("")
    view.render(cx)
    expect(ui.text).toContain("Cannot open this Markdown file. Go back to Files and try again.")
    noPicker()
  })
})

function linkFixture(target) {
  const { view, cx } = open({ file: "/project/README.md", root: "/project", on: null })
  const url = "https://herdr-markdown.invalid/link/0"
  view.session.manifest = {
    file: "/project/README.md",
    root: "/project",
    anchors: { section: 3 },
    links: { [url]: target },
  }
  view.refresh.mockClear()
  cx.spawn.mockClear()
  return { view, cx, url }
}

describe("embedded document links", () => {
  const local = { kind: "local", file: "/project/guide.md", fragment: "details" }

  it("replaces the session in this view only after the old session closes", async () => {
    const { view, cx, url } = linkFixture(local)
    const previous = view.session
    let release
    previous.close = vi.fn(() => new Promise((resolve) => (release = resolve)))
    const editor = { release: vi.fn() }
    view.editors.set("old", editor)
    view.sources.add("old")
    view.zoom.set("old", 2)
    view.raw = true
    view.link(url, cx)
    expect(view.session).not.toBe(previous)
    expect(view.session.entry).toEqual({ file: local.file, root: "/project", on: null })
    expect(view.initialFragment).toBe("details")
    expect(editor.release).toHaveBeenCalledOnce()
    expect(view.sources.size).toBe(0)
    expect(view.zoom.size).toBe(0)
    expect(view.raw).toBe(false)
    expect(view.refresh).not.toHaveBeenCalled()
    expect(previous.close).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
    const transition = cx.spawn.mock.calls[0][0](cx)
    release()
    await transition
    expect(view.refresh).toHaveBeenCalledExactlyOnceWith(cx)
    view.render(cx)
    noPicker()
  })

  it("uses the top of a linked document when no fragment is supplied", async () => {
    const { view, cx, url } = linkFixture({ ...local, fragment: "" })
    view.link(url, cx)
    await cx.spawn.mock.calls[0][0](cx)
    expect(view.initialFragment).toBe("")
    expect(view.refresh).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    { kind: "fragment", fragment: "section" },
    { kind: "local", file: "/project/README.md", fragment: "section" },
  ])("keeps same-document fragments in the current session: %j", (target) => {
    const { view, cx, url } = linkFixture(target)
    const session = view.session
    view.link(url, cx)
    expect(view.session).toBe(session)
    expect(view.scroll.scroll_to_item).toHaveBeenCalledWith(3)
    expect(view.refresh).not.toHaveBeenCalled()
    expect(cx.spawn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("waits for navigation cleanup on close and does not refresh a closed view", async () => {
    const { view, cx, url } = linkFixture(local)
    let release
    view.session.close = vi.fn(() => new Promise((resolve) => (release = resolve)))
    view.link(url, cx)
    const transition = cx.spawn.mock.calls[0][0](cx)
    let closed = false
    const closing = view.close().then(() => (closed = true))
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await Promise.all([transition, closing])
    expect(closed).toBe(true)
    expect(view.refresh).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("keeps scheduled refresh work behind pending navigation cleanup", async () => {
    const { view, cx, url } = linkFixture(local)
    let release
    view.session.close = vi.fn(() => new Promise((resolve) => (release = resolve)))
    view.link(url, cx)
    view.session.refresh = vi.fn().mockResolvedValue(false)
    view.watch = vi.fn()
    Reader.prototype.refresh.call(view, cx)
    const refresh = cx.spawn.mock.calls[1][0](cx)
    await Promise.resolve()
    expect(view.session.refresh).not.toHaveBeenCalled()
    release()
    await refresh
    expect(view.session.refresh).toHaveBeenCalledOnce()
  })

  it("reports navigation cleanup failure without opening a tab or showing the form", async () => {
    const { view, cx, url } = linkFixture(local)
    view.session.close = vi.fn().mockRejectedValue(new Error("Cleanup failed"))
    view.link(url, cx)
    await cx.spawn.mock.calls[0][0](cx)
    expect(view.error).toBe("Cleanup failed")
    expect(view.session.busy).toBe(false)
    expect(view.refresh).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    view.render(cx)
    noPicker()
    await expect(view.close()).resolves.toBeUndefined()
  })

  it("ignores an old render and applies the linked fragment only to the new document", async () => {
    const deferred = () => {
      let resolve
      const promise = new Promise((done) => (resolve = done))
      return { promise, resolve }
    }
    const oldRender = deferred()
    const newRender = deferred()
    const cancellation = deferred()
    const events = []
    const { view, cx, url } = linkFixture(local)
    const previous = view.session
    const io = {
      request: vi.fn(async (entry) => {
        events.push(`request:${entry.file}`)
        return { job: entry.file === local.file ? "new-render-job" : "old-render-job" }
      }),
      render: vi.fn((request) =>
        request.job === "old-render-job" ? oldRender.promise : newRender.promise,
      ),
      cancel: vi.fn(async () => {
        events.push("cancel")
        await cancellation.promise
        events.push("cancel-complete")
      }),
      release: vi.fn().mockResolvedValue(undefined),
    }
    previous.io = io
    view.io = io
    view.watch = vi.fn()
    view.prepareEditors = vi.fn()
    view.refresh = Reader.prototype.refresh
    const manifest = (file, job) => ({
      version: 1,
      file,
      root: "/project",
      job,
      signature: job,
      source: "# Details",
      blocks: [{ id: "details", type: "html", html: "<h1>Details</h1>" }],
      assets: [],
      links: {},
      anchors: { details: 4 },
    })
    view.refresh(cx)
    const oldWork = cx.spawn.mock.calls[0][0](cx)
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledOnce())
    view.link(url, cx)
    const transition = cx.spawn.mock.calls[1][0](cx)
    oldRender.resolve(manifest(previous.entry.file, "old-render-job"))
    await oldWork
    expect(view.prepareEditors).not.toHaveBeenCalled()
    expect(view.initialFragment).toBe("details")
    expect(view.scroll.scroll_to_item).not.toHaveBeenCalled()
    expect(io.request).toHaveBeenCalledOnce()
    cancellation.resolve()
    await transition
    const newWork = cx.spawn.mock.calls[2][0](cx)
    await vi.waitFor(() => expect(io.render).toHaveBeenCalledTimes(2))
    expect(events.indexOf("cancel-complete")).toBeLessThan(events.indexOf(`request:${local.file}`))
    const nextManifest = manifest(local.file, "new-render-job")
    newRender.resolve(nextManifest)
    await newWork
    expect(view.prepareEditors).toHaveBeenCalledExactlyOnceWith(nextManifest)
    expect(view.scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(4)
    expect(view.initialFragment).toBeNull()
    expect(run).not.toHaveBeenCalled()
    await view.close()
  })

  it("opens explicit external links only through the existing external handler", async () => {
    const { view, cx, url } = linkFixture({ kind: "external", url: "https://example.com" })
    const session = view.session
    view.io.openExternal = vi.fn().mockResolvedValue(undefined)
    view.link(url, cx)
    await cx.spawn.mock.calls[0][0](cx)
    expect(view.io.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com")
    expect(view.session).toBe(session)
    expect(run).not.toHaveBeenCalled()
  })
})
