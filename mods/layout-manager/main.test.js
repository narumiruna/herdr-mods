import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("gpui-kit", () => ({ View: class {}, div: vi.fn() }))
vi.mock("fs/promises", () => ({ readdir: vi.fn(), exists: vi.fn() }))
vi.mock("gpui-base", () => {
  function input(options = {}) {
    let value = options.value ?? ""
    return {
      value: () => value,
      set_value: (next) => {
        value = next
      },
      on: vi.fn(),
      release: vi.fn(),
    }
  }
  return {
    Button: {},
    Input: {},
    Textarea: {},
    h_flex: vi.fn(),
    v_flex: vi.fn(),
    InputState: { new: input },
    TextareaState: { new: input },
  }
})
vi.mock("herdr", () => ({
  appHome: vi.fn(),
  closeOverlay: vi.fn(),
  layout: vi.fn(),
  openOverlay: vi.fn(),
  props: vi.fn(),
  readTextFile: vi.fn(),
  run: vi.fn(),
  shared: vi.fn(),
  theme: vi.fn(),
  writeTextFile: vi.fn(),
}))

import { openOverlay, run } from "herdr"
import LayoutManager from "./main.js"
import { addPanel, managedSlots } from "./model.js"

const tree = { id: "original", type: "block", content: { tab: "active" } }

function context() {
  const tasks = []
  const asyncContexts = []
  return {
    notify: vi.fn(),
    asyncContexts,
    spawn(body) {
      const cx = { notify: vi.fn() }
      asyncContexts.push(cx)
      tasks.push(Promise.resolve().then(() => body(cx)))
    },
    async flush() {
      while (tasks.length) await Promise.all(tasks.splice(0))
    },
  }
}

async function ready(name = "example", initial = tree) {
  let current = "personal"
  const files = new Map([
    ["/fixture/installed.json", "{}"],
    ["/fixture/layouts/personal.json", JSON.stringify(initial)],
    [`/fixture/mods/${name}/mod.json`, JSON.stringify({ title: "Example" })],
  ])
  const io = {
    home: "/fixture",
    currentName: () => current,
    list: async () => [name],
    exists: async () => true,
    readText: vi.fn(async (path) => files.get(path) ?? null),
    writeText: vi.fn(async (path, next, expected) => {
      if (files.get(path) !== expected) throw new Error("Stale snapshot")
      files.set(path, next)
    }),
  }
  const view = new LayoutManager()
  view.createIO = () => io
  const cx = context()
  view.init({}, cx)
  await cx.flush()
  return {
    view,
    cx,
    io,
    files,
    changeLayout: (name) => {
      current = name
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe("view actions", () => {
  it("does not create inputs, discovery, or tasks for a dock header", () => {
    const view = new LayoutManager()
    view.createIO = vi.fn(() => {
      throw new Error("No discovery in dock mode")
    })
    const cx = context()
    view.init({ mode: "dock" }, cx)
    expect(view.createIO).not.toHaveBeenCalled()
    expect(view.properties).toBeUndefined()
    expect(cx.asyncContexts).toHaveLength(0)
  })

  it("loads the personal layout and applies parsed props through its own async context", async () => {
    const { view, cx, io } = await ready()
    expect(view.selected).toBe("example")
    view.properties.set_value('{"mode":"compact"}')
    view.apply(cx)
    await cx.flush()
    expect(io.writeText).toHaveBeenCalledTimes(1)
    expect(managedSlots(view.snapshot.tree)[0].props).toEqual({ mode: "compact" })
    expect(view.busy).toBe(false)
    expect(cx.asyncContexts.every((task) => task.notify.mock.calls.length > 0)).toBe(true)
  })

  it("keeps arbitrary valid folder names out of object prototype lookup", async () => {
    const { view, cx } = await ready("constructor")
    expect(view.properties.value()).toBe("{}")
    view.properties.set_value('{"custom":true}')
    view.selectMod("constructor", cx)
    expect(view.properties.value()).toBe('{"custom":true}')
  })

  it("reports invalid props without starting a write or an overlay", async () => {
    const { view, cx, io } = await ready()
    view.properties.set_value("[]")
    view.apply(cx)
    view.openSelected(cx)
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
    expect(openOverlay).not.toHaveBeenCalled()
    expect(view.error).toContain("JSON object")
  })

  it("opens only the selected mod with explicit props", async () => {
    const { view, cx, io } = await ready()
    view.properties.set_value('{"mode":"compact"}')
    view.openSelected(cx)
    expect(openOverlay).toHaveBeenCalledWith({
      mod: "example",
      props: { mode: "compact" },
      kind: "dialog",
      width: 720,
      height: 0.8,
    })
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("shows an existing panel without writing a file or parsing draft props", async () => {
    const initial = addPanel(tree, { name: "example", props: {} })
    const { view, cx, io } = await ready("example", initial)
    view.currentTree = () => initial
    view.properties.set_value("invalid props")
    view.showSelected(cx)
    expect(run).toHaveBeenCalledWith("layout.select", {
      stack: "layout-manager-stack",
      child: "layout-manager-mod-example",
    })
    expect(run).toHaveBeenCalledWith("layout.show", { id: "layout-manager-dock" })
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("does not show a panel from a different layout", async () => {
    const initial = addPanel(tree, { name: "example", props: {} })
    const { view, cx, changeLayout } = await ready("example", initial)
    changeLayout("different")
    view.showSelected(cx)
    expect(run).not.toHaveBeenCalled()
    expect(view.error).toContain("Refresh")
  })

  it("blocks repeated stale writes until the user refreshes", async () => {
    const { view, cx, io, files } = await ready()
    const external = `${JSON.stringify(tree)}\n`
    files.set("/fixture/layouts/personal.json", external)
    view.apply(cx)
    await cx.flush()
    expect(view.needsRefresh).toBe(true)
    expect(view.error).toContain("Refresh")
    view.apply(cx)
    await cx.flush()
    expect(io.writeText).toHaveBeenCalledTimes(1)
    view.refresh(cx)
    await cx.flush()
    expect(view.needsRefresh).toBe(false)
    expect(view.snapshot.raw).toBe(external)
  })

  it("rejects a current-layout switch before a captured write", async () => {
    const { view, cx, io, changeLayout } = await ready()
    changeLayout("different")
    view.apply(cx)
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
    expect(view.error).toContain("current layout changed")
  })

  it("removes missing placements without parsing an unrelated invalid props draft", async () => {
    const initial = addPanel(tree, { name: "missing", title: "Missing Mod", props: { keep: true } })
    const { view, cx } = await ready("example", initial)
    view.selectMod("missing", cx)
    view.properties.set_value("invalid props")
    view.apply(cx, true)
    await cx.flush()
    expect(view.snapshot.tree).toEqual(tree)
    expect(view.mods.some((item) => item.name === "missing")).toBe(false)
  })

  it("releases native input states and does not update a closed view", async () => {
    const { view, cx } = await ready()
    view.refresh(cx)
    view.close()
    await cx.flush()
    expect(view.search.release).toHaveBeenCalledOnce()
    expect(view.properties.release).toHaveBeenCalledOnce()
    expect(view.cloneName.release).toHaveBeenCalledOnce()
  })
})
