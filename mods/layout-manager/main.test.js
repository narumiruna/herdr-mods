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
    Button: { new: vi.fn((id) => ui.element().id(id)) },
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

import { Button } from "gpui-base"
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

const sides = ["left", "right", "top", "bottom"]
const nodeDrop = (id, position, outline = false) => ({
  kind: "node",
  id,
  position,
  key: `${outline ? "outline-node" : "node"}-${JSON.stringify([id, position])}`,
})

function ordinaryTree(container = false) {
  return {
    id: "body",
    type: "column",
    children: [
      container
        ? {
            id: "saved",
            type: "stack",
            active: "saved-child",
            header: { content: { mod: "opaque-header" } },
            children: [
              {
                id: "saved-child",
                type: "block",
                content: { mod: "missing", props: { keep: true } },
              },
              { id: "inactive-child", type: "block", hidden: true, content: { tab: "active" } },
            ],
          }
        : {
            id: "saved",
            type: "block",
            hidden: true,
            size: { px: 73 },
            content: { mod: "missing", props: { session: "keep", nested: { value: 1 } } },
          },
      {
        id: "branch",
        type: "row",
        resizable: true,
        children: [
          { id: "anchor", type: "block", content: { mod: "example", props: { original: true } } },
          { id: "same-name", type: "block", content: { mod: "example", props: { other: true } } },
        ],
      },
      { id: "tail", type: "block", content: { tab: "active" } },
    ],
  }
}

/** Inspect structural children independently of the placement implementation. */
function structuralNodes(root) {
  return [root, ...(root.children ?? []).flatMap(structuralNodes)]
}

function uiText(element) {
  return typeof element === "string" ? element : (element.items ?? []).map(uiText).join("\n")
}

function expectClearedDrag(view) {
  expect(view.drag).toBeNull()
  expect(view.dropTarget).toBeNull()
  expect(view.dropPlacement).toBeNull()
}

function expectPlacement(root, sourceId, targetId, side) {
  const parent = structuralNodes(root).find(
    (node) =>
      node.children?.some((child) => child.id === sourceId) &&
      node.children.some((child) => child.id === targetId),
  )
  expect(parent, `Missing placement ${sourceId} ${side} of ${targetId}`).toBeDefined()
  expect(parent.type).toBe(side === "left" || side === "right" ? "row" : "column")
  const ids = parent.children.map((child) => child.id)
  expect(ids.indexOf(sourceId) - ids.indexOf(targetId)).toBe(
    side === "left" || side === "top" ? -1 : 1,
  )
}

async function keyboardPlace(view, cx, sourceId, targetId, side) {
  view.render(cx)
  dispatch(`source-node-${sourceId}`, "on_click", {}, cx)
  dispatch(`target-node-${targetId}`, "on_click", {}, cx)
  view.render(cx)
  dispatch(`place-node-${side}`, "on_click", {}, cx)
  await cx.flush()
}

/** Pause an expected-content write after the save guards have run. */
function pauseWrite(io) {
  const write = io.writeText.getMockImplementation()
  let entered
  let release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const pending = new Promise((resolve) => {
    release = resolve
  })
  io.writeText.mockImplementationOnce(async (...args) => {
    entered()
    await pending
    return write(...args)
  })
  return { started, release: () => release() }
}

