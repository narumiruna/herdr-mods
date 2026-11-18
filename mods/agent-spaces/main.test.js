import {
  agents,
  checking,
  exec,
  hc,
  window as hostWindow,
  layout,
  machines,
  openOverlay,
  panes,
  run,
  setShared,
  shared,
  spaces,
  theme,
  watchFolder,
} from "herdr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Spaces, { glyph, tone } from "./main.js"

// Record builder calls, not native geometry. Elements can have only one parent.
const ui = vi.hoisted(() => {
  class Element {
    constructor(type, asset) {
      this.type = type
      this.asset = asset
      this.props = {}
      this.items = []
      this.handlers = {}
      this.parented = false
    }

    available() {
      if (this.parented) throw new Error("Cannot change an attached element")
    }

    child(child) {
      this.available()
      if (child instanceof Element) {
        child.available()
        child.parented = true
      } else if (typeof child !== "string") {
        throw new Error("Expected an element or text child")
      }
      this.items.push(child)
      return this
    }

    children(children) {
      for (const child of children) this.child(child)
      return this
    }

    when(condition, branch) {
      this.available()
      return condition ? branch(this) : this
    }
  }

  for (const name of [
    "absolute",
    "bg",
    "border",
    "border_1",
    "border_color",
    "bottom",
    "cursor_pointer",
    "flex",
    "flex_1",
    "flex_auto",
    "flex_initial",
    "flex_none",
    "font_bold",
    "gap",
    "h",
    "hover",
    "id",
    "items_center",
    "justify_between",
    "justify_center",
    "justify_end",
    "left",
    "max_w",
    "min_h",
    "min_w",
    "mode",
    "mt",
    "mx",
    "opacity",
    "overflow_hidden",
    "overflow_y_scrollbar",
    "pb",
    "pl",
    "pr",
    "px",
    "py",
    "relative",
    "right",
    "rounded",
    "size",
    "size_full",
    "spin",
    "text_color",
    "text_size",
    "tooltip",
    "top",
    "track_scroll",
    "truncate",
    "w",
  ]) {
    Object.defineProperty(Element.prototype, name, {
      value(...args) {
        this.available()
        this.props[name] = args.length ? args[0] : true
        return this
      },
    })
  }
  for (const name of [
    "on_click",
    "on_mouse_down",
    "on_mouse_move",
    "on_mouse_up",
    "on_size_change",
  ]) {
    Object.defineProperty(Element.prototype, name, {
      value(...args) {
        this.available()
        const key = args.length === 2 ? `${name}:${args[0]}` : name
        this.handlers[key] = args.at(-1)
        return this
      },
    })
  }
  return { element: (type, asset) => new Element(type, asset) }
})

vi.mock("gpui-kit", () => ({
  View: class {},
  div: () => ui.element("div"),
  image: (asset) => ui.element("image", asset),
  svg: (asset) => ui.element("svg", asset),
}))
vi.mock("gpui-base", () => ({
  h_flex: () => ui.element("row"),
  v_flex: () => ui.element("column"),
  ScrollHandle: { new: vi.fn(() => ({ scroll_to_item: vi.fn(), release: vi.fn() })) },
}))
vi.mock("herdr", () => {
  const forbidden = (operation) =>
    vi.fn(() => {
      throw new Error(`Unexpected live I/O: ${operation}`)
    })
  return {
    agents: vi.fn(),
    checking: vi.fn(),
    spaces: vi.fn(),
    machines: vi.fn(),
    panes: vi.fn(),
    run: vi.fn(),
    openOverlay: vi.fn(),
    exec: forbidden("exec"),
    hc: forbidden("hc"),
    watchFolder: forbidden("watchFolder"),
    theme: vi.fn(),
    shared: vi.fn(),
    setShared: vi.fn(),
    window: vi.fn(),
    layout: vi.fn(),
  }
})

const t = {
  foreground: "#eeeeee",
  chrome: "#111111",
  selected: "#333333",
  hover: "#444444",
  border: "#555555",
  muted: "#aaaaaa",
  dim: "#888888",
  accent: "#0099ff",
  working: "#00ccff",
  blocked: "#ff9900",
  done: "#00bb66",
  idle: "#999999",
  unknown: "#777777",
  ansi1: "#bb2222",
  ansi2: "#22bb22",
  ansi3: "#bbbb22",
  ansi4: "#2222bb",
  ansi5: "#bb22bb",
  ansi6: "#22bbbb",
}

