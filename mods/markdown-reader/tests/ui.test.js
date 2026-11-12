import { beforeEach, describe, expect, it, vi } from "vitest"

const ui = vi.hoisted(() => {
  const nodes = new Map()
  const states = []
  const inputs = []
  const state = { rendering: false }
  const element = () => {
    const node = { items: [], handlers: {}, props: {}, used: false }
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key]
        return (...args) => {
          if (node.used) throw new Error("Native elements are single-use values")
          const add = (child) => {
            if (typeof child === "object" && child !== null && "used" in child) {
              if (child.used) throw new Error("Native element already has a parent")
              child.used = true
            }
            node.items.push(child)
          }
          if (key === "id") nodes.set(args[0], proxy)
          else if (key === "child") add(args[0])
          else if (key === "children") args[0].forEach(add)
          else if (key === "when") {
            if (args[0]) args[1](proxy)
          } else if (key.startsWith("on_")) node.handlers[key] = args.at(-1)
          else node.props[key] = args[0]
          return proxy
        }
      },
    })
    return proxy
  }
  return { nodes, states, inputs, state, element }
})
vi.mock("gpui-kit", () => ({
  View: class {},
  div: ui.element,
  image: (path) => ui.element().asset(path),
}))
vi.mock("gpui-base", () => ({
  Button: { new: (id) => ui.element().id(id) },
  EditorState: {
    new: (options) => {
      if (ui.state.rendering) throw new Error("EditorState.new during render")
      const state = { options, release: vi.fn() }
      ui.states.push(state)
      return state
    },
  },
  InputState: {
    new: (options) => {
      if (ui.state.rendering) throw new Error("InputState.new during render")
      let value = options.value
      const input = {
        value: () => value,
        set_value: (next) => {
          value = next
        },
        handlers: {},
        on: (event, handler) => {
          input.handlers[event] = handler
        },
        focus: vi.fn(),
        release: vi.fn(),
      }
      ui.inputs.push(input)
      return input
    },
  },
  Input: { new: (state) => ui.element().input(state) },
  Editor: { new: (state) => ui.element().editor(state) },
  TextView: { html: (id, html) => ui.element().id(id).html(html) },
  ScrollHandle: { new: () => ({ release: vi.fn(), scroll_to_item: vi.fn() }) },
  Scrollbar: { vertical: ui.element },
  h_flex: ui.element,
  v_flex: ui.element,
}))
vi.mock("herdr", () => ({
  appHome: () => "/profile",
  exec: vi.fn(),
  window: vi.fn(() => ({ platform: "macos" })),
  props: () => ({}),
  closeOverlay: vi.fn(),
  nextCommand: () => new Promise(() => {}),
  run: vi.fn(),
  settings: () => ({ dark: false }),
  theme: vi.fn(),
  watchFolder: vi.fn(() => new Promise(() => {})),
}))

import { closeOverlay, run, theme, watchFolder, window } from "herdr"
import Reader from "../main.js"

