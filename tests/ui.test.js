import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  service: { list: vi.fn(), install: vi.fn(), update: vi.fn() },
  closeOverlay: vi.fn(),
}))

vi.mock("herdr", () => ({
  appHome: () => "/unused-test-home",
  exec: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  closeOverlay: mocks.closeOverlay,
  props: () => ({ overlay: "manager-dialog" }),
  theme: () => ({}),
}))
vi.mock("../runtime.js", () => ({ createRuntime: vi.fn() }))
vi.mock("../manager.js", async (original) => ({
  ...(await original()),
  createManager: () => mocks.service,
}))

// Retain only the element tree and click callbacks. Native layout is checked separately in Herdr.
function element() {
  const node = { children: [], id: "", click: undefined }
  const api = new Proxy(node, {
    get(target, key) {
      if (key === "then") return undefined
      if (key === "child")
        return (child) => {
          target.children.push(child)
          return api
        }
      if (key === "children")
        return (children) => {
          target.children.push(...children)
          return api
        }
      if (key === "id")
        return (id) => {
          target.id = id
          return api
        }
      if (key === "on_click")
        return (callback) => {
          target.click = callback
          return api
        }
      if (key === "when")
        return (condition, callback) => {
          if (condition) callback(api)
          return api
        }
      if (key === "node") return target
      return () => api
    },
  })
  return api
}

vi.mock("gpui-kit", () => ({ View: class {}, div: () => element(), svg: () => element() }))
vi.mock("gpui-base", () => ({
  h_flex: () => element(),
  v_flex: () => element(),
  Scrollbar: { vertical: () => element() },
  Input: { new: () => element() },
  InputState: { new: () => ({ value: () => "", on: vi.fn() }) },
}))

const { default: ModManager } = await import("../main.js")

function context() {
  const tasks = []
  const cx = {
    notify: vi.fn(),
    open_url: vi.fn(),
    spawn: vi.fn((body, options) => {
      const unowned = {
        notify() {
          throw new Error("An unowned task cannot notify a view")
        },
      }
      const task = Promise.resolve().then(() => body(options?.owner === null ? unowned : cx))
      tasks.push(task)
      return task
    }),
  }
  return { cx, settle: () => Promise.all(tasks) }
}

function find(element, id) {
  if (typeof element !== "object" || !element?.node) return undefined
  if (element.node.id === id) return element.node
  for (const child of element.node.children) {
    const match = find(child, id)
    if (match) return match
  }
}

const mod = {
  id: "notes",
  name: "Notes",
  description: "Context",
  repository: "test/notes",
  version: "1.0",
  source: "github",
  icon: "package",
  managed: true,
  problem: "",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.service.list.mockResolvedValue([mod])
  mocks.service.install.mockResolvedValue("Installed test/notes.")
  mocks.service.update.mockResolvedValue("Updated test/notes.")
})

test("initialization reads real installed data without starting an install or update", async () => {
  const view = new ModManager()
  const { cx, settle } = context()
  view.init({}, cx)
  expect(view.loading).toBe(true)
  await settle()
  expect(view.mods).toEqual([mod])
  expect(view.loading).toBe(false)
  expect(mocks.service.install).not.toHaveBeenCalled()
  expect(mocks.service.update).not.toHaveBeenCalled()
})

test("renders all three pages and binds the real install and update controls", async () => {
  const view = new ModManager()
  const { cx, settle } = context()
  view.init({}, cx)
  await settle()
  find(view.render(), "update-notes").click({}, cx)
  await settle()
  expect(mocks.service.update).toHaveBeenCalledWith("notes")
  view.navigate("github", cx)
  view.repository = { value: () => "https://github.com/test/notes" }
  find(view.render(), "install-mod").click({}, cx)
  await settle()
  expect(mocks.service.install).toHaveBeenCalledWith("https://github.com/test/notes")
  view.navigate("gallery", cx)
  find(view.render(), "open-gallery").click({}, cx)
  expect(cx.open_url).toHaveBeenCalledWith("https://herdr.dev/gallery/?type=mods")
  find(view.render(), "close-manager").click({}, cx)
  expect(mocks.closeOverlay).toHaveBeenCalledWith("manager-dialog")
})

test("unmanaged mods have no update button", () => {
  const view = new ModManager()
  view.mods = [{ ...mod, managed: false }]
  expect(find(view.render(), "update-notes")).toBeUndefined()
})

test("ignores duplicate operations and refresh while an operation is running", async () => {
  const view = new ModManager()
  view.manager = mocks.service
  const { cx, settle } = context()
  let finish
  const operation = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  view.perform(cx, operation)
  view.perform(cx, operation)
  view.refresh(cx)
  await Promise.resolve()
  expect(operation).toHaveBeenCalledTimes(1)
  expect(mocks.service.list).not.toHaveBeenCalled()
  finish("Done")
  await settle()
  expect(view.busy).toBe(false)
})

test("operation survives dialog closure without using a closed view context", async () => {
  const view = new ModManager()
  view.manager = mocks.service
  const { cx, settle } = context()
  const operation = vi.fn().mockResolvedValue("Done")
  view.perform(cx, operation)
  expect(cx.spawn.mock.calls[0][1]).toEqual({ owner: null })
  view.close()
  cx.notify.mockClear()
  await settle()
  expect(operation).toHaveBeenCalledTimes(1)
  expect(cx.notify).not.toHaveBeenCalled()
  expect(mocks.service.list).not.toHaveBeenCalled()
  expect(view.busy).toBe(false)
})

test("shows operation failure and resets busy state", async () => {
  const view = new ModManager()
  view.manager = mocks.service
  const { cx, settle } = context()
  view.perform(cx, async () => {
    throw new Error("Local changes exist")
  })
  await settle()
  expect(view.notice).toBe("Local changes exist")
  expect(view.failed).toBe(true)
  expect(view.busy).toBe(false)
})

test("preserves operation success when the following refresh fails", async () => {
  const view = new ModManager()
  view.manager = mocks.service
  mocks.service.list.mockRejectedValueOnce(new Error("Cannot read mods"))
  const { cx, settle } = context()
  view.perform(cx, async () => "Installed test/notes.")
  await settle()
  expect(view.notice).toContain("Installed test/notes.")
  expect(view.notice).toContain("Refresh failed: Cannot read mods")
  expect(view.busy).toBe(false)
})

test("shows discovery and browser failures without crashing", async () => {
  const view = new ModManager()
  view.manager = mocks.service
  mocks.service.list.mockRejectedValueOnce(new Error("Install uv and Python 3"))
  const { cx, settle } = context()
  view.refresh(cx)
  await settle()
  expect(view.notice).toContain("Install uv")
  expect(view.loading).toBe(false)
  cx.open_url.mockImplementation(() => {
    throw new Error("No browser")
  })
  view.openGallery(cx)
  expect(view.notice).toContain("Use the Gallery URL")
})
