import { closeOverlay, exec, focused, notify, openOverlay, props, spaces, window } from "herdr"
import { beforeEach, expect, it, vi } from "vitest"
import Files from "./main.js"

// Record the rendered tree and event handlers; no native UI or host I/O runs.
const element = vi.hoisted(() => () => {
  const node = { elementId: undefined, items: [], handlers: {} }
  const builder = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args) => {
        if (key === "id") node.elementId = args[0]
        if (key === "child") node.items.push(args[0])
        if (key === "children") node.items.push(...args[0])
        if (key === "when" && args[0]) args[1](builder)
        if (key.startsWith("on_")) {
          const event = args.length === 2 ? `${key}:${args[0]}` : key
          node.handlers[event] = args.at(-1)
        }
        return builder
      }
    },
  })
  return builder
})

vi.mock("gpui-kit", () => ({ View: class {}, div: element, svg: element }))
vi.mock("gpui-base", () => ({ h_flex: element, v_flex: element, Editor: {}, EditorState: {} }))
vi.mock("herdr", () => ({
  closeOverlay: vi.fn(),
  exec: vi.fn(),
  focused: vi.fn(),
  notify: vi.fn(),
  openOverlay: vi.fn(),
  panes: vi.fn(() => []),
  props: vi.fn(),
  readTextFile: vi.fn(),
  settings: vi.fn(),
  spaces: vi.fn(),
  theme: () => ({}),
  watchFolder: vi.fn(),
  window: vi.fn(),
}))

const target = { root: "/demo", path: "docs/notes.txt", on: null }

function find(node, id) {
  if (typeof node === "string") return undefined
  if (node.elementId === id) return node
  for (const child of node.items) {
    const match = find(child, id)
    if (match) return match
  }
}

function view(overlayProps) {
  props.mockReturnValue(overlayProps)
  const cx = {
    focus_handle: () => ({ focus() {} }),
    notify: vi.fn(),
    spawn: vi.fn(),
    stop_propagation: vi.fn(),
    timer: { every() {} },
    write_to_clipboard: vi.fn(),
  }
  const files = new Files()
  files.init(undefined, cx)
  return { files, cx }
}

beforeEach(() => {
  vi.resetAllMocks()
  exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" })
  window.mockReturnValue({ platform: "macos" })
})

it("dispatches a remote row's context menu and lets it copy without running commands", () => {
  spaces.mockReturnValue([{ id: "demo", active: true, machine: null, folder: "/demo" }])
  focused.mockReturnValue({ pane: null, terminal: "build/terminal", cwd: "/remote" })
  const { files, cx } = view()
  files.entries.set("", [{ name: "notes.txt", dir: false }])
  find(files.render(cx), "file-notes.txt").handlers["on_mouse_down:right"]({}, cx)
  const menuTarget = { root: "/remote", path: "notes.txt", on: "build" }
  expect(cx.stop_propagation).toHaveBeenCalledOnce()
  expect(openOverlay).toHaveBeenCalledWith({
    mod: "files-panel",
    kind: "popup",
    width: 228,
    props: { fileAction: "menu", target: menuTarget },
  })

  const menu = view({ fileAction: "menu", overlay: "menu", target: menuTarget })
  const tree = menu.files.render(menu.cx)
  expect(find(tree, "files-action-3")).toBeUndefined()
  expect(find(tree, "files-action-4")).toBeUndefined()
  find(tree, "files-action-2").handlers.on_click({}, menu.cx)
  expect(menu.cx.write_to_clipboard).toHaveBeenCalledWith("/remote/notes.txt")
  expect(closeOverlay).toHaveBeenCalledWith("menu")
  expect(exec).not.toHaveBeenCalled()
})

it("opens a confirmation for local Trash and does not run a command on cancel", () => {
  const menu = view({ fileAction: "menu", overlay: "menu", target })
  find(menu.files.render(menu.cx), "files-action-4").handlers.on_click({}, menu.cx)
  expect(closeOverlay).toHaveBeenCalledWith("menu")
  expect(openOverlay).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "dialog", props: { fileAction: "trash", target } }),
  )
  const dialog = view({ fileAction: "trash", overlay: "dialog", target })
  find(dialog.files.render(dialog.cx), "files-trash-cancel").handlers.on_click({}, dialog.cx)
  expect(closeOverlay).toHaveBeenCalledWith("dialog")
  expect(exec).not.toHaveBeenCalled()
  expect(dialog.cx.spawn).not.toHaveBeenCalled()
})

it("runs one Trash command only after confirmation and closes on success", async () => {
  const { files, cx } = view({ fileAction: "trash", overlay: "dialog", target })
  const confirm = find(files.render(cx), "files-trash-confirm")
  expect(cx.spawn).not.toHaveBeenCalled()
  confirm.handlers.on_click({}, cx)
  confirm.handlers.on_click({}, cx)
  expect(cx.spawn).toHaveBeenCalledOnce()
  await cx.spawn.mock.calls[0][0](cx)
  expect(exec).toHaveBeenCalledExactlyOnceWith("/bin/sh", [
    "-c",
    expect.any(String),
    "files-panel",
    "/demo",
    "docs",
    "notes.txt",
  ])
  expect(notify).toHaveBeenCalledWith({
    title: "Moved to Trash",
    body: "notes.txt",
    level: "success",
  })
  expect(closeOverlay).toHaveBeenCalledWith("dialog")
})

it.each([
  ["macos", "build"],
  ["linux", null],
  ["windows", null],
])("refuses to confirm Trash on platform %s with machine %s", (platform, on) => {
  window.mockReturnValue({ platform })
  const { files, cx } = view({ fileAction: "trash", overlay: "dialog", target: { ...target, on } })
  find(files.render(cx), "files-trash-confirm").handlers.on_click({}, cx)
  expect(cx.spawn).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
})
