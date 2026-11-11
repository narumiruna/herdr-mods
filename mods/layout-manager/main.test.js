import { beforeEach, describe, expect, it, vi } from "vitest"

const ui = vi.hoisted(() => {
  const nodes = new Map()
  const element = () => {
    const node = { handlers: {}, items: [], props: {} }
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key]
        return (...args) => {
          if (key === "id") nodes.set(args[0], proxy)
          else if (key === "child") node.items.push(args[0])
          else if (key === "children") node.items.push(...args[0])
          else if (key === "when" && args[0]) args[1](proxy)
          else if (key.startsWith("on_")) {
            const button = typeof args[0] === "string" ? `-${args[0]}` : ""
            node.handlers[`${key}${button}`] = args.at(-1)
          } else node.props[key] = args[0]
          return proxy
        }
      },
    })
    return proxy
  }
  return { nodes, element }
})

vi.mock("gpui-kit", () => ({ View: class {}, div: ui.element }))
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
    Button: { new: (id) => ui.element().id(id) },
    Input: { new: ui.element },
    Textarea: { new: ui.element },
    h_flex: ui.element,
    v_flex: ui.element,
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

import { openOverlay, run, theme } from "herdr"
import LayoutManager from "./main.js"
import { addPanel, dockPosition, findNode, managedSlots, STACK_ID } from "./model.js"

const tree = { id: "original", type: "block", content: { tab: "active" } }

/** Queue async view tasks and record notifications without a native window. */
function context() {
  const tasks = []
  const asyncContexts = []
  return {
    notify: vi.fn(),
    stop_propagation: vi.fn(),
    focus_handle: () => ({ focus: vi.fn(), release: vi.fn() }),
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

/** Load one installed mod and a personal layout through guarded in-memory file I/O. */
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
  view.currentTree = () => view.snapshot?.tree ?? initial
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

beforeEach(() => {
  vi.clearAllMocks()
  ui.nodes.clear()
  vi.mocked(theme).mockReturnValue({})
})

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
    expect(view.focus.release).toHaveBeenCalledOnce()
  })
})

const pointer = (x = 0, y = 0) => ({ position: { x, y } })
const edge = (position) => ({ kind: "edge", position, key: `edge-${position}` })
const tab = (before = null) => ({
  kind: "tab",
  before,
  key: before === null ? "append" : `tab-${before}`,
})
const removeTarget = { kind: "remove", key: "remove" }

function begin(view, cx, kind = "mod", name = "example") {
  view.startDrag(kind, name, pointer(), cx)
}

function drop(view, cx, target) {
  view.hoverDrop(target, pointer(20, 10), cx)
  view.finishDrop(target, pointer(20, 10), cx)
}

function dispatch(id, handler, event, cx) {
  const node = ui.nodes.get(id)
  expect(node, `Missing UI element ${id}`).toBeDefined()
  expect(node.handlers[handler], `Missing handler ${id}.${handler}`).toBeTypeOf("function")
  node.handlers[handler](event, cx)
}

