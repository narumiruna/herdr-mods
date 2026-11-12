import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ui = vi.hoisted(() => {
  const nodes = new Map()
  const element = () => {
    const node = { handlers: {}, childNodes: [] }
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key]
        return (...args) => {
          if (key === "id") nodes.set(args[0], proxy)
          else if (key === "when" && args[0]) args[1](proxy)
          else if (key === "child") node.childNodes.push(args[0])
          else if (key === "children") node.childNodes.push(...args[0])
          else if (key.startsWith("on_")) node.handlers[key] = args.at(-1)
          return proxy
        }
      },
    })
    return proxy
  }
  return { nodes, element }
})

vi.mock("gpui-kit", () => ({ View: class {}, div: ui.element, svg: ui.element }))
vi.mock("gpui-base", () => ({
  h_flex: ui.element,
  v_flex: ui.element,
  Editor: { new: vi.fn() },
  EditorState: { new: vi.fn() },
}))
vi.mock("herdr", () => ({
  spaces: vi.fn(),
  panes: vi.fn(),
  focused: vi.fn(),
  exec: vi.fn(() => {
    throw new Error("Unexpected command execution")
  }),
  readTextFile: vi.fn(() => {
    throw new Error("Unexpected file read")
  }),
  watchFolder: vi.fn(() => {
    throw new Error("Unexpected folder watch")
  }),
  theme: vi.fn(() => ({})),
  settings: vi.fn(() => ({})),
  window: vi.fn(() => ({ platform: "linux" })),
  run: vi.fn(),
}))
vi.mock("./reader/main.js", async () => {
  const { View } = await import("gpui-kit")
  return {
    default: class extends View {
      init(props, cx) {
        this.props = props
        this.cx = cx
        this.close = vi.fn(async () => {})
      }
    },
  }
})

import { exec, focused, panes, readTextFile, run, spaces, watchFolder } from "herdr"
import Files from "./main.js"
import MarkdownReader from "./reader/main.js"

const captured = () => ({
  key: "original-context",
  cwd: "/workspace/project/subfolder",
  root: "/workspace/project",
  on: null,
  space: "original-space",
})

function fixture(context = captured()) {
  const view = new Files()
  Object.assign(view, {
    context,
    root: context?.cwd,
    on: context?.on,
    entries: new Map(),
    folders: new Set(),
    pending: new Set(),
    saved: new Map(),
    marks: {},
    reader: null,
    closingReaders: new Set(),
    closed: false,
  })
  // Record spawn bodies without running Files I/O. Run only cleanup callbacks explicitly.
  const cx = {
    notify: vi.fn(),
    spawn: vi.fn(),
    new: vi.fn((ViewClass, props) => {
      const child = new ViewClass()
      child.init(props, cx)
      return { release: vi.fn() }
    }),
  }
  view.ownerCx = cx
  return { view, cx }
}

function rows(view, entries, prefix = "") {
  ui.nodes.clear()
  view.entries.set(prefix, entries)
  view.rows(prefix, 0, [], {})
}

function click(path, cx) {
  const node = ui.nodes.get(`file-${path}`)
  expect(node).toBeDefined()
  node.handlers.on_click({}, cx)
}

function expectReader(view, cx, path, props) {
  expect(cx.new).toHaveBeenCalledExactlyOnceWith(expect.any(Function), props)
  expect(view.file).toBe(path)
  expect(view.reader.entity).toBe(cx.new.mock.results[0].value)
  expect(view.reader.view).toBeInstanceOf(MarkdownReader)
  expect(view.reader.view.props).toEqual(props)
  expect(view.reader.view.cx).toBe(cx)
  return view.reader
}

function render(view, cx) {
  // Rendering must not change the captured context or schedule Files I/O.
  vi.spyOn(view, "refresh").mockImplementation(() => {})
  ui.nodes.clear()
  return view.render(cx)
}

function deferClose(reader) {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  reader.view.close.mockReturnValue(promise)
  return resolve
}

beforeEach(() => {
  vi.clearAllMocks()
  ui.nodes.clear()
  spaces.mockReturnValue([
    { id: "unrelated-space", active: true, folder: "/unrelated", machine: null },
  ])
  focused.mockReturnValue({ pane: "unrelated-pane" })
  panes.mockReturnValue([{ pane: "unrelated-pane", cwd: "/unrelated/current" }])
})

afterEach(() => {
  // No tab.new or layout commands may run: Reader stays in the existing Files pane.
  expect(run).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
  expect(readTextFile).not.toHaveBeenCalled()
  expect(watchFolder).not.toHaveBeenCalled()
})