function space(id, overrides = {}) {
  return {
    id,
    name: "Project",
    folder: `/fixture/${id}`,
    machine: null,
    tabs: [],
    active: false,
    status: "idle",
    ...overrides,
  }
}

function agent(address, spaceId = "space-1", status = "idle", program = {}) {
  return { address, space: spaceId, status, program }
}

function context() {
  return {
    notify: vi.fn(),
    stop_propagation: vi.fn(),
    write_to_clipboard: vi.fn(),
    // Record tasks without executing Git, machine commands, or folder watches.
    spawn: vi.fn(),
    timer: { every: vi.fn(), after: vi.fn() },
  }
}

function fixture(entries = [space("space-1")]) {
  spaces.mockReturnValue(entries)
  const view = new Spaces()
  const cx = context()
  view.init({}, cx)
  return { view, cx }
}

function nodes(node) {
  return typeof node === "string" ? [] : [node, ...node.items.flatMap(nodes)]
}

function texts(node) {
  return typeof node === "string" ? [node] : node.items.flatMap(texts)
}

function byId(root, id) {
  const matches = nodes(root).filter((node) => node.props.id === id)
  expect(matches, `Expected one attached element: ${id}`).toHaveLength(1)
  return matches[0]
}

function hasId(root, id) {
  return nodes(root).some((node) => node.props.id === id)
}

function render(view) {
  const root = view.render()
  const ids = nodes(root)
    .map((node) => node.props.id)
    .filter(Boolean)
  expect(new Set(ids).size, "Rendered IDs must be unique").toBe(ids.length)
  return root
}

function fire(node, event, cx, button) {
  const key = button ? `${event}:${button}` : event
  expect(node.handlers[key], `Missing handler: ${key}`).toBeTypeOf("function")
  node.handlers[key]({}, cx)
}

function list(root) {
  return nodes(root).find((node) => node.props.overflow_y_scrollbar)
}

function tiles(root, id = "space-1") {
  return byId(root, `agents-${id}`).items[0].items
}

function spinner(root) {
  return nodes(root).filter((node) => node.asset === "mods/agent-spaces/icons/spinner.svg")
}

beforeEach(() => {
  vi.clearAllMocks()
  const storage = new Map()
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key) => storage.get(key) ?? null),
    setItem: vi.fn((key, value) => storage.set(key, value)),
  })
  const values = {}
  shared.mockImplementation((key) => values[key])
  setShared.mockImplementation((key, value) => {
    values[key] = value
  })
  agents.mockReturnValue([])
  checking.mockReturnValue(true)
  spaces.mockReturnValue([])
  machines.mockReturnValue([])
  panes.mockReturnValue([])
  theme.mockReturnValue(t)
  hostWindow.mockReturnValue({ active: true })
  layout.mockReturnValue({ id: "root", children: [{ id: "sidebar", size: { px: 240 } }] })
})