describe("ordinary tree UI", () => {
  it.each(sides)(
    "moves the exact unavailable instance %s without reading an unrelated draft",
    async (side) => {
      const initial = ordinaryTree()
      const original = structuredClone(initial)
      const { view, cx, io } = await ready("example", initial)
      const snapshot = view.snapshot
      view.properties.set_value("invalid unrelated draft")
      view.render(cx)
      dispatch("drag-node-saved", "on_mouse_down-left", pointer(), cx)
      expect(view.drag).toMatchObject({ kind: "node", id: "saved", active: false })
      expect(view.drag).not.toHaveProperty("name")
      expect(view.nodeSource).toEqual({ kind: "node", id: "saved" })
      dispatch(`drop-node-anchor-${side}`, "on_mouse_move", pointer(20, 10), cx)
      expect(view.dropPlacement).toEqual({ id: "anchor", side })
      dispatch(`drop-node-anchor-${side}`, "on_mouse_up-left", pointer(20, 10), cx)
      expectClearedDrag(view)
      await cx.flush()
      const result = view.snapshot.tree
      expectPlacement(result, "saved", "anchor", side)
      for (const id of ["saved", "anchor", "same-name", "tail"]) {
        expect(findNode(result, id)).toEqual(findNode(initial, id))
      }
      const nodes = structuralNodes(result)
      for (const node of structuralNodes(initial))
        expect(nodes.filter((entry) => entry.id === node.id)).toHaveLength(1)
      expect(nodes.filter((node) => node.content?.mod)).toHaveLength(3)
      expect(managedSlots(result)).toEqual([])
      expect(findNode(result, "layout-manager-dock")).toBeNull()
      expect(snapshot.tree).toEqual(original)
      expect(initial).toEqual(original)
      expect(io.writeText).toHaveBeenCalledExactlyOnceWith(
        "/fixture/layouts/personal.json",
        view.snapshot.raw,
        snapshot.raw,
      )
      expect(run).not.toHaveBeenCalled()
      expect(openOverlay).not.toHaveBeenCalled()
    },
  )

  it.each(sides)("moves a complete container subtree %s through outline handlers", async (side) => {
    const initial = ordinaryTree(true)
    const { view, cx, io } = await ready("example", initial)
    view.properties.set_value("invalid draft")
    view.render(cx)
    dispatch("drag-node-saved", "on_mouse_down-left", pointer(), cx)
    dispatch(`outline-drop-node-anchor-${side}`, "on_mouse_move", pointer(20, 10), cx)
    expect(view.dropTarget).toBe(nodeDrop("anchor", side, true).key)
    dispatch(`outline-drop-node-anchor-${side}`, "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expectPlacement(view.snapshot.tree, "saved", "anchor", side)
    expect(findNode(view.snapshot.tree, "saved")).toEqual(initial.children[0])
    for (const id of ["saved", "saved-child", "inactive-child"])
      expect(structuralNodes(view.snapshot.tree).filter((node) => node.id === id)).toHaveLength(1)
    expect(io.writeText).toHaveBeenCalledOnce()
  })

  it("renders native source and destination buttons with labels and tab stops", async () => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.render(cx)
    for (const id of ["saved", "anchor", "branch"]) {
      for (const [prefix, action] of [
        ["canvas-source", "source"],
        ["source-node", "source"],
        ["canvas-target", "destination"],
        ["target-node", "destination"],
      ]) {
        const buttonId = `${prefix}-${id}`
        expect(Button.new).toHaveBeenCalledWith(buttonId)
        expect(ui.nodes.get(buttonId).props).toMatchObject({
          accessibility_label: `Select ${action} ${id}`,
          tab_stop: true,
          disabled: false,
        })
      }
    }
    dispatch("canvas-source-saved", "on_click", {}, cx)
    dispatch("canvas-target-anchor", "on_click", {}, cx)
    const rendered = view.render(cx)
    expect(uiText(rendered)).toContain("Source: saved")
    expect(uiText(rendered)).toContain("Destination: anchor")
    for (const side of sides) {
      expect(Button.new).toHaveBeenCalledWith(`place-node-${side}`)
      expect(ui.nodes.get(`place-node-${side}`).props).toMatchObject({
        accessibility_label: `Place saved ${side} of anchor`,
        tab_stop: true,
        disabled: false,
      })
    }
    expect(ui.nodes.get("choose-new-view").props).toMatchObject({
      accessibility_label: "Add new view",
      tab_stop: true,
      disabled: false,
    })
    dispatch("clear-node-source", "on_click", {}, cx)
    expect(view.nodeSource).toBeNull()
    view.render(cx)
    expect(ui.nodes.get("clear-node-source").props).toMatchObject({
      disabled: true,
      tab_stop: false,
    })
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("disables root sources but permits placement beside the root", async () => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.render(cx)
    for (const id of ["canvas-source-body", "source-node-body"]) {
      expect(ui.nodes.get(id).props).toMatchObject({ disabled: true, tab_stop: false })
      dispatch(id, "on_click", {}, cx)
      expect(view.nodeSource).toBeNull()
    }
    dispatch("drag-node-body", "on_mouse_down-left", pointer(), cx)
    expect(view.drag).toBeNull()
    for (const id of ["canvas-target-body", "target-node-body"]) {
      expect(ui.nodes.get(id).props).toMatchObject({ disabled: false, tab_stop: true })
      dispatch(id, "on_click", {}, cx)
      expect(view.nodeTarget).toBe("body")
    }
    await keyboardPlace(view, cx, "saved", "body", "left")
    expectPlacement(view.snapshot.tree, "saved", "body", "left")
    expect(io.writeText).toHaveBeenCalledOnce()
  })

  it.each(sides)("suppresses a %s no-op write for pointer and keyboard placement", async (side) => {
    const initial = ordinaryTree()
    const saved = initial.children[0]
    const anchor = findNode(initial, "anchor")
    initial.type = side === "left" || side === "right" ? "row" : "column"
    initial.children = side === "left" || side === "top" ? [saved, anchor] : [anchor, saved]
    const { view, cx, io } = await ready("example", initial)
    const snapshot = view.snapshot
    begin(view, cx, "node", "saved")
    drop(view, cx, nodeDrop("anchor", side))
    expectClearedDrag(view)
    await cx.flush()
    await keyboardPlace(view, cx, "saved", "anchor", side)
    expect(view.snapshot).toBe(snapshot)
    expect(view.notice).toBe("No layout change.")
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["node", "new"])(
    "uses window coordinates, not local coordinates, for %s threshold",
    async (kind) => {
      const { view, cx, io } = await ready("example", ordinaryTree())
      const source = kind === "node" ? "saved" : "example"
      const event = (x, y, localX) => ({ ...pointer(x, y), local_position: { x: localX, y: 0 } })
      view.startDrag(kind, source, event(100, 100, 0), cx)
      view.hoverDrop(nodeDrop("anchor", "top"), event(103, 103, 500), cx)
      expect(view.drag.active).toBe(false)
      expect(view.dropPlacement).toBeNull()
      view.finishDrop(nodeDrop("anchor", "top"), event(103, 103, 500), cx)
      await cx.flush()
      expect(io.writeText).not.toHaveBeenCalled()
      view.startDrag(kind, source, event(100, 100, 20), cx)
      view.hoverDrop(nodeDrop("anchor", "top"), event(103, 104, 20), cx)
      expect(view.drag.active).toBe(true)
      expect(view.dropPlacement).toEqual({ id: "anchor", side: "top" })
      view.finishDrop(nodeDrop("anchor", "top"), event(103, 104, 20), cx)
      view.finishDrop(nodeDrop("body", "left"), event(103, 104, 20), cx)
      expectClearedDrag(view)
      await cx.flush()
      expect(io.writeText).toHaveBeenCalledOnce()
      expectPlacement(
        view.snapshot.tree,
        kind === "node" ? "saved" : "view-example",
        "anchor",
        "top",
      )
    },
  )

  it("shows exact hover feedback and clears invalid or exited targets", async () => {
    vi.mocked(theme).mockReturnValue({ selected: "selected", accent: "accent" })
    const { view, cx, io } = await ready("example", ordinaryTree(true))
    view.render(cx)
    begin(view, cx, "node", "saved")
    dispatch("drop-node-anchor-left", "on_mouse_move", pointer(20, 10), cx)
    expect(view.nodeTarget).toBe("anchor")
    expect(view.dropTarget).toBe(nodeDrop("anchor", "left").key)
    expect(view.dropPlacement).toEqual({ id: "anchor", side: "left" })
    expect(uiText(view.render(cx))).toContain("Drop left of anchor")
    expect(ui.nodes.get("drop-node-anchor-left").props.bg).toBe("selected")
    cx.notify.mockClear()
    dispatch("drop-node-anchor-left", "on_mouse_move", pointer(30, 10), cx)
    expect(cx.notify).not.toHaveBeenCalled()
    dispatch("drop-node-saved-child-right", "on_mouse_move", pointer(30, 10), cx)
    expect(view.dropPlacement).toBeNull()
    expect(view.dropTarget).toBeNull()
    expect(view.drag.active).toBe(true)
    dispatch("outline-drop-node-anchor-bottom", "on_mouse_move", pointer(30, 10), cx)
    expect(view.dropTarget).toBe(nodeDrop("anchor", "bottom", true).key)
    dispatch("outline-drop-node-anchor-bottom", "on_hover", false, cx)
    expect(view.dropTarget).toBeNull()
    expect(view.dropPlacement).toBeNull()
    expect(view.drag.active).toBe(true)
    expect(io.writeText).not.toHaveBeenCalled()
  })

  // Synthetic forwarding checks the handler contract, not physical native dispatch.
  it.each(["valid", "self", "descendant"])(
    "stops %s child targets before synthetic ancestor handling",
    async (target) => {
      const { view, cx, io } = await ready("example", ordinaryTree(true))
      view.render(cx)
      begin(view, cx, "node", "saved")
      const id = target === "valid" ? "anchor" : target === "self" ? "saved" : "saved-child"
      for (const handler of ["on_mouse_move", "on_mouse_up-left"]) {
        const parent = ui.nodes.get("drop-node-body-left")
        const ancestor = vi.fn(parent.handlers[handler])
        parent.handlers[handler] = ancestor
        cx.stop_propagation.mockClear()
        dispatch(`drop-node-${id}-right`, handler, pointer(20, 10), cx)
        if (!cx.stop_propagation.mock.calls.length)
          dispatch("drop-node-body-left", handler, pointer(20, 10), cx)
        expect(cx.stop_propagation).toHaveBeenCalled()
        expect(ancestor).not.toHaveBeenCalled()
        if (handler === "on_mouse_move")
          expect(view.dropPlacement).toEqual(
            target === "valid" ? { id: "anchor", side: "right" } : null,
          )
      }
      expectClearedDrag(view)
      await cx.flush()
      expect(io.writeText).toHaveBeenCalledTimes(target === "valid" ? 1 : 0)
      if (target === "valid") expectPlacement(view.snapshot.tree, "saved", "anchor", "right")
    },
  )

  it.each(sides)("produces identical pointer and keyboard moves on the %s side", async (side) => {
    const p = await ready("example", ordinaryTree(true))
    const k = await ready("example", ordinaryTree(true))
    p.view.render(p.cx)
    dispatch("drag-node-saved", "on_mouse_down-left", pointer(), p.cx)
    dispatch(`drop-node-anchor-${side}`, "on_mouse_up-left", pointer(20, 10), p.cx)
    await p.cx.flush()
    await keyboardPlace(k.view, k.cx, "saved", "anchor", side)
    expect(k.view.snapshot.tree).toEqual(p.view.snapshot.tree)
    expect(k.io.writeText.mock.calls).toEqual(p.io.writeText.mock.calls)
    expect(k.view.nodeSource).toEqual({ kind: "node", id: "saved" })
    expect(k.view.nodeTarget).toBe("anchor")
  })

  it.each(sides)(
    "adds duplicate-name inventory instances %s with identical pointer and keyboard results",
    async (side) => {
      const p = await ready("example", ordinaryTree())
      const k = await ready("example", ordinaryTree())
      for (const [fixture, method] of [
        [p, "pointer"],
        [k, "keyboard"],
      ]) {
        const { view, cx, io } = fixture
        const original = structuredClone(view.snapshot.tree)
        view.properties.set_value('{"draft":"new only"}')
        for (let count = 1; count <= 2; count += 1) {
          view.render(cx)
          if (method === "pointer") {
            dispatch("drag-new-mod-example", "on_mouse_down-left", pointer(), cx)
            expect(view.drag).toMatchObject({ kind: "new", name: "example" })
            expect(view.drag).not.toHaveProperty("id")
            dispatch(`drop-node-anchor-${side}`, "on_mouse_up-left", pointer(20, 10), cx)
          } else {
            dispatch("choose-new-view", "on_click", {}, cx)
            dispatch("target-node-anchor", "on_click", {}, cx)
            view.render(cx)
            dispatch(`place-node-${side}`, "on_click", {}, cx)
          }
          await cx.flush()
          expectClearedDrag(view)
          const blocks = structuralNodes(view.snapshot.tree).filter(
            (node) => node.content?.mod === "example",
          )
          expect(blocks).toHaveLength(2 + count)
          expect(new Set(blocks.map((node) => node.id)).size).toBe(blocks.length)
          expectPlacement(
            view.snapshot.tree,
            count === 1 ? "view-example" : "view-example-1",
            "anchor",
            side,
          )
          for (const block of blocks.filter((node) => !["anchor", "same-name"].includes(node.id)))
            expect(block.content.props).toEqual({ draft: "new only" })
          for (const id of ["anchor", "same-name"])
            expect(findNode(view.snapshot.tree, id)).toEqual(findNode(original, id))
          expect(view.snapshot.slots).toEqual([])
          expect(io.writeText).toHaveBeenCalledTimes(count)
        }
      }
      expect(p.view.snapshot.tree).toEqual(k.view.snapshot.tree)
      expect(p.io.writeText.mock.calls).toEqual(k.io.writeText.mock.calls)
    },
  )

  it("uses a stored new-view draft instead of a different selected mod's invalid draft", async () => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.properties.set_value('{"stored":true}')
    view.selectNewView("example", cx)
    view.mods.push({ name: "other", title: "Other", available: true })
    view.selectMod("other", cx)
    view.properties.set_value("invalid unrelated draft")
    view.render(cx)
    dispatch("target-node-anchor", "on_click", {}, cx)
    view.render(cx)
    dispatch("place-node-top", "on_click", {}, cx)
    await cx.flush()
    expect(findNode(view.snapshot.tree, "view-example").content.props).toEqual({ stored: true })
    expect(io.writeText).toHaveBeenCalledOnce()
  })

  it.each(["[]", "null", "invalid JSON"])(
    "rejects new-view draft %s on pointer and keyboard paths",
    async (draft) => {
      const { view, cx, io } = await ready("example", ordinaryTree())
      const snapshot = view.snapshot
      view.properties.set_value(draft)
      view.render(cx)
      dispatch("drag-new-mod-example", "on_mouse_down-left", pointer(), cx)
      dispatch("drop-node-anchor-top", "on_mouse_move", pointer(20, 10), cx)
      expect(view.dropTarget).toBeNull()
      dispatch("drop-node-anchor-top", "on_mouse_up-left", pointer(20, 10), cx)
      expectClearedDrag(view)
      dispatch("choose-new-view", "on_click", {}, cx)
      dispatch("target-node-anchor", "on_click", {}, cx)
      view.render(cx)
      expect(view.ordinaryError(view.nodeSource, "anchor", "top")).not.toBe("")
      for (const side of sides) {
        expect(ui.nodes.get(`place-node-${side}`).props).toMatchObject({
          disabled: true,
          tab_stop: false,
        })
        dispatch(`place-node-${side}`, "on_click", {}, cx)
      }
      await cx.flush()
      expect(view.error).not.toBe("")
      expect(view.snapshot).toBe(snapshot)
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it("revalidates a cached new-view target after its props become invalid without rerendering", async () => {
    vi.mocked(theme).mockReturnValue({ accent: "accent" })
    const { view, cx, io } = await ready("example", ordinaryTree())
    const snapshot = view.snapshot
    view.properties.set_value('{"valid":true}')
    view.render(cx)
    dispatch("drag-new-mod-example", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-node-anchor-top", "on_mouse_move", pointer(20, 10), cx)
    view.render(cx)
    expect(view.renderTargets.get("anchor")).toBe(true)
    expect(ui.nodes.get("drop-node-anchor-top").props.border_color).toBe("accent")
    view.properties.set_value("invalid JSON")
    dispatch("drop-node-anchor-top", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expectClearedDrag(view)
    expect(view.snapshot).toBe(snapshot)
    expect(view.needsRefresh).toBe(false)
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["self", "descendant", "missing source", "missing destination"])(
    "shares pointer and keyboard validation for %s",
    async (invalid) => {
      const { view, cx, io } = await ready("example", ordinaryTree(true))
      const source = { kind: "node", id: invalid === "missing source" ? "gone" : "saved" }
      const id =
        invalid === "self"
          ? "saved"
          : invalid === "descendant"
            ? "saved-child"
            : invalid === "missing destination"
              ? "gone"
              : "anchor"
      const error = view.ordinaryError(source, id, "left")
      expect(error).not.toBe("")
      begin(view, cx, "node", "saved")
      if (invalid === "missing source") view.drag.id = "gone"
      drop(view, cx, nodeDrop(id, "left"))
      expectClearedDrag(view)
      view.nodeSource = source
      view.nodeTarget = id
      view.render(cx)
      expect(ui.nodes.get("place-node-left").props).toMatchObject({
        disabled: true,
        tab_stop: false,
      })
      dispatch("place-node-left", "on_click", {}, cx)
      await cx.flush()
      expect(view.error).toBe(error)
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )
})

describe("ordinary tree save guards and cancellation", () => {
  it.each(["shipped", "loading", "busy", "needsRefresh", "closed"])(
    "blocks ordinary source selection, buttons, and drags while %s",
    async (state) => {
      const { view, cx, io } = await ready("example", ordinaryTree())
      const target = view.nodeTarget
      if (state === "shipped") view.snapshot.shipped = true
      else view[state] = true
      view.render(cx)
      for (const id of [
        "canvas-source-saved",
        "source-node-saved",
        "canvas-target-anchor",
        "target-node-anchor",
        "choose-new-view",
        "place-node-top",
      ]) {
        expect(ui.nodes.get(id).props).toMatchObject({ disabled: true, tab_stop: false })
        dispatch(id, "on_click", {}, cx)
      }
      for (const [kind, name] of [
        ["node", "saved"],
        ["new", "example"],
      ]) {
        begin(view, cx, kind, name)
        drop(view, cx, nodeDrop("anchor", "top"))
        expectClearedDrag(view)
        view.placeOrdinary(cx, { kind, id: name, name }, "anchor", "top")
      }
      await cx.flush()
      expect(view.nodeSource).toBeNull()
      expect(view.nodeTarget).toBe(target)
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it.each(["shipped", "loading", "busy", "needsRefresh", "closed"])(
    "rechecks %s after a gesture has started",
    async (state) => {
      const { view, cx, io } = await ready("example", ordinaryTree())
      begin(view, cx, "node", "saved")
      if (state === "shipped") view.snapshot.shipped = true
      else view[state] = true
      drop(view, cx, nodeDrop("anchor", "top"))
      await cx.flush()
      expectClearedDrag(view)
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it.each(["pointer", "keyboard"])(
    "rejects stale %s saves without retrying until Refresh",
    async (method) => {
      const { view, cx, io, files } = await ready("example", ordinaryTree())
      const snapshot = view.snapshot
      const external = `${snapshot.raw}\n`
      files.set(snapshot.path, external)
      const place = async () => {
        if (method === "pointer") {
          begin(view, cx, "node", "saved")
          drop(view, cx, nodeDrop("anchor", "top"))
          await cx.flush()
        } else await keyboardPlace(view, cx, "saved", "anchor", "top")
      }
      await place()
      expect(view.needsRefresh).toBe(true)
      expect(view.error).toContain("Refresh")
      expect(view.snapshot).toBe(snapshot)
      expect(files.get(snapshot.path)).toBe(external)
      expectClearedDrag(view)
      await place()
      expect(io.writeText).toHaveBeenCalledExactlyOnceWith(
        snapshot.path,
        expect.any(String),
        snapshot.raw,
      )
      view.refresh(cx)
      await cx.flush()
      expect(view.needsRefresh).toBe(false)
      expect(view.snapshot.raw).toBe(external)
      await place()
      expect(io.writeText).toHaveBeenCalledTimes(2)
      expect(io.writeText.mock.calls[1][2]).toBe(external)
      expectPlacement(view.snapshot.tree, "saved", "anchor", "top")
    },
  )

  it.each(["pointer", "keyboard"])(
    "rejects a layout switch before a %s save without writing either file",
    async (method) => {
      const { view, cx, io, files, changeLayout } = await ready("example", ordinaryTree())
      const original = new Map(files)
      view.render(cx)
      if (method === "pointer") begin(view, cx, "node", "saved")
      else {
        dispatch("source-node-saved", "on_click", {}, cx)
        dispatch("target-node-anchor", "on_click", {}, cx)
        view.render(cx)
      }
      changeLayout("different")
      if (method === "pointer") drop(view, cx, nodeDrop("anchor", "top"))
      else dispatch("place-node-top", "on_click", {}, cx)
      await cx.flush()
      expect(io.writeText).not.toHaveBeenCalled()
      expect(files).toEqual(original)
      expect(view.error).toContain("current layout changed")
      expect(view.needsRefresh).toBe(true)
      expectClearedDrag(view)
    },
  )

  it("keeps an in-flight write on its captured file and clears selection after a layout switch", async () => {
    const { view, cx, io, files, changeLayout } = await ready("example", ordinaryTree())
    const snapshot = view.snapshot
    files.set("/fixture/layouts/different.json", JSON.stringify(tree))
    const paused = pauseWrite(io)
    begin(view, cx, "node", "saved")
    drop(view, cx, nodeDrop("anchor", "top"))
    await paused.started
    expectClearedDrag(view)
    expect(view.busy).toBe(true)
    changeLayout("different")
    paused.release()
    await cx.flush()
    expect(io.writeText).toHaveBeenCalledExactlyOnceWith(
      snapshot.path,
      view.snapshot.raw,
      snapshot.raw,
    )
    expect(files.get("/fixture/layouts/different.json")).toBe(JSON.stringify(tree))
    expect(view.nodeSource).toBeNull()
    expect(view.nodeTarget).toBeNull()
    view.render(cx)
    await cx.flush()
    expect(view.snapshot.name).toBe("different")
    expect(view.nodeSource).toBeNull()
    expect(view.nodeTarget).toBe("original")
  })

  it.each(["success", "stale failure"])(
    "does not publish %s save results or notify after an async close",
    async (outcome) => {
      const { view, cx, io, files } = await ready("example", ordinaryTree())
      const snapshot = view.snapshot
      const mods = view.mods
      const paused = pauseWrite(io)
      begin(view, cx, "node", "saved")
      drop(view, cx, nodeDrop("anchor", "top"))
      await paused.started
      const external = `${snapshot.raw}\n`
      if (outcome === "stale failure") files.set(snapshot.path, external)
      view.close()
      cx.notify.mockClear()
      for (const task of cx.asyncContexts) task.notify.mockClear()
      paused.release()
      await cx.flush()
      expect(io.writeText).toHaveBeenCalledOnce()
      if (outcome === "stale failure") expect(files.get(snapshot.path)).toBe(external)
      else expect(files.get(snapshot.path)).not.toBe(snapshot.raw)
      expect(view.snapshot).toBe(snapshot)
      expect(view.mods).toBe(mods)
      expect(view.notice).toBe("")
      expect(view.error).toBe("")
      expect(view.closed).toBe(true)
      expect(view.nodeSource).toBeNull()
      expect(view.nodeTarget).toBeNull()
      expectClearedDrag(view)
      expect(cx.notify).not.toHaveBeenCalled()
      for (const task of cx.asyncContexts) expect(task.notify).not.toHaveBeenCalled()
    },
  )

  it.each(["node", "new"])(
    "reconciles valid %s selection after save and same-layout refresh",
    async (kind) => {
      const { view, cx } = await ready("example", ordinaryTree())
      if (kind === "node") view.selectNodeSource("saved", cx)
      else view.selectNewView("example", cx)
      view.selectNodeTarget("anchor", cx)
      const source = { ...view.nodeSource }
      view.placeOrdinary(cx, source, "anchor", "top")
      await cx.flush()
      expect(view.nodeSource).toEqual(source)
      expect(view.nodeTarget).toBe("anchor")
      view.refresh(cx)
      await cx.flush()
      expect(view.nodeSource).toEqual(source)
      expect(view.nodeTarget).toBe("anchor")
    },
  )

  it("reconciles source and target IDs removed externally on Refresh", async () => {
    const { view, cx, io, files } = await ready("example", ordinaryTree())
    view.selectNodeSource("saved", cx)
    view.selectNodeTarget("anchor", cx)
    const external = ordinaryTree()
    external.children.shift()
    external.children[0].children.shift()
    files.set(view.snapshot.path, JSON.stringify(external))
    view.refresh(cx)
    await cx.flush()
    expect(view.nodeSource).toBeNull()
    expect(view.nodeTarget).toBe("body")
    expect(view.snapshot.tree).toEqual(external)
    view.nodeSource = { kind: "node", id: "gone" }
    view.nodeTarget = "gone"
    view.reconcileNodes()
    expect(view.nodeSource).toBeNull()
    expect(view.nodeTarget).toBe("body")
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("clears a new-view selection if its inventory entry becomes unavailable", async () => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.selectNewView("example", cx)
    io.list = async () => []
    view.refresh(cx)
    await cx.flush()
    expect(view.nodeSource).toBeNull()
    view.selectNewView("example", cx)
    begin(view, cx, "new", "example")
    expect(view.nodeSource).toBeNull()
    expectClearedDrag(view)
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("clears node selections immediately when Refresh changes the layout name", async () => {
    const { view, cx, io, files, changeLayout } = await ready("example", ordinaryTree())
    begin(view, cx, "node", "saved")
    view.hoverDrop(nodeDrop("anchor", "top"), pointer(20, 10), cx)
    files.set("/fixture/layouts/different.json", JSON.stringify(tree))
    changeLayout("different")
    view.refresh(cx)
    expectClearedDrag(view)
    expect(view.nodeSource).toBeNull()
    expect(view.nodeTarget).toBeNull()
    await cx.flush()
    expect(view.nodeTarget).toBe("original")
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each([
    ["on_mouse_up-left", pointer()],
    ["on_mouse_down-left", pointer()],
    ["on_mouse_down_out", pointer()],
    ["on_hover", false],
    ["on_key_down", { key: "escape" }],
  ])("cancels ordinary feedback on root %s without a write", async (handler, event) => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.render(cx)
    dispatch("drag-node-saved", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-node-anchor-top", "on_mouse_move", pointer(20, 10), cx)
    expect(view.dropPlacement).toEqual({ id: "anchor", side: "top" })
    dispatch("layout-manager", handler, event, cx)
    expectClearedDrag(view)
    if (handler === "on_key_down") expect(view.nodeSource).toBeNull()
    view.finishDrop(nodeDrop("anchor", "top"), pointer(20, 10), cx)
    await cx.flush()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("cancels a keyboard-only source with Escape", async () => {
    const { view, cx, io } = await ready("example", ordinaryTree())
    view.render(cx)
    dispatch("source-node-saved", "on_click", {}, cx)
    dispatch("layout-manager", "on_key_down", { key: "escape" }, cx)
    expect(view.nodeSource).toBeNull()
    expect(cx.stop_propagation).toHaveBeenCalled()
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["refresh", "close", "clear-node-source"])(
    "cancels active ordinary placement on %s",
    async (action) => {
      const { view, cx, io } = await ready("example", ordinaryTree())
      view.render(cx)
      begin(view, cx, "new", "example")
      view.hoverDrop(nodeDrop("anchor", "top"), pointer(20, 10), cx)
      if (action === "close") view.close()
      else dispatch(action, "on_click", {}, cx)
      expectClearedDrag(view)
      if (action !== "refresh") expect(view.nodeSource).toBeNull()
      view.finishDrop(nodeDrop("anchor", "top"), pointer(20, 10), cx)
      await cx.flush()
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )
})

describe("ordinary outline and legacy boundaries", () => {
  it("keeps ordinary canvas IDs distinct from managed card IDs", async () => {
    const body = ordinaryTree()
    body.children.push({
      id: "tab-example",
      type: "block",
      content: { mod: "missing", props: { ordinary: true } },
    })
    const initial = addPanel(body, { name: "example", props: { managed: true } })
    const { view, cx, io } = await ready("example", initial)
    view.render(cx)
    const ordinary = ui.nodes.get("preview-node-tab-example")
    const managed = ui.nodes.get("preview-tab-example")
    expect(ordinary).toBeDefined()
    expect(managed).toBeDefined()
    expect(ordinary).not.toBe(managed)
    dispatch("drag-node-tab-example", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-node-anchor-top", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expect(findNode(view.snapshot.tree, "tab-example")).toEqual(body.children.at(-1))
    expect(view.snapshot.slots).toEqual(managedSlots(initial))
    expect(io.writeText).toHaveBeenCalledOnce()
  })

  it("keeps deep, hidden, small, and inactive stack nodes selectable in the outline", async () => {
    const initial = ordinaryTree(true)
    let deep = {
      id: "deep-small",
      type: "block",
      hidden: true,
      size: { px: 1 },
      content: { mod: "missing" },
    }
    for (let depth = 6; depth >= 1; depth -= 1)
      deep = { id: `depth-${depth}`, type: "column", children: [deep] }
    initial.children.push(deep)
    const { view, cx, io } = await ready("example", initial)
    view.render(cx)
    // The proxy records argument-free scroll methods as own property keys.
    expect(
      Object.hasOwn(ui.nodes.get("layout-manager-outline").props, "overflow_y_scrollbar"),
    ).toBe(true)
    for (const id of ["deep-small", "depth-6", "inactive-child", "saved-child"]) {
      expect(ui.nodes.has(`outline-node-${id}`)).toBe(true)
      expect(ui.nodes.get(`source-node-${id}`).props).toMatchObject({
        disabled: false,
        tab_stop: true,
      })
      expect(ui.nodes.get(`target-node-${id}`).props).toMatchObject({
        disabled: false,
        tab_stop: true,
      })
      dispatch(`source-node-${id}`, "on_click", {}, cx)
      expect(view.nodeSource).toEqual({ kind: "node", id })
      dispatch(`target-node-${id}`, "on_click", {}, cx)
      expect(view.nodeTarget).toBe(id)
      for (const side of sides) expect(ui.nodes.has(`outline-drop-node-${id}-${side}`)).toBe(true)
    }
    expect(findNode(view.snapshot.tree, "saved").active).toBe("saved-child")
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it("never exposes opaque pane, content, props, or headers as sources or targets", async () => {
    const initial = ordinaryTree(true)
    const opaque = (id) => ({ id, type: "block", content: { mod: "example" } })
    initial.children[0].header = { children: [opaque("stack-header")] }
    initial.floating = [opaque("floating-content")]
    initial.children[2].content = {
      tab: "active",
      layout: opaque("pane-layout"),
      header: opaque("pane-header"),
      children: [opaque("content-child")],
    }
    initial.children[1].children[0].content.props = { children: [opaque("props-child")] }
    const { view, cx, io } = await ready("example", initial)
    const snapshot = view.snapshot
    view.render(cx)
    for (const id of [
      "stack-header",
      "pane-layout",
      "pane-header",
      "content-child",
      "props-child",
      "floating-content",
    ]) {
      for (const prefix of [
        "drag-node",
        "source-node",
        "target-node",
        "canvas-source",
        "canvas-target",
        "outline-node",
      ])
        expect(ui.nodes.has(`${prefix}-${id}`)).toBe(false)
      for (const side of sides) {
        expect(ui.nodes.has(`drop-node-${id}-${side}`)).toBe(false)
        expect(ui.nodes.has(`outline-drop-node-${id}-${side}`)).toBe(false)
      }
      view.selectNodeSource(id, cx)
      expect(view.nodeSource).toBeNull()
      view.selectNodeTarget(id, cx)
      expect(view.nodeTarget).toBe("body")
      expect(view.ordinaryError({ kind: "node", id: "saved" }, id, "left")).not.toBe("")
    }
    expect(view.snapshot).toBe(snapshot)
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["node", "new"])("rejects ordinary %s sources on all legacy targets", async (kind) => {
    const initial = addPanel(ordinaryTree(), { name: "example" })
    const { view, cx, io } = await ready("example", initial)
    for (const target of [edge("left"), tab("example"), tab(), removeTarget]) {
      begin(view, cx, kind, kind === "node" ? "saved" : "example")
      drop(view, cx, target)
      expectClearedDrag(view)
    }
    await cx.flush()
    expect(view.snapshot.tree).toEqual(initial)
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it.each(["mod", "dock"])(
    "rejects legacy %s sources on ordinary canvas and outline targets",
    async (kind) => {
      const initial = addPanel(ordinaryTree(), { name: "example" })
      const { view, cx, io } = await ready("example", initial)
      view.render(cx)
      for (const prefix of ["", "outline-"]) {
        begin(view, cx, kind, kind === "mod" ? "example" : null)
        dispatch(`${prefix}drop-node-anchor-left`, "on_mouse_move", pointer(20, 10), cx)
        expect(view.dropPlacement).toBeNull()
        dispatch(`${prefix}drop-node-anchor-left`, "on_mouse_up-left", pointer(20, 10), cx)
        expectClearedDrag(view)
      }
      await cx.flush()
      expect(view.snapshot.tree).toEqual(initial)
      expect(io.writeText).not.toHaveBeenCalled()
    },
  )

  it("keeps managed slots outside ordinary selection and preserves the dock during body placement", async () => {
    const initial = addPanel(ordinaryTree(), { name: "example", props: { managed: true } })
    const { view, cx, io } = await ready("example", initial)
    const dock = structuredClone(findNode(initial, "layout-manager-dock"))
    view.render(cx)
    for (const id of [
      "layout-manager-frame",
      "layout-manager-dock",
      STACK_ID,
      "layout-manager-mod-example",
    ]) {
      expect(ui.nodes.has(`source-node-${id}`)).toBe(false)
      expect(ui.nodes.has(`target-node-${id}`)).toBe(false)
      view.selectNodeSource(id, cx)
      expect(view.nodeSource).toBeNull()
      begin(view, cx, "node", id)
      expect(view.drag).toBeNull()
      expect(view.ordinaryError({ kind: "node", id }, "anchor", "left")).not.toBe("")
    }
    await keyboardPlace(view, cx, "saved", "body", "left")
    expect(view.snapshot.tree.id).toBe("layout-manager-frame")
    expect(findNode(view.snapshot.tree, "layout-manager-dock")).toEqual(dock)
    expectPlacement(view.snapshot.tree, "saved", "body", "left")
    view.properties.set_value('{"ordinary":true}')
    view.render(cx)
    dispatch("drag-new-mod-example", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-node-anchor-top", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expect(findNode(view.snapshot.tree, "layout-manager-dock")).toEqual(dock)
    expect(view.snapshot.slots).toEqual(managedSlots(initial))
    expect(findNode(view.snapshot.tree, "view-example").content.props).toEqual({ ordinary: true })
    view.render(cx)
    dispatch("drag-mod-example", "on_mouse_down-left", pointer(), cx)
    dispatch("drop-bottom", "on_mouse_up-left", pointer(20, 10), cx)
    await cx.flush()
    expect(dockPosition(view.snapshot.tree)).toBe("bottom")
    expect(findNode(view.snapshot.tree, "view-example").content.props).toEqual({ ordinary: true })
    expect(io.writeText).toHaveBeenCalledTimes(3)
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