describe("graphical layout gestures", () => {
  it.each(["left", "right", "top", "bottom"])(
    "drops a new mod at the %s edge with its draft",
    async (position) => {
      const { view, cx, io } = await ready()
      view.properties.set_value('{"mode":"compact"}')
      begin(view, cx)
      expect(view.focus.focus).toHaveBeenCalledOnce()
      drop(view, cx, edge(position))
      expect(view.drag).toBeNull()
      await cx.flush()
      expect(dockPosition(view.snapshot.tree)).toBe(position)
      expect(view.snapshot.slots[0].props).toEqual({ mode: "compact" })
      expect(io.writeText).toHaveBeenCalledOnce()
    },
  )

  it("does not write for a click or movement below the drag threshold", async () => {
    const { view, cx, io } = await ready()
    begin(view, cx)
    view.hoverDrop(edge("left"), pointer(2, 2), cx)
    view.finishDrop(edge("left"), pointer(2, 2), cx)
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
    expect(view.drag).toBeNull()
    expect(view.dropTarget).toBeNull()
  })

  it("updates drag feedback only when its state changes", async () => {
    const { view, cx } = await ready()
    begin(view, cx)
    view.hoverDrop(edge("top"), pointer(10, 10), cx)
    expect(view.dropTarget).toBe("edge-top")
    cx.notify.mockClear()
    view.hoverDrop(edge("top"), pointer(20, 20), cx)
    expect(cx.notify).not.toHaveBeenCalled()
  })

  it("moves the complete dock without parsing props or changing its tabs", async () => {
    const initial = addPanel(addPanel(tree, { name: "example", props: { keep: true } }), {
      name: "missing",
    })
    const { view, cx } = await ready("example", initial)
    view.properties.set_value("invalid props")
    begin(view, cx, "dock", null)
    drop(view, cx, edge("bottom"))
    await cx.flush()
    expect(dockPosition(view.snapshot.tree)).toBe("bottom")
    expect(view.snapshot.slots).toEqual(managedSlots(initial))
    expect(findNode(view.snapshot.tree, STACK_ID).active).toBe(findNode(initial, STACK_ID).active)
  })

  it("reorders missing managed cards by name without changing props", async () => {
    const initial = addPanel(addPanel(tree, { name: "example" }), {
      name: "missing",
      props: { keep: true },
    })
    const { view, cx } = await ready("example", initial)
    view.selectMod("missing", cx)
    view.properties.set_value("invalid draft")
    begin(view, cx, "mod", "missing")
    drop(view, cx, tab("example"))
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["missing", "example"])
    expect(view.snapshot.slots[0].props).toEqual({ keep: true })
    begin(view, cx, "mod", "missing")
    drop(view, cx, tab())
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["example", "missing"])
  })

  it.each(["first", null])(
    "keeps the live active tab when moving an inactive tab before %s",
    async (before) => {
      const initial = addPanel(addPanel(addPanel(tree, { name: "first" }), { name: "example" }), {
        name: "active",
      })
      findNode(initial, "layout-manager-dock").hidden = true
      const { view, cx } = await ready("example", initial)
      begin(view, cx)
      drop(view, cx, tab(before))
      await cx.flush()
      view.render(cx)
      expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(
        before === null ? ["first", "active", "example"] : ["example", "first", "active"],
      )
      expect(findNode(view.snapshot.tree, STACK_ID).active).toBe("layout-manager-mod-active")
      expect(findNode(view.snapshot.tree, "layout-manager-dock").hidden).toBe(true)
      expect(view.reveal).toBeFalsy()
      expect(run).not.toHaveBeenCalled()
    },
  )

  it.each(["new edge", "new tab", "existing edge"])(
    "still reveals a %s placement",
    async (placement) => {
      const initial =
        placement === "existing edge"
          ? addPanel(addPanel(tree, { name: "example" }), { name: "first" })
          : addPanel(tree, { name: "first" })
      const { view, cx } = await ready("example", initial)
      begin(view, cx)
      drop(view, cx, placement === "new tab" ? tab("first") : edge("left"))
      await cx.flush()
      view.render(cx)
      expect(run).toHaveBeenCalledWith("layout.select", {
        stack: STACK_ID,
        child: "layout-manager-mod-example",
      })
      expect(run).toHaveBeenCalledWith("layout.show", { id: "layout-manager-dock" })
    },
  )

  it("inserts a new mod before a managed card and saves only once", async () => {
    const { view, cx, io } = await ready("example", addPanel(tree, { name: "missing" }))
    begin(view, cx)
    drop(view, cx, tab("missing"))
    view.finishDrop(tab("missing"), pointer(20, 10), cx)
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["example", "missing"])
    expect(io.writeText).toHaveBeenCalledOnce()
  })

  it("restores the original layout when its final missing card is dropped on remove", async () => {
    const { view, cx } = await ready("example", addPanel(tree, { name: "missing" }))
    begin(view, cx, "mod", "missing")
    drop(view, cx, removeTarget)
    await cx.flush()
    expect(view.snapshot.tree).toEqual(tree)
    expect(view.selected).toBeNull()
    expect(view.mods.some((mod) => mod.name === "missing")).toBe(false)
  })

  it("rejects new cards on remove and dock grips on tab targets", async () => {
    const { view, cx, io } = await ready()
    begin(view, cx)
    drop(view, cx, removeTarget)
    view.apply(cx)
    await cx.flush()
    io.writeText.mockClear()
    begin(view, cx, "dock", null)
    drop(view, cx, tab("example"))
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("reports an invalid new-mod draft without writing", async () => {
    const { view, cx, io } = await ready()
    view.properties.set_value("[]")
    begin(view, cx)
    drop(view, cx, edge("top"))
    await cx.flush()
    expect(view.error).toContain("JSON object")
    expect(view.drag).toBeNull()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["shipped", "loading", "busy", "needsRefresh", "closed"])(
    "does not begin a gesture while %s",
    async (state) => {
      const { view, cx, io } = await ready()
      if (state === "shipped") view.snapshot.shipped = true
      else view[state] = true
      begin(view, cx)
      drop(view, cx, edge("left"))
      await cx.flush()
      expect(view.drag).toBeNull()
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it("does not begin dragging an unavailable mod without a saved placement", async () => {
    const { view, cx, io } = await ready()
    view.mods[0].available = false
    begin(view, cx)
    expect(view.drag).toBeNull()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("cancels on refresh and close without saving", async () => {
    const { view, cx, io } = await ready()
    begin(view, cx)
    view.refresh(cx)
    expect(view.drag).toBeNull()
    await cx.flush()
    begin(view, cx)
    view.close()
    expect(view.drag).toBeNull()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each([
    ["on_mouse_up-left", pointer()],
    ["on_mouse_down-left", pointer()],
    ["on_mouse_down_out", pointer()],
    ["on_hover", false],
    ["on_key_down", { key: "escape" }],
  ])("wires root %s to cancel without saving", async (handler, event) => {
    const { view, cx, io } = await ready()
    view.render(cx)
    dispatch("drag-mod-example", "on_mouse_down-left", pointer(), cx)
    dispatch("layout-manager", "on_mouse_move", pointer(20, 10), cx)
    expect(view.drag.active).toBe(true)
    dispatch("layout-manager", handler, event, cx)
    expect(view.drag).toBeNull()
    expect(view.dropTarget).toBeNull()
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("wires rendered edge and reorder targets to their saved operations", async () => {
    const { view, cx } = await ready("example", addPanel(tree, { name: "missing" }))
    view.render(cx)
    dispatch("drag-mod-example", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-left", "on_mouse_move", pointer(20, 10), cx)
    expect(view.dropTarget).toBe("edge-left")
    dispatch("drop-left", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expect(dockPosition(view.snapshot.tree)).toBe("left")
    view.render(cx)
    dispatch("drag-tab-example", "on_mouse_down-left", pointer(), cx)
    dispatch("preview-tab-missing", "on_mouse_move", pointer(20, 10), cx)
    dispatch("preview-tab-missing", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["example", "missing"])
  })

  it("keeps the append target distinct from a valid mod named end", async () => {
    const initial = addPanel(addPanel(tree, { name: "example" }), { name: "end" })
    const { view, cx } = await ready("example", initial)
    const targets = []
    const decorate = view.dropZone.bind(view)
    vi.spyOn(view, "dropZone").mockImplementation((element, target) => {
      targets.push(target)
      return decorate(element, target)
    })
    view.editor()
    expect(new Set(targets.map((target) => target.key)).size).toBe(targets.length)
    const beforeEnd = targets.find((target) => target.before === "end")
    const append = targets.find((target) => target.kind === "tab" && target.before === null)
    begin(view, cx)
    view.hoverDrop(beforeEnd, pointer(20, 10), cx)
    expect(view.dropTarget).toBe(beforeEnd.key)
    expect(view.dropTarget).not.toBe(append.key)
  })

  it("clears the highlight when a drop target is left", async () => {
    const { view, cx } = await ready()
    view.render(cx)
    begin(view, cx)
    dispatch("drop-right", "on_mouse_move", pointer(20, 10), cx)
    expect(view.dropTarget).toBe("edge-right")
    dispatch("drop-right", "on_hover", false, cx)
    expect(view.dropTarget).toBeNull()
    expect(view.drag.active).toBe(true)
  })

  it("blocks stale drops until refresh and never retries a gesture", async () => {
    const { view, cx, io, files } = await ready()
    begin(view, cx)
    files.set("/fixture/layouts/personal.json", `${JSON.stringify(tree)}\n`)
    drop(view, cx, edge("left"))
    await cx.flush()
    expect(view.needsRefresh).toBe(true)
    expect(view.drag).toBeNull()
    begin(view, cx)
    drop(view, cx, edge("right"))
    await cx.flush()
    expect(io.writeText).toHaveBeenCalledOnce()
    expect(view.error).toContain("Refresh")
  })

  it("rejects a layout switch between press and release", async () => {
    const { view, cx, io, changeLayout } = await ready()
    begin(view, cx)
    changeLayout("different")
    drop(view, cx, edge("top"))
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
    expect(view.error).toContain("current layout changed")
    expect(view.drag).toBeNull()
  })
})

describe("keyboard tab order controls", () => {
  it("renders labeled tab stops and moves a card without parsing props or activating it", async () => {
    const initial = addPanel(
      addPanel(addPanel(tree, { name: "first" }), { name: "example", title: "Example" }),
      { name: "last" },
    )
    const { view, cx, io } = await ready("example", initial)
    view.properties.set_value("invalid draft")
    view.render(cx)
    for (const direction of ["earlier", "later"]) {
      const button = ui.nodes.get(`move-tab-example-${direction}`)
      expect(button.props.accessibility_label).toBe(`Move Example tab ${direction}`)
      expect(button.props.tab_stop).toBe(true)
      expect(button.props.disabled).toBe(false)
    }
    dispatch("move-tab-example-earlier", "on_click", {}, cx)
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["example", "first", "last"])
    view.render(cx)
    expect(run).not.toHaveBeenCalled()
    dispatch("move-tab-example-later", "on_click", {}, cx)
    await cx.flush()
    view.render(cx)
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["first", "example", "last"])
    expect(findNode(view.snapshot.tree, STACK_ID).active).toBe("layout-manager-mod-last")
    expect(run).not.toHaveBeenCalled()
    expect(io.writeText).toHaveBeenCalledTimes(2)
  })

  it("moves an unavailable card without requiring mouse selection", async () => {
    const initial = addPanel(addPanel(tree, { name: "example" }), {
      name: "missing",
      props: { keep: true },
    })
    const { view, cx } = await ready("example", initial)
    expect(view.selected).toBe("example")
    view.render(cx)
    dispatch("move-tab-missing-earlier", "on_click", {}, cx)
    await cx.flush()
    expect(view.snapshot.slots.map((slot) => slot.name)).toEqual(["missing", "example"])
    expect(view.snapshot.slots[0].props).toEqual({ keep: true })
    expect(view.selected).toBe("example")
  })

  it.each([
    ["example", "earlier"],
    ["missing", "later"],
  ])("disables the %s %s boundary move", async (name, direction) => {
    const { view, cx, io } = await ready(
      "example",
      addPanel(addPanel(tree, { name: "example" }), { name: "missing" }),
    )
    view.render(cx)
    const button = ui.nodes.get(`move-tab-${name}-${direction}`)
    expect(button.props.disabled).toBe(true)
    expect(button.props.tab_stop).toBe(false)
    dispatch(`move-tab-${name}-${direction}`, "on_click", {}, cx)
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["shipped", "loading", "busy", "needsRefresh", "closed"])(
    "blocks tab moves while %s",
    async (state) => {
      const { view, cx, io } = await ready(
        "example",
        addPanel(addPanel(tree, { name: "example" }), { name: "missing" }),
      )
      if (state === "shipped") view.snapshot.shipped = true
      else view[state] = true
      view.render(cx)
      const button = ui.nodes.get("move-tab-example-later")
      expect(button.props.disabled).toBe(true)
      expect(button.props.tab_stop).toBe(false)
      dispatch("move-tab-example-later", "on_click", {}, cx)
      await cx.flush()
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it("rejects stale keyboard saves and blocks a second attempt", async () => {
    const { view, cx, io, files } = await ready(
      "example",
      addPanel(addPanel(tree, { name: "example" }), { name: "missing" }),
    )
    view.render(cx)
    files.set("/fixture/layouts/personal.json", "changed elsewhere")
    dispatch("move-tab-example-later", "on_click", {}, cx)
    await cx.flush()
    expect(view.needsRefresh).toBe(true)
    expect(view.error).toContain("Refresh")
    dispatch("move-tab-example-later", "on_click", {}, cx)
    await cx.flush()
    expect(io.writeText).toHaveBeenCalledOnce()
  })
})