describe("bundled Reader source compatibility", () => {
  it.each(["model.js", "LICENSE"])(
    "keeps reader/%s identical to Markdown Reader after CRLF normalization",
    (file) => {
      const source = (path) =>
        readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
      expect(source(`./reader/${file}`)).toBe(source(`../markdown-reader/${file}`))
    },
  )
})

describe("file row click routing", () => {
  it.each(["Guide.md", "Guide.MD", "Guide.mArKdOwN"])(
    "opens %s in the same Files pane with the captured workspace",
    (name) => {
      const { view, cx } = fixture()
      const show = vi.spyOn(view, "show")
      rows(view, [{ name, dir: false }], "文書 notes")
      click(`文書 notes/${name}`, cx)
      expectReader(view, cx, `文書 notes/${name}`, {
        file: `/workspace/project/subfolder/文書 notes/${name}`,
        root: "/workspace/project",
        on: null,
      })
      expect(show).toHaveBeenCalledExactlyOnceWith(null, cx)
      expect(cx.notify).toHaveBeenCalledOnce()
      expect(cx.spawn).not.toHaveBeenCalled()
    },
  )

  it("keeps the rendered row's original context after the view changes workspace and machine", () => {
    const original = { ...captured(), on: "remote-original" }
    const { view, cx } = fixture(original)
    rows(view, [{ name: "Read Me.MD", dir: false }])
    view.context = { cwd: "C:\\Other", root: "C:\\", space: "new-space", on: null }
    view.root = "C:\\Other"
    view.on = null
    click("Read Me.MD", cx)
    expectReader(view, cx, "Read Me.MD", {
      file: "/workspace/project/subfolder/Read Me.MD",
      root: "/workspace/project",
      on: "remote-original",
    })
  })

  it("keeps invalid captured context invalid after a valid local workspace becomes current", () => {
    const { view, cx } = fixture({ ...captured(), on: undefined })
    const show = vi.spyOn(view, "show")
    rows(view, [{ name: "notes.md", dir: false }])
    view.context = captured()
    click("notes.md", cx)
    expect(view.error).toMatch(/absolute file location and workspace folder/)
    expect(cx.notify).toHaveBeenCalledOnce()
    expect(show).not.toHaveBeenCalled()
    expect(cx.new).not.toHaveBeenCalled()
    expect(cx.spawn).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    null,
    {},
    { ...captured(), root: undefined },
    { ...captured(), space: "" },
    { ...captured(), on: undefined },
  ])(
    "reports missing or invalid context without falling back to a local preview: %j",
    (context) => {
      const { view, cx } = fixture()
      const show = vi.spyOn(view, "show")
      view.openFile("notes.md", cx, context)
      expect(view.error).toMatch(/absolute file location and workspace folder/)
      expect(cx.notify).toHaveBeenCalledOnce()
      expect(show).not.toHaveBeenCalled()
      expect(cx.new).not.toHaveBeenCalled()
      expect(cx.spawn).not.toHaveBeenCalled()
    },
  )

  it.each(["source.js", "picture.png", "notes.md.txt", "README"])(
    "keeps %s on the original show() preview route",
    (name) => {
      const { view, cx } = fixture()
      // Retain the real show() method; spawn records but does not run its read body.
      const show = vi.spyOn(view, "show")
      view.code = { release: vi.fn() }
      const oldCode = view.code
      rows(view, [{ name, dir: false }])
      click(name, cx)
      expect(show).toHaveBeenCalledExactlyOnceWith(name, cx)
      expect(view.file).toBe(name)
      expect(view.code).toBeNull()
      expect(oldCode.release).toHaveBeenCalledOnce()
      expect(cx.spawn).toHaveBeenCalledOnce()
      expect(cx.new).not.toHaveBeenCalled()
    },
  )

  it("uses toggle() rather than Markdown routing for directory names ending in .md", () => {
    const { view, cx } = fixture()
    const toggle = vi.spyOn(view, "toggle")
    const openFile = vi.spyOn(view, "openFile")
    rows(view, [{ name: "folder.md", dir: true }])
    click("folder.md", cx)
    expect(toggle).toHaveBeenCalledExactlyOnceWith("folder.md", cx)
    expect(view.folders.has("folder.md")).toBe(true)
    expect(openFile).not.toHaveBeenCalled()
    expect(cx.new).not.toHaveBeenCalled()
    click("folder.md", cx)
    expect(view.folders.has("folder.md")).toBe(false)
  })
})