const asset = `data/markdown-reader/assets/${"a".repeat(64)}.svg`
const manifest = () => ({
  version: 1,
  job: "reader-job-0001",
  file: "/workspace/notes.md",
  root: "/workspace",
  source: "# Notes\n\n$x$",
  signature: "first",
  blocks: [
    { id: "p1", type: "html", html: "<h1>Notes</h1>" },
    {
      id: "q1",
      type: "container",
      kind: "blockquote",
      children: [{ id: "code1", type: "code", source: "const x = 1", language: "js" }],
    },
    { id: "g1", type: "graphic", kind: "math", source: "x^2", asset, width: 100, height: 30 },
    { id: "e1", type: "error", kind: "mermaid", source: "invalid", error: "Syntax error" },
  ],
  links: {
    "https://herdr-markdown.invalid/link/0": { kind: "fragment", fragment: "notes" },
    "https://herdr-markdown.invalid/link/1": {
      kind: "local",
      file: "/workspace/other.md",
      root: "/workspace",
      fragment: "heading",
    },
    "https://herdr-markdown.invalid/link/2": { kind: "external", url: "https://example.com/" },
  },
  anchors: { notes: 0 },
  warnings: ["Inline math shown as source"],
  assets: [asset],
  dependencies: ["/workspace/notes.md"],
})
function context() {
  const tasks = []
  const timers = []
  const cx = {
    tasks,
    timers,
    notify: vi.fn(),
    write_to_clipboard: vi.fn(),
    focus_handle: () => ({ focus: vi.fn(), release: vi.fn() }),
    spawn(body) {
      const task = Promise.resolve().then(() => body(cx))
      tasks.push(task)
      task.catch(() => {})
      return { cancel: vi.fn() }
    },
    timer: {
      every: vi.fn(),
      after: (_ms, body) => {
        const timer = { cancel: vi.fn(), fire: () => body(cx) }
        timers.push(timer)
        return timer
      },
    },
  }
  return cx
}
async function ready(
  entry = { file: "/workspace/notes.md", root: "/workspace", on: null },
  configure = (_io) => {},
) {
  const data = manifest()
  if (entry.file) {
    data.file = entry.file
    data.dependencies = [entry.file]
  }
  const io = {
    request: vi.fn(async () => ({ job: data.job, path: "/request" })),
    render: vi.fn(async () => data),
    release: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    renew: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
  }
  configure(io)
  const view = new Reader()
  view.createIO = () => io
  const cx = context()
  view.init(entry, cx)
  if (view.session) await cx.tasks[0]
  return { view, cx, io, data }
}
function render(view, cx) {
  ui.nodes.clear()
  ui.state.rendering = true
  try {
    return view.render(cx)
  } finally {
    ui.state.rendering = false
  }
}
function click(id, cx) {
  ui.nodes.get(id).handlers.on_click({}, cx)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.mockReturnValue({ platform: "macos" })
  watchFolder.mockReset().mockImplementation(() => new Promise(() => {}))
  ui.nodes.clear()
  ui.states.length = 0
  ui.inputs.length = 0
  ui.state.rendering = false
  theme.mockReturnValue({
    foreground: "#222222",
    background: "#ffffff",
    accent: "#4466bb",
    border: "#aaaaaa",
    surface: "#eeeeee",
    muted: "#666666",
  })
})