afterEach(() => {
  expect(exec).not.toHaveBeenCalled()
  expect(hc).not.toHaveBeenCalled()
  expect(watchFolder).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("single-use builder fixture", () => {
  it("rejects child reuse and edits after attachment", () => {
    const child = ui.element("div")
    ui.element("row").child(child)
    expect(() => ui.element("column").child(child)).toThrow("attached element")
    expect(() => child.bg(t.chrome)).toThrow("attached element")
  })
})

describe("expanded space activity", () => {
  it.each([160, 239, 240, 268])(
    "keeps agent summaries before Git details at sidebar width %i",
    (width) => {
      layout.mockReturnValue({ id: "sidebar", size: { px: width } })
      agents.mockReturnValue([agent("one", "space-1", "working")])
      const { view } = fixture()
      vi.spyOn(view, "ordered").mockReturnValue([
        {
          w: space("space-1"),
          i: 0,
          tree: null,
          g: { name: "repo", branch: "topic", ahead: 2, behind: 0 },
        },
      ])
      const root = render(view)

      expect(texts(byId(root, "space-space-1")).join(" ").includes("topic")).toBe(width >= 240)
      expect(texts(byId(root, "activity-space-1"))).toEqual(["1/1"])
    },
  )

  it("clips the flexible name and Git area without shrinking the right summary", () => {
    agents.mockReturnValue([agent("one", "space-1", "working")])
    const { view } = fixture()
    const root = render(view)
    const name = byId(root, "space-name-space-1")
    const middle = nodes(root).find((node) => node.items.includes(name))

    expect(middle.props).toMatchObject({ flex_1: true, min_w: 0, overflow_hidden: true })
    expect(byId(root, "activity-space-1").props.flex_none).toBe(true)
  })

  it("shows the working/total count and both tooltips for mixed agent states", () => {
    agents.mockReturnValue([
      agent("one", "space-1", "working", { name: "Claude" }),
      agent("two", "space-1", "idle", { name: "Codex" }),
      agent("three", "space-1", "blocked", { name: "Claude" }),
      agent("four", "space-1", "done", { name: "Codex" }),
    ])
    const { view } = fixture()
    const root = render(view)
    const badge = byId(root, "activity-space-1")
    const tooltip = "1/4 agents working\nClaude: working\nCodex: idle\nClaude: blocked\nCodex: done"

    expect(texts(badge)).toEqual(["1/4"])
    expect(badge.props.tooltip).toBe(tooltip)
    expect(byId(root, "agents-space-1").props.tooltip).toBe(tooltip)
    expect(spinner(badge)).toHaveLength(1)
    expect(spinner(badge)[0].props).toMatchObject({ spin: 900, text_color: t.working })
  })

  it.each([
    [["idle", "idle"], "idle"],
    [["idle", "done"], "done"],
    [["done", "blocked", "idle"], "blocked"],
  ])("shows a static ring for %j with %s priority", (statuses, status) => {
    agents.mockReturnValue(statuses.map((state, i) => agent(`terminal-${i}`, "space-1", state)))
    const { view } = fixture()
    const badge = byId(render(view), "activity-space-1")

    expect(texts(badge)).toEqual([`0/${statuses.length}`])
    expect(spinner(badge)).toHaveLength(0)
    expect(badge.items[1].type).toBe("div")
    expect(badge.items[1].props).toMatchObject({ border: 1.5, border_color: t[status] })
    expect(nodes(badge).some((node) => node.props.spin !== undefined)).toBe(false)
  })

  it.each([false, true])("keeps the normal avatar without agents (active=%s)", (active) => {
    agents.mockReturnValue([agent("edge/terminal", "edge/space-1", "working")])
    const { view } = fixture([space("space-1", { name: "Workbench", active })])
    const root = render(view)
    const row = byId(root, "space-space-1")

    expect(hasId(root, "activity-space-1")).toBe(false)
    expect(hasId(root, "agents-space-1")).toBe(false)
    expect(spinner(root)).toHaveLength(0)
    expect(texts(row)).toEqual(["W", "Workbench"])
    expect(byId(root, "space-name-space-1").props.tooltip).toBe("Workbench")
  })

  it("matches qualified IDs rather than equal local and remote space names", () => {
    agents.mockReturnValue([
      agent("terminal-1", "space-1", "working", { name: "Local" }),
      agent("edge/terminal-1", "edge/space-1", "blocked", { name: "Remote" }),
      agent("edge/terminal-2", "edge/space-1", "idle", { name: "Remote" }),
    ])
    const { view } = fixture([space("space-1"), space("edge/space-1", { machine: "edge" })])
    const root = render(view)

    expect(texts(byId(root, "activity-space-1"))).toEqual(["1/1"])
    expect(texts(byId(root, "activity-edge/space-1"))).toEqual(["0/2"])
    expect(tiles(root)).toHaveLength(1)
    expect(tiles(root, "edge/space-1")).toHaveLength(2)
    expect(byId(root, "agents-space-1").props.tooltip).not.toContain("Remote")
    expect(byId(root, "agents-edge/space-1").props.tooltip).not.toContain("Local")
  })

  it.each([1, 2, 3, 4, 8])("bounds %i agents to three tiles with exact +N", (total) => {
    const program = { name: "Codex", icon: "fixtures/codex.svg", tint: true }
    agents.mockReturnValue(
      Array.from({ length: total }, (_, i) => agent(`terminal-${i}`, "space-1", "idle", program)),
    )
    const { view } = fixture()
    const root = render(view)
    const icons = byId(root, "agents-space-1")
    const visible = tiles(root)
    const count = Math.min(total, 3)

    expect(visible).toHaveLength(count)
    expect(new Set(visible).size).toBe(count)
    expect(new Set(visible.map((tile) => tile.items[0])).size).toBe(count)
    // Check overlap builder arguments and reverse paint order, not native bounds.
    expect(visible.map((tile) => tile.props.left)).toEqual(
      Array.from({ length: count }, (_, i) => (count - i - 1) * 6),
    )
    expect(visible.map((tile) => tile.props.top)).toEqual(
      Array.from({ length: count }, (_, i) => (count - i - 1) * 2),
    )
    for (const tile of visible) {
      expect(tile.props).toMatchObject({ absolute: true, size: 18, bg: t.chrome })
      expect(tile.items[0].asset).toBe(program.icon)
    }
    expect(icons.items).toHaveLength(total > 3 ? 2 : 1)
    expect(texts(icons)).toEqual(total > 3 ? [`+${total - 3}`] : [])
    expect(texts(byId(root, "activity-space-1"))).toEqual([`0/${total}`])
  })

  it("keeps only the first three agents in the tiles and later agents in the tooltip", () => {
    agents.mockReturnValue(
      ["First", "Second", "Third", "Fourth"].map((name, i) =>
        agent(`terminal-${i}`, "space-1", "idle", { name, icon: `fixtures/${i}.png` }),
      ),
    )
    const { view } = fixture([space("space-1", { active: true })])
    const root = render(view)

    expect(tiles(root).map((tile) => tile.items[0].asset)).toEqual([
      "fixtures/2.png",
      "fixtures/1.png",
      "fixtures/0.png",
    ])
    expect(tiles(root).every((tile) => tile.props.bg === t.selected)).toBe(true)
    expect(byId(root, "agents-space-1").props.tooltip).toContain("Fourth: idle")
  })

  it("does not draw duplicate terminal records as extra icons or counts", () => {
    const first = agent("terminal-1", "space-1", "working", { name: "Codex" })
    agents.mockReturnValue([first, { ...first, status: "idle" }, agent("terminal-2")])
    const { view } = fixture()
    const root = render(view)

    expect(tiles(root)).toHaveLength(2)
    expect(texts(byId(root, "activity-space-1"))).toEqual(["1/2"])
  })

  it.each([
    [{ name: "codex" }, "Terminal", "C"],
    [{ name: "éclair", icon: "" }, "Terminal", "É"],
    [{ name: "🐍 Tools" }, undefined, "🐍"],
    [{ name: "" }, "terminal", "T"],
    [undefined, "terminal", "T"],
    [undefined, undefined, "?"],
  ])("uses a text fallback for program %j and app %s", (program, app, initial) => {
    agents.mockReturnValue([
      { address: "terminal", space: "space-1", status: "idle", program, app },
    ])
    const { view } = fixture()
    const icon = tiles(render(view))[0].items[0]

    expect(icon.type).toBe("div")
    expect(texts(icon)).toEqual([initial])
    expect(icon.props.text_color).toBe(t.foreground)
    expect(nodes(icon).some((node) => node.type === "image" || node.type === "svg")).toBe(false)
  })

  it.each([
    [true, "fixtures/program.svg", "svg"],
    [true, "fixtures/program.png", "svg"],
    [false, "fixtures/program.svg", "image"],
    [undefined, "fixtures/program.png", "image"],
  ])("uses program tint=%s, not file extension, for %s (%s)", (tint, asset, type) => {
    agents.mockReturnValue([agent("terminal", "space-1", "idle", { icon: asset, tint })])
    const { view } = fixture()
    const icon = tiles(render(view))[0].items[0]

    expect(icon.type).toBe(type)
    expect(icon.asset).toBe(asset)
    if (type === "svg") {
      expect(icon.props).toMatchObject({ size: 14, text_color: t.foreground })
    } else {
      expect(icon.props).toMatchObject({ w: 14, h: 14 })
      expect(icon.props.text_color).toBeUndefined()
    }
  })

  it("updates additions, working transitions, and removals from each live agent snapshot", () => {
    const { view, cx } = fixture()
    const snapshots = [
      { members: [], count: null, spins: 0 },
      { members: [agent("one")], count: "0/1", spins: 0 },
      { members: [agent("one", "space-1", "working"), agent("two")], count: "1/2", spins: 1 },
      { members: [agent("one", "space-1", "blocked"), agent("two")], count: "0/2", spins: 0 },
      { members: [agent("one", "space-1", "done")], count: "0/1", spins: 0 },
      { members: [], count: null, spins: 0 },
    ]
    for (const { members, count, spins } of snapshots) {
      agents.mockReturnValue(members)
      const root = render(view)
      expect(hasId(root, "activity-space-1")).toBe(count !== null)
      expect(hasId(root, "agents-space-1")).toBe(count !== null)
      if (count) expect(texts(byId(root, "activity-space-1"))).toEqual([count])
      expect(spinner(root)).toHaveLength(spins)
    }
    expect(agents).toHaveBeenCalledTimes(snapshots.length)
    expect(cx.timer.every).not.toHaveBeenCalled()
    expect(cx.timer.after).not.toHaveBeenCalled()
  })

  it("uses native spin without adding an agent polling timer to the existing Git/machine timers", () => {
    vi.useFakeTimers()
    checking.mockReturnValue(false)
    agents.mockReturnValue([agent("terminal", "space-1", "working")])
    const { view, cx } = fixture()

    expect(cx.timer.every.mock.calls.map(([delay]) => delay)).toEqual([15000, 250])
    expect(agents).not.toHaveBeenCalled()
    const root = render(view)
    expect(spinner(root)[0].props.spin).toBe(900)
    // Fire only the existing refresh callbacks. Their spawn bodies remain isolated.
    for (const [, refresh] of cx.timer.every.mock.calls) refresh(cx)
    expect(agents).toHaveBeenCalledTimes(1)
    cx.notify.mockClear()
    vi.advanceTimersByTime(5000)
    expect(agents).toHaveBeenCalledTimes(1)
    expect(cx.notify).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    render(view)
    expect(cx.timer.every).toHaveBeenCalledTimes(2)
    expect(cx.timer.after).not.toHaveBeenCalled()
  })
})

describe("expanded row actions", () => {
  it.each(["space-1", "edge/space-1"])("selects %s on left release, not on mouse down", (id) => {
    agents.mockReturnValue([agent("terminal", id, "working")])
    const { view, cx } = fixture([space(id, { machine: id.includes("/") ? "edge" : null })])
    const row = byId(render(view), `space-${id}`)

    fire(row, "on_mouse_down", cx, "left")
    expect(view.pressed).toBe(id)
    expect(view.over).toBe(id)
    expect(run).not.toHaveBeenCalled()
    fire(row, "on_mouse_up", cx, "left")
    expect(run).toHaveBeenCalledExactlyOnceWith("space.select", { id })
    expect(view.pressed).toBeNull()
    expect(view.over).toBeNull()
    expect(cx.notify).toHaveBeenCalledOnce()
    expect(row.handlers.on_click).toBeUndefined()
  })

  it("does not select a row when no press belongs to this view", () => {
    const { view, cx } = fixture()
    fire(byId(render(view), "space-space-1"), "on_mouse_up", cx, "left")
    expect(run).not.toHaveBeenCalled()
    expect(view.pressed).toBeNull()
  })

  it("opens the original context menu on right mouse down with the qualified target", () => {
    const { view, cx } = fixture([space("edge/space-1", { machine: "edge" })])
    fire(byId(render(view), "space-edge/space-1"), "on_mouse_down", cx, "right")

    expect(openOverlay).toHaveBeenCalledExactlyOnceWith({
      mod: "menu",
      kind: "popup",
      width: 200,
      height: 260,
      props: { tab: "space", target: { id: "edge/space-1" } },
    })
    expect(run).not.toHaveBeenCalled()
    expect(view.pressed).toBeNull()
  })

  const dragSpaces = () => [
    space("local-a", { machine: undefined }),
    space("edge/a", { machine: "edge" }),
    space("local-b"),
    space("edge/b", { machine: "edge" }),
    space("backup/a", { machine: "backup" }),
  ]

  it.each([
    ["local-a", "local-b", 3],
    ["local-b", "local-a", 1],
    ["edge/a", "edge/b", 4],
    ["edge/b", "edge/a", 2],
  ])("reorders %s over %s within one machine at global index %i", (source, target, index) => {
    const { view, cx } = fixture(dragSpaces())
    const root = render(view)
    fire(byId(root, `space-${source}`), "on_mouse_down", cx, "left")
    fire(byId(root, `space-${target}`), "on_mouse_move", cx)

    expect(view.over).toBe(target)
    expect(run).not.toHaveBeenCalled()
    fire(byId(root, `space-${target}`), "on_mouse_up", cx, "left")
    expect(run).toHaveBeenCalledExactlyOnceWith("space.move", { id: source, index })
    expect(view.pressed).toBeNull()
    expect(view.over).toBeNull()
  })

  it.each([
    ["local-a", "edge/a"],
    ["edge/a", "local-a"],
    ["edge/a", "backup/a"],
  ])("rejects a drag from %s to another machine's %s", (source, target) => {
    const { view, cx } = fixture(dragSpaces())
    const root = render(view)
    fire(byId(root, `space-${source}`), "on_mouse_down", cx, "left")
    fire(byId(root, `space-${target}`), "on_mouse_move", cx)

    expect(view.over).toBeNull()
    fire(byId(root, `space-${target}`), "on_mouse_up", cx, "left")
    expect(run).not.toHaveBeenCalled()
    expect(view.pressed).toBeNull()
    expect(view.over).toBeNull()
  })

  it("cancels a pending drag on list release without selecting or moving a space", () => {
    const { view, cx } = fixture(dragSpaces())
    const root = render(view)
    fire(byId(root, "space-local-a"), "on_mouse_down", cx, "left")
    fire(byId(root, "space-local-b"), "on_mouse_move", cx)
    fire(list(root), "on_mouse_up", cx, "left")
    expect(view.pressed).toBeNull()
    fire(byId(root, "space-local-b"), "on_mouse_up", cx, "left")
    expect(run).not.toHaveBeenCalled()
  })
})

describe("machine groups", () => {
  it("keeps local rows first, sorts machine headers, and retains per-machine rows", () => {
    const { view } = fixture([
      space("zeta/space", { machine: "zeta", active: true }),
      space("local"),
      space("alpha/space", { machine: "alpha" }),
    ])
    view.machines = [
      { name: "zeta", state: "connected" },
      { name: "alpha", state: "connected" },
    ]
    const root = render(view)

    expect(list(root).items.map((node) => node.props.id)).toEqual([
      "machine-local",
      "space-local",
      "machine-alpha",
      "space-alpha/space",
      "machine-zeta",
      "space-zeta/space",
    ])
    expect(texts(byId(root, "machine-local"))).toContain("This computer")
    expect(texts(byId(root, "machine-alpha"))).toContain("alpha")
    expect(texts(byId(root, "machine-zeta"))).toContain("zeta")
    expect(view.activeAt).toBe(5)
    expect(view.scroll.scroll_to_item).toHaveBeenCalledExactlyOnceWith(5)
    expect(run).not.toHaveBeenCalled()
  })

  it("folds and unfolds only the selected machine and persists the folded names", () => {
    const { view, cx } = fixture([
      space("local"),
      space("alpha/space", { machine: "alpha" }),
      space("zeta/space", { machine: "zeta" }),
    ])
    let root = render(view)
    fire(byId(root, "machine-alpha"), "on_click", cx)
    expect(localStorage.setItem).toHaveBeenLastCalledWith("machines.folded", '["alpha"]')
    expect(cx.notify).toHaveBeenCalledOnce()
    root = render(view)
    expect(hasId(root, "space-alpha/space")).toBe(false)
    expect(hasId(root, "machine-alpha")).toBe(true)
    expect(hasId(root, "space-local")).toBe(true)
    expect(hasId(root, "space-zeta/space")).toBe(true)

    fire(byId(root, "machine-alpha"), "on_click", cx)
    expect(localStorage.setItem).toHaveBeenLastCalledWith("machines.folded", "[]")
    expect(hasId(render(view), "space-alpha/space")).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it("keeps new-space actions scoped to their machine", () => {
    const { view, cx } = fixture([space("local")])
    view.machines = [{ name: "edge", state: "connected" }]
    machines.mockReturnValue([{ name: "edge", layout: "ready" }])
    const root = render(view)

    fire(byId(root, "machine-add-edge"), "on_click", cx)
    expect(run).toHaveBeenLastCalledWith("space.new", { machine: "edge" })
    expect(cx.stop_propagation).toHaveBeenCalledOnce()
    fire(byId(root, "machine-new-edge"), "on_click", cx)
    expect(run).toHaveBeenLastCalledWith("space.new", { machine: "edge" })
    fire(byId(root, "machine-add-local"), "on_click", cx)
    expect(run).toHaveBeenLastCalledWith("space.new", { machine: "" })
    fire(byId(root, "space-new"), "on_click", cx)
    expect(run).toHaveBeenLastCalledWith("space.new")
  })
})

describe("original compact rail", () => {
  it.each([
    [159, true],
    [160, false],
    [undefined, false],
  ])("uses sidebar width %s to choose compact=%s", (px, compact) => {
    layout.mockReturnValue({
      children: [{ id: "nested", children: [{ id: "sidebar", size: { px } }] }],
    })
    agents.mockReturnValue([agent("terminal", "space-1", "working")])
    const { view } = fixture()
    const root = render(view)
    const row = byId(root, "space-space-1")

    expect(hasId(root, "activity-space-1")).toBe(!compact)
    expect(hasId(root, "agents-space-1")).toBe(!compact)
    expect(typeof row.handlers.on_click === "function").toBe(compact)
    expect(hasId(root, "space-name-space-1")).toBe(!compact)
  })

  it("keeps original numbers, space-status glyphs, and click selection instead of agent tiles", () => {
    layout.mockReturnValue({ id: "sidebar", size: { px: 100 } })
    const entries = [
      space("working", { status: "working", active: true }),
      space("blocked", { status: "blocked" }),
      space("done", { status: "done" }),
      space("idle"),
    ]
    agents.mockReturnValue(entries.map((entry, i) => agent(`terminal-${i}`, entry.id, "working")))
    const { view, cx } = fixture(entries)
    const root = render(view)

    for (const [i, entry] of entries.entries()) {
      const row = byId(root, `space-${entry.id}`)
      expect(texts(row)).toEqual([String(i + 1), i === 1 || i === 2 ? "●" : "·"])
      expect(row.items[1].props.text_color).toBe(t[entry.status])
      expect(row.handlers["on_mouse_down:left"]).toBeUndefined()
      expect(row.handlers["on_mouse_down:right"]).toBeUndefined()
      expect(hasId(root, `activity-${entry.id}`)).toBe(false)
      expect(hasId(root, `agents-${entry.id}`)).toBe(false)
    }
    expect(byId(root, "space-working").props.bg).toBe(t.selected)
    expect(spinner(root)).toHaveLength(0)
    fire(byId(root, "space-blocked"), "on_click", cx)
    expect(run).toHaveBeenCalledExactlyOnceWith("space.select", { id: "blocked" })
    expect(openOverlay).not.toHaveBeenCalled()
  })

  it("retains original global space numbers under compact machine headers", () => {
    layout.mockReturnValue({ id: "sidebar", size: { px: 100 } })
    const { view, cx } = fixture([
      space("zeta/space", { machine: "zeta" }),
      space("local"),
      space("alpha/space", { machine: "alpha" }),
    ])
    const root = render(view)

    expect(texts(byId(root, "space-local"))).toEqual(["2", "·"])
    expect(texts(byId(root, "space-alpha/space"))).toEqual(["3", "·"])
    expect(texts(byId(root, "space-zeta/space"))).toEqual(["1", "·"])
    expect(byId(root, "machine-local").props.tooltip).toBe("This computer")
    expect(texts(byId(root, "machine-alpha"))).toEqual([])
    fire(byId(root, "space-alpha/space"), "on_click", cx)
    expect(run).toHaveBeenCalledExactlyOnceWith("space.select", { id: "alpha/space" })
  })

  it("keeps original status helpers, including the unknown-color fallback", () => {
    expect(["working", "idle", "blocked", "done", "unrecognized"].map(glyph)).toEqual([
      "·",
      "·",
      "●",
      "●",
      "·",
    ])
    expect(tone(t, "blocked")).toBe(t.blocked)
    expect(tone(t, "unrecognized")).toBe(t.unknown)
  })
})