describe("workspace context capture", () => {
  it("preserves a focused terminal's remote identity instead of using the active space machine", () => {
    spaces.mockReturnValue([
      { id: "terminal-space", active: true, folder: "/workspace", machine: "different-machine" },
    ])
    focused.mockReturnValue({
      pane: null,
      terminal: "terminal-remote/session-1",
      cwd: "/workspace/notes",
    })
    const { view, cx } = fixture()
    view.context = undefined
    view.refresh(cx)
    rows(view, [{ name: "notes.md", dir: false }])
    click("notes.md", cx)
    expectReader(view, cx, "notes.md", {
      file: "/workspace/notes/notes.md",
      root: "/workspace",
      on: "terminal-remote",
    })
  })

  it.each([null, "remote-machine"])(
    "captures pane cwd separately from workspace root, space, and machine %j",
    (machine) => {
      spaces.mockReturnValue([
        { id: "inactive-space", active: false, folder: "/wrong", machine: "wrong" },
        { id: "workspace-space", active: true, folder: "/project root", machine },
      ])
      focused.mockReturnValue({ pane: "pane-1", cwd: "/fallback" })
      panes.mockReturnValue([{ pane: "pane-1", cwd: "/project root/文書" }])
      const { view, cx } = fixture()
      view.context = undefined
      view.refresh(cx)
      expect(view.context).toEqual({
        key: expect.any(String),
        cwd: "/project root/文書",
        root: "/project root",
        space: "workspace-space",
        on: machine,
      })
      rows(view, [{ name: "Read Me.md", dir: false }])
      click("Read Me.md", cx)
      expectReader(view, cx, "Read Me.md", {
        file: "/project root/文書/Read Me.md",
        root: "/project root",
        on: machine,
      })
    },
  )
})