describe("native reader lifecycle", () => {
  it("prepares nested code/error states outside render and uses native elements only once", async () => {
    const { view, cx } = await ready()
    expect(ui.states).toHaveLength(2)
    expect(() => render(view, cx)).not.toThrow()
    expect(() => render(view, cx)).not.toThrow()
    expect(ui.states).toHaveLength(2)
  })
  it("prepares raw and graphic source states in click handlers", async () => {
    const { view, cx } = await ready()
    render(view, cx)
    click("source-g1", cx)
    render(view, cx)
    expect(ui.states.at(-1).options.value).toBe("x^2")
    click("reader-source", cx)
    render(view, cx)
    expect(view.raw).toBe(true)
    expect(ui.states.at(-1).options.value).toContain("# Notes")
  })
  it("keeps error source visible without a nonfunctional Source/Render toggle", async () => {
    const { view, cx } = await ready()
    render(view, cx)
    expect(ui.nodes.has("source-e1")).toBe(false)
    expect(view.editors.get("e1").options.value).toBe("invalid")
    click("copy-e1", cx)
    expect(cx.write_to_clipboard).toHaveBeenCalledWith("invalid")
    click("source-g1", cx)
    render(view, cx)
    expect(ui.nodes.get("source-g1").items).toContain("Render")
    click("source-g1", cx)
    render(view, cx)
    expect(ui.nodes.get("source-g1").items).toContain("Source")
    expect(ui.nodes.has("source-e1")).toBe(false)
  })

  it("copies source only after an explicit click", async () => {
    const { view, cx } = await ready()
    render(view, cx)
    expect(cx.write_to_clipboard).not.toHaveBeenCalled()
    click("copy-g1", cx)
    expect(cx.write_to_clipboard).toHaveBeenCalledWith("x^2")
  })
  it("zooms and resets images without allocating editor state during render", async () => {
    const { view, cx } = await ready()
    render(view, cx)
    click("more-g1", cx)
    expect(view.zoom.get("g1")).toBe(1.25)
    render(view, cx)
    click("fit-g1", cx)
    expect(view.zoom.has("g1")).toBe(false)
    render(view, cx)
    click("less-g1", cx)
    expect(view.zoom.get("g1")).toBe(0.8)
  })
  it("keeps scroll handles and last good content after a refresh failure", async () => {
    const { view, cx, io } = await ready()
    const scroll = view.scroll
    const previous = view.session.manifest
    io.render.mockRejectedValueOnce(new Error("Read failed"))
    view.refresh(cx)
    await cx.tasks.at(-1)
    expect(view.session.manifest).toBe(previous)
    expect(view.scroll).toBe(scroll)
    expect(view.session.error).toBe("Read failed")
    expect(() => render(view, cx)).not.toThrow()
  })
  it("debounces size and theme changes instead of creating a redraw loop", async () => {
    const { view, cx } = await ready()
    const root = render(view, cx)
    root.handlers.on_size_change({ width: 500 }, cx)
    const timer = cx.timers.at(-1)
    render(view, cx)
    render(view, cx)
    expect(timer.cancel).not.toHaveBeenCalled()
    expect(view.width).toBe(400)
    root.handlers.on_size_change({ width: 4000 }, cx)
    expect(view.width).toBe(2048)
  })
  it("releases states, handles and pending timer on close", async () => {
    const { view, cx } = await ready()
    view.schedule(cx)
    const states = [...ui.states]
    await view.close()
    await view.close()
    expect(states.every((state) => state.release.mock.calls.length === 1)).toBe(true)
    expect(view.scroll.release).toHaveBeenCalledOnce()
    expect(view.focus.release).toHaveBeenCalledOnce()
    expect(cx.timers.at(-1).cancel).toHaveBeenCalledOnce()
  })
  it("rejects remote props before any helper request", async () => {
    const { view, cx, io } = await ready({
      file: "/workspace/notes.md",
      root: "/workspace",
      on: "remote",
    })
    expect(view.error).toMatch(/remote/i)
    expect(io.request).not.toHaveBeenCalled()
    expect(() => render(view, cx)).not.toThrow()
  })
  it("renders a useful no-props entry without invoking helpers", async () => {
    const { view, cx, io } = await ready({})
    expect(view.error).toBe("")
    expect(io.request).not.toHaveBeenCalled()
    expect(() => render(view, cx)).not.toThrow()
    expect(ui.nodes.has("reader-file-input")).toBe(true)
    expect(ui.nodes.has("reader-root-input")).toBe(true)
    expect(view.rootInput.focus).toHaveBeenCalledOnce()
    view.rootInput.set_value("/workspace")
    view.fileInput.set_value("/workspace/notes.md")
    click("reader-open-submit", cx)
    await cx.tasks.at(-1)
    expect(view.opening).toBe(false)
    expect(view.session.manifest.file).toBe("/workspace/notes.md")
    await view.close()
    expect(ui.inputs.every((input) => input.release.mock.calls.length === 1)).toBe(true)
  })
  it("validates explicit paths on submit and never expands the root", async () => {
    const { view, cx, io } = await ready({})
    view.rootInput.set_value("/workspace")
    view.fileInput.set_value("/outside/notes.md")
    view.fileInput.handlers.submit({}, cx)
    expect(view.error).toMatch(/inside the workspace/)
    expect(view.opening).toBe(true)
    expect(io.request).not.toHaveBeenCalled()
    await view.close()
  })
  it("does not offer a local open fallback for a remote identity", async () => {
    const { view, cx, io } = await ready({
      file: "/workspace/notes.md",
      root: "/workspace",
      on: "remote",
    })
    render(view, cx)
    expect(ui.nodes.has("reader-open-submit")).toBe(false)
    view.open(cx)
    expect(io.request).not.toHaveBeenCalled()
    await view.close()
  })
  it("prepares replacement content without waiting for old lease cleanup", async () => {
    const { view, cx, io, data } = await ready()
    let finish
    io.release.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    io.render.mockResolvedValueOnce({
      ...data,
      signature: "new-code",
      blocks: [{ id: "new-code", type: "code", source: "replacement" }],
    })
    view.refresh(cx)
    const work = cx.tasks.at(-1)
    try {
      await vi.waitFor(() => expect(view.editors.has("new-code")).toBe(true))
      expect(() => render(view, cx)).not.toThrow()
    } finally {
      finish?.()
      await work
      await view.close()
    }
  })
  it("retains unchanged code editor states and releases changed or removed states", async () => {
    const { view, cx, io, data } = await ready()
    const code = view.editors.get("code1")
    const error = view.editors.get("e1")
    io.render.mockResolvedValueOnce({ ...data, signature: "image-change" })
    view.width = 640
    view.refresh(cx)
    await cx.tasks.at(-1)
    expect(view.editors.get("code1")).toBe(code)
    expect(code.release).not.toHaveBeenCalled()
    io.render.mockResolvedValueOnce({
      ...data,
      signature: "code-change",
      blocks: [{ id: "code1", type: "code", source: "changed" }],
    })
    view.refresh(cx)
    await cx.tasks.at(-1)
    expect(code.release).toHaveBeenCalledOnce()
    expect(error.release).toHaveBeenCalledOnce()
    expect(view.editors.get("code1").options.value).toBe("changed")
    await view.close()
  })
  it("ignores old view completions and watcher events after opening another workspace", async () => {
    let finish
    let report
    watchFolder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          report = resolve
        }),
    )
    const { view, cx, io, data } = await ready()
    const oldSession = view.session
    io.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    view.refresh(cx)
    const old = cx.tasks.at(-1)
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    view.rootInput.set_value("/other")
    view.fileInput.set_value("/other/new.md")
    io.render.mockResolvedValueOnce({
      ...data,
      root: "/other",
      file: "/other/new.md",
      dependencies: ["/other/new.md"],
      links: {},
      signature: "new-file",
    })
    view.open(cx)
    await cx.tasks.at(-1)
    expect(oldSession.closed).toBe(true)
    expect(view.session.manifest.file).toBe("/other/new.md")
    const prepare = vi.spyOn(view, "prepareEditors")
    finish({ ...data, signature: "late-old-result" })
    await old
    report(["/workspace/notes.md"])
    await Promise.resolve()
    expect(prepare).not.toHaveBeenCalled()
    expect(cx.timers).toHaveLength(0)
    expect(view.watching).toBe(true)
    expect(watchFolder).toHaveBeenCalledWith("/other")
    await view.close()
  })
  it("routes local links and fragments, never opens unknown links", async () => {
    const { view, cx, io } = await ready()
    view.link("https://herdr-markdown.invalid/link/0", cx)
    expect(view.scroll.scroll_to_item).toHaveBeenCalledWith(0)
    view.link("https://herdr-markdown.invalid/link/1", cx)
    expect(run).toHaveBeenCalledWith(
      "tab.new",
      expect.objectContaining({
        mod: "markdown-reader",
        props: { file: "/workspace/other.md", root: "/workspace", on: null, fragment: "heading" },
      }),
    )
    view.link("javascript:alert(1)", cx)
    expect(io.openExternal).not.toHaveBeenCalled()
    expect(view.error).toMatch(/blocked/)
  })
  it("uses the entry fragment once and preserves position on later changed refreshes", async () => {
    const entry = { file: "/workspace/notes.md", root: "/workspace", fragment: "notes" }
    const { view, cx, io, data } = await ready(entry)
    const scroll = view.scroll
    expect(scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(0)
    scroll.scroll_to_item.mockClear()
    for (const signature of ["file-edit", "image-edit", "width-change", "reload"]) {
      io.render.mockResolvedValueOnce({ ...data, signature })
      view.refresh(cx)
      await cx.tasks.at(-1)
      expect(scroll.scroll_to_item).not.toHaveBeenCalled()
      expect(view.scroll).toBe(scroll)
    }
    expect(entry.fragment).toBe("notes")
    await view.close()
  })
  it("keeps the entry fragment after a failed initial load", async () => {
    const { view, cx } = await ready(
      { file: "/workspace/notes.md", root: "/workspace", fragment: "notes" },
      (io) => io.render.mockRejectedValueOnce(new Error("Read failed")),
    )
    expect(view.session.manifest).toBeNull()
    expect(view.initialFragment).toBe("notes")
    expect(view.scroll.scroll_to_item).not.toHaveBeenCalled()
    view.refresh(cx)
    await cx.tasks.at(-1)
    expect(view.initialFragment).toBeNull()
    expect(view.scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(0)
    await view.close()
  })
  it.each(["fragment", "local"])(
    "routes an empty %s fragment to the document start",
    async (kind) => {
      const { view, cx, data } = await ready()
      data.links["https://herdr-markdown.invalid/link/3"] = {
        kind,
        file: data.file,
        root: data.root,
        fragment: "",
      }
      view.reveal("missing")
      expect(view.error).toBe("Heading not found: missing")
      view.link("https://herdr-markdown.invalid/link/3", cx)
      expect(view.error).toBe("")
      expect(view.scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(0)
      await view.close()
    },
  )
  it("retains errors for unknown nonempty headings and clears them after valid navigation", async () => {
    const { view } = await ready()
    view.reveal("missing")
    expect(view.error).toBe("Heading not found: missing")
    expect(view.scroll.scroll_to_item).not.toHaveBeenCalled()
    view.reveal("notes")
    expect(view.error).toBe("")
    expect(view.scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(0)
    await view.close()
  })
  it.each([
    ["/workspace/later/picture.png", true],
    ["/workspace/later", true],
    ["/workspace", true],
    ["/workspace/later-other", false],
    ["/workspace/unrelated.md", false],
  ])("checks dependency and parent watch events for %s", async (path, refresh) => {
    let report
    watchFolder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          report = resolve
        }),
    )
    const { view, cx, data } = await ready()
    data.dependencies.push("/workspace/later/picture.png")
    report([path])
    await Promise.resolve()
    expect(cx.timers.length).toBe(refresh ? 1 : 0)
    await view.close()
  })
  it("watches a missing first-open file and retries it on creation", async () => {
    let report
    watchFolder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          report = resolve
        }),
    )
    const { view, cx, io } = await ready(undefined, (io) =>
      io.render.mockRejectedValueOnce(new Error("File not found")),
    )
    expect(view.session.manifest).toBeNull()
    expect(watchFolder).toHaveBeenCalledWith("/workspace")
    report(["/workspace/notes.md"])
    await Promise.resolve()
    cx.timers.at(-1).fire()
    await cx.tasks.at(-1)
    expect(io.render).toHaveBeenCalledTimes(2)
    expect(view.session.manifest.file).toBe("/workspace/notes.md")
    await view.close()
  })
  it("periodically retries an initial read failure and unresolved local links on macOS", async () => {
    const { view, cx, io, data } = await ready(undefined, (io) =>
      io.render.mockRejectedValueOnce(new Error("Missing root")),
    )
    const tick = cx.timer.every.mock.calls[0][1]
    tick(cx)
    expect(cx.timers).toHaveLength(1)
    io.render.mockResolvedValueOnce({ ...data, unresolvedLinks: true })
    cx.timers[0].fire()
    await cx.tasks.at(-1)
    tick(cx)
    expect(cx.timers).toHaveLength(2)
    await view.close()
  })
  it("polls Linux ignored dependencies even when watchFolder succeeds", async () => {
    window.mockReturnValue({ platform: "linux" })
    const { view, cx, data, io } = await ready({
      file: "/workspace/ignored/notes.md",
      root: "/workspace",
      on: null,
    })
    const [interval, tick] = cx.timer.every.mock.calls[0]
    expect(interval).toBe(10000)
    expect(watchFolder).toHaveBeenCalledWith("/workspace")
    expect(view.watching).toBe(true)
    io.render.mockResolvedValueOnce({ ...data, signature: "ignored-edit" })
    tick(cx)
    cx.timers.at(-1).fire()
    await cx.tasks.at(-1)
    expect(view.session.manifest.signature).toBe("ignored-edit")
    await view.close()
  })
  it("does not cancel active work on a periodic tick or poll after close", async () => {
    window.mockReturnValue({ platform: "linux" })
    const { view, cx } = await ready()
    const tick = cx.timer.every.mock.calls[0][1]
    view.session.busy = true
    tick(cx)
    expect(cx.timers).toHaveLength(0)
    await view.close()
    tick(cx)
    expect(cx.timers).toHaveLength(0)
  })
  it.each([
    ["directory alias", "/workspace/alias/later.png", "/workspace/images/later.png"],
    ["dangling image alias", "/workspace/alias.png", "/workspace/future/image.png"],
  ])(
    "recovers missing images through a %s when canonical watch events do not match",
    async (_name, alias, target) => {
      let report
      watchFolder.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            report = resolve
          }),
      )
      const { view, cx, data, io } = await ready()
      data.dependencies = [data.file, alias]
      data.unresolvedImages = true
      report([target])
      await Promise.resolve()
      expect(cx.timers).toHaveLength(0)
      const tick = cx.timer.every.mock.calls[0][1]
      view.session.busy = true
      tick(cx)
      expect(cx.timers).toHaveLength(0)
      view.session.busy = false
      io.render.mockResolvedValueOnce({
        ...data,
        dependencies: [...data.dependencies, target],
        unresolvedImages: false,
        signature: "image-created",
      })
      tick(cx)
      expect(cx.timers).toHaveLength(1)
      cx.timers[0].fire()
      await cx.tasks.at(-1)
      expect(view.session.manifest.signature).toBe("image-created")
      expect(view.session.manifest.dependencies).toContain(target)
      tick(cx)
      expect(cx.timers).toHaveLength(1)
      await view.close()
    },
  )
  it("does not poll on macOS while watching succeeds", async () => {
    const { view, cx } = await ready()
    cx.timer.every.mock.calls[0][1](cx)
    expect(cx.timers).toHaveLength(0)
    await view.close()
  })
  it("polls after the watcher rejects on any platform", async () => {
    watchFolder.mockRejectedValueOnce(new Error("Watch limit exceeded"))
    const { view, cx } = await ready()
    await Promise.resolve()
    expect(view.fallback).toBe(true)
    cx.timer.every.mock.calls[0][1](cx)
    expect(cx.timers).toHaveLength(1)
    await view.close()
  })
  it("opens external links only through the explicit click path", async () => {
    const { view, cx, io } = await ready()
    render(view, cx)
    expect(io.openExternal).not.toHaveBeenCalled()
    view.link("https://herdr-markdown.invalid/link/2", cx)
    await cx.tasks.at(-1)
    expect(io.openExternal).toHaveBeenCalledWith("https://example.com/")
  })
  it("dismisses only its own overlay with Escape instead of moving another pane", async () => {
    const { view, cx } = await ready({ overlay: "reader-overlay" })
    render(view, cx).handlers.on_key_down({ key: "escape" })
    expect(closeOverlay).toHaveBeenCalledExactlyOnceWith("reader-overlay")
    expect(run).not.toHaveBeenCalled()
    await view.close()
  })
  it("closes only its own overlay when given an overlay prop", async () => {
    const { view, cx } = await ready({
      file: "/workspace/notes.md",
      root: "/workspace",
      on: null,
      overlay: "reader-overlay",
    })
    render(view, cx)
    click("reader-close", cx)
    expect(closeOverlay).toHaveBeenCalledWith("reader-overlay")
  })
})