describe("embedded Reader lifecycle", () => {
  it("mounts the Reader entity under the existing Files view and releases the old code preview", () => {
    const { view, cx } = fixture()
    const code = { release: vi.fn() }
    view.code = code
    view.openFile("notes.md", cx, view.context)
    const reader = expectReader(view, cx, "notes.md", {
      file: "/workspace/project/subfolder/notes.md",
      root: "/workspace/project",
      on: null,
    })
    expect(code.release).toHaveBeenCalledOnce()
    expect(view.code).toBeNull()
    const tree = render(view, cx)
    expect(tree).toBe(ui.nodes.get("files"))
    expect(tree.childNodes.at(-1).childNodes).toEqual([reader.entity])
    expect(ui.nodes.has("files-back")).toBe(true)
    expect(ui.nodes.has("files-tree")).toBe(false)
    expect(cx.spawn).not.toHaveBeenCalled()
  })

  it.each(["Back", "show(null, cx)"])(
    "%s returns to the file tree and awaits child.close before releasing the entity",
    async (action) => {
      const { view, cx } = fixture()
      view.openFile("notes.md", cx, view.context)
      const reader = view.reader
      const finishClose = deferClose(reader)
      if (action === "Back") {
        render(view, cx)
        ui.nodes.get("files-back").handlers.on_click({}, cx)
      } else {
        view.show(null, cx)
      }
      expect(view.reader).toBeNull()
      expect(view.file).toBeNull()
      expect(view.closingReaders.size).toBe(1)
      expect(cx.spawn).toHaveBeenCalledOnce()
      expect(reader.view.close).not.toHaveBeenCalled()
      expect(reader.entity.release).not.toHaveBeenCalled()
      render(view, cx)
      expect(ui.nodes.has("files-tree")).toBe(true)
      expect(ui.nodes.has("files-back")).toBe(false)

      const cleanup = cx.spawn.mock.calls[0][0](cx)
      expect(reader.view.close).toHaveBeenCalledOnce()
      expect(reader.entity.release).not.toHaveBeenCalled()
      expect(view.closingReaders.size).toBe(1)
      finishClose()
      await cleanup
      expect(reader.entity.release).toHaveBeenCalledOnce()
      expect(view.closingReaders.size).toBe(0)
      view.show(null, cx)
      expect(cx.spawn).toHaveBeenCalledOnce()
    },
  )

  it.each(["replacement.md", "source.js"])(
    "replaces the Reader with %s without releasing it before child.close finishes",
    async (path) => {
      const { view, cx } = fixture()
      view.openFile("notes.md", cx, view.context)
      const oldReader = view.reader
      const finishClose = deferClose(oldReader)
      view.openFile(path, cx, view.context)
      const replacement = view.reader
      expect(view.file).toBe(path)
      expect(view.closingReaders.size).toBe(1)
      if (path.endsWith(".md")) {
        expect(cx.new).toHaveBeenCalledTimes(2)
        expect(replacement.entity).not.toBe(oldReader.entity)
        expect(replacement.view.props.file).toBe(`/workspace/project/subfolder/${path}`)
        expect(cx.spawn).toHaveBeenCalledOnce()
        const tree = render(view, cx)
        expect(tree.childNodes.at(-1).childNodes).toEqual([replacement.entity])
      } else {
        expect(replacement).toBeNull()
        expect(cx.new).toHaveBeenCalledOnce()
        // The second callback is the ordinary-file read; do not execute it.
        expect(cx.spawn).toHaveBeenCalledTimes(2)
      }
      const cleanup = cx.spawn.mock.calls[0][0](cx)
      expect(oldReader.view.close).toHaveBeenCalledOnce()
      expect(oldReader.entity.release).not.toHaveBeenCalled()
      finishClose()
      await cleanup
      expect(oldReader.entity.release).toHaveBeenCalledOnce()
      expect(view.closingReaders.size).toBe(0)
      expect(view.reader).toBe(replacement)
      expect(view.file).toBe(path)
      if (replacement) {
        expect(replacement.view.close).not.toHaveBeenCalled()
        expect(replacement.entity.release).not.toHaveBeenCalled()
      }
    },
  )

  it.each([false, true])(
    "parent close awaits cleanup even when Reader was already dismissed: %j",
    async (dismissed) => {
      const { view, cx } = fixture()
      view.openFile("notes.md", cx, view.context)
      const reader = view.reader
      const finishClose = deferClose(reader)
      if (dismissed) view.show(null, cx)
      const code = { release: vi.fn() }
      view.code = code
      const closed = vi.fn()
      const closing = view.close(cx).then(closed)
      expect(view.closed).toBe(true)
      expect(view.context).toBeNull()
      expect(view.reader).toBeNull()
      expect(view.code).toBeNull()
      expect(code.release).toHaveBeenCalledOnce()
      expect(cx.spawn).toHaveBeenCalledOnce()
      expect(view.closingReaders.size).toBe(1)
      await Promise.resolve()
      expect(closed).not.toHaveBeenCalled()

      const cleanup = cx.spawn.mock.calls[0][0](cx)
      expect(reader.view.close).toHaveBeenCalledOnce()
      expect(reader.entity.release).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(closed).not.toHaveBeenCalled()
      finishClose()
      await cleanup
      await closing
      expect(reader.entity.release).toHaveBeenCalledOnce()
      expect(closed).toHaveBeenCalledOnce()
      expect(view.closingReaders.size).toBe(0)
      await view.close(cx)
      expect(cx.spawn).toHaveBeenCalledOnce()
      expect(reader.entity.release).toHaveBeenCalledOnce()
    },
  )

  it("parent close waits for both the replaced Reader and the current Reader", async () => {
    const { view, cx } = fixture()
    view.openFile("first.md", cx, view.context)
    const first = view.reader
    const finishFirst = deferClose(first)
    view.openFile("second.md", cx, view.context)
    const second = view.reader
    const finishSecond = deferClose(second)
    const closed = vi.fn()
    const closing = view.close(cx).then(closed)
    expect(cx.spawn).toHaveBeenCalledTimes(2)
    expect(view.closingReaders.size).toBe(2)
    const firstCleanup = cx.spawn.mock.calls[0][0](cx)
    const secondCleanup = cx.spawn.mock.calls[1][0](cx)
    expect(first.entity.release).not.toHaveBeenCalled()
    expect(second.entity.release).not.toHaveBeenCalled()
    finishSecond()
    await secondCleanup
    expect(second.entity.release).toHaveBeenCalledOnce()
    expect(first.entity.release).not.toHaveBeenCalled()
    expect(view.closingReaders.size).toBe(1)
    expect(closed).not.toHaveBeenCalled()
    finishFirst()
    await firstCleanup
    await closing
    expect(first.entity.release).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
    expect(view.closingReaders.size).toBe(0)
  })
})

describe("direct Markdown opening outside the space folder", () => {
  it.each([
    ["/work/project", "/profile"],
    ["C:\\work\\project", "C:\\profile\\herdr-app"],
  ])("opens the clicked file directly from %s", (cwd, spaceFolder) => {
    spaces.mockReturnValue([{ id: "space", active: true, folder: spaceFolder, machine: null }])
    focused.mockReturnValue({ pane: "pane" })
    panes.mockReturnValue([{ pane: "pane", cwd }])
    const { view, cx } = fixture()
    view.context = undefined
    view.refresh(cx)
    expect(view.context.root).toBe(cwd)
    rows(view, [{ name: "AGENTS.md", dir: false }])
    click("AGENTS.md", cx)
    expectReader(view, cx, "AGENTS.md", { file: `${cwd}/AGENTS.md`, root: cwd, on: null })
  })
})
