import { describe, expect, it } from "vitest"
import {
  addPanel,
  DOCK_ID,
  dockPosition,
  FRAME_ID,
  findNode,
  HEADER_ID,
  MOD_NAME,
  managedSlots,
  moveDock,
  parseProps,
  references,
  removePanel,
  reorderPanel,
  STACK_ID,
  validateLayout,
  validName,
} from "./model.js"

const slotId = (name) => `layout-manager-mod-${name}`
const block = (id, content = { terminal: "t1" }) => ({ id, type: "block", content })
const clone = (value) => JSON.parse(JSON.stringify(value))
const withoutBackground = (value) => {
  const body = clone(value)
  delete body.background
  return body
}
const dock = (root) => findNode(root, DOCK_ID)
const header = (root) => findNode(root, HEADER_ID)
const stack = (root) => findNode(root, STACK_ID)
const edges = [
  ["left", "row", 0],
  ["right", "row", 1],
  ["top", "column", 0],
  ["bottom", "column", 1],
]

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}

function layout(type = "row") {
  const children = [
    block("workspace", {
      tab: "active",
      pane: {
        gap: 6,
        header: { content: { mod: "pane", props: { position: "bottom" } }, height: 30 },
      },
    }),
    {
      id: "sidebar",
      type: "column",
      size: { px: 220 },
      children: [
        block("existing-alpha", { mod: "alpha", props: { file: "original.md", nested: [1, 2] } }),
        block("existing-agent", { agent: "focused" }),
      ],
    },
  ]
  const result = {
    id: "original-root",
    type,
    children,
    gap: 7,
    padding: [4, 8],
    radius: 9,
    border: { width: 2, color: "accent" },
    focus: { border: { width: 3, color: "foreground" } },
    background: { gradient: ["#123456", "#abcdef"], angle: 120 },
    resizable: true,
    custom: { keep: ["unknown", { nested: true }] },
    floating: [{ id: "float", content: { mod: "alpha", props: { edge: "left" } } }],
  }
  if (type === "stack") {
    result.active = "sidebar"
    result.header = { content: { mod: "tabs", props: { compact: true } } }
  }
  return result
}

function rootSettings() {
  return {
    titlebar: "none",
    traffic_lights: [14, 12],
    terminal_menu: "custom-menu",
    toast: "custom-toast",
    preview: "layouts/custom.svg",
    cloned_from: { name: "main", version: "1.2.3" },
    theme: { light: "paper", dark: "graphite" },
    colors: { accent: "#abcdef", chrome: "#123456" },
    font: "Geist Mono",
    font_size: 16,
    ui_font: "Geist",
    terminal_padding: [8, 12],
    terminal_opacity: 0.8,
    movable: false,
    background: { gradient: ["#123456", "#abcdef"], angle: 120 },
  }
}

function twoPanels() {
  return addPanel(addPanel(layout(), { name: "alpha", title: "Alpha", props: { first: true } }), {
    name: "beta",
    title: "Beta",
    props: { second: true },
  })
}

describe("public constants and safe names", () => {
  it("exports the agreed manager namespace", () => {
    expect([MOD_NAME, FRAME_ID, DOCK_ID, HEADER_ID, STACK_ID]).toEqual([
      "layout-manager",
      "layout-manager-frame",
      "layout-manager-dock",
      "layout-manager-header",
      "layout-manager-stack",
    ])
  })

  it.each(["a", "Z", "0", "my-mod", "foo.bar_2", "v1.2.3", "constructor", "toString"])(
    "accepts safe name %s",
    (name) => expect(validName(name)).toBe(true),
  )

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "/absolute",
    "a/b",
    "a\\b",
    "-option",
    "_name",
    ".hidden",
    " name",
    "name ",
    "two words",
    "name\n",
    "name\r\n",
    "name\0",
    "a;echo",
    "a:thing",
    "中文",
    null,
    undefined,
    42,
    {},
  ])("rejects unsafe name %j", (name) => {
    expect(validName(name)).toBe(false)
    expect(() => addPanel(layout(), { name })).toThrow(/name/)
    expect(() => removePanel(layout(), name)).toThrow(/name/)
    expect(() => reorderPanel(twoPanels(), name)).toThrow(/name/)
    if (name !== null && name !== undefined) {
      expect(() => reorderPanel(twoPanels(), "alpha", name)).toThrow(/name/)
    }
  })
})

describe("props parsing", () => {
  it("treats blank text as an empty object", () => {
    expect(parseProps("")).toEqual({})
    expect(parseProps(" \n\t ")).toEqual({})
  })

  it("parses nested JSON without changing special property names", () => {
    const text = '{"file":"a.md","enabled":true,"items":[1,null],"__proto__":{"safe":true}}'
    expect(parseProps(text)).toEqual(JSON.parse(text))
    expect(Object.hasOwn(parseProps(text), "__proto__")).toBe(true)
    expect({}.safe).toBeUndefined()
  })

  it.each(["null", "[]", "[{}]", "true", "false", "1", '"text"'])(
    "rejects non-object JSON %s",
    (text) => expect(() => parseProps(text)).toThrow(/JSON object/),
  )

  it.each(["{", "{bad}", '{"a":1,}', "undefined", "{} {}"])("rejects bad JSON %s", (text) => {
    expect(() => parseProps(text)).toThrow(/invalid JSON/)
  })

  it.each([null, undefined, {}, 4])("rejects non-text input %j", (text) => {
    expect(() => parseProps(text)).toThrow(/JSON text/)
  })
})

describe("layout validation and lookup", () => {
  it.each(["row", "column", "stack"])("accepts a %s root and returns the same object", (type) => {
    const root = freeze(layout(type))
    expect(validateLayout(root)).toBe(root)
    expect(findNode(root, "existing-alpha")).toBe(root.children[1].children[0])
    expect(findNode(root, root.id)).toBe(root)
    expect(findNode(root, "missing")).toBeNull()
  })

  it.each([
    { tab: "active" },
    { terminal: "t7" },
    { agent: "focused" },
    { mod: "alpha", props: { arbitrary: true } },
  ])("accepts documented block content %j", (content) => {
    const root = block("solo", content)
    expect(validateLayout(root)).toBe(root)
  })

  it("accepts compact inline nodes and unknown fields", () => {
    const root = {
      id: "root",
      type: "row",
      custom: ["keep"],
      children: [
        { id: "one", type: "block", content: { tab: "active" } },
        { id: "two", type: "block", content: { terminal: "t2" } },
      ],
    }
    expect(removePanel(addPanel(root, { name: "alpha" }), "alpha")).toEqual(root)
  })

  it("does not traverse pane layouts, props, terminal internals or floating blocks", () => {
    const embedded = { id: FRAME_ID, type: "unknown", children: "not structural" }
    const root = block("solo", {
      tab: "active",
      props: { children: [embedded] },
      pane: { layout: embedded, header: { content: { mod: "pane" } } },
      terminal: { children: [embedded] },
    })
    root.floating = [{ id: DOCK_ID, content: { mod: "floating", props: embedded } }]
    expect(validateLayout(root)).toBe(root)
    expect(findNode(root, FRAME_ID)).toBeNull()
    const added = addPanel(root, { name: "alpha" })
    expect(added.children[0]).toEqual(root)
  })

  it.each([
    ["null root", null, /object/],
    ["array root", [], /object/],
    ["scalar root", "root", /object/],
    ["missing type", { id: "a" }, /type/],
    ["unknown type", { id: "a", type: "grid" }, /type/],
    ["missing id", { type: "block" }, /id/],
    ["empty id", { type: "block", id: "" }, /id/],
    ["blank id", { type: "block", id: " \t" }, /id/],
    ["numeric id", { type: "block", id: 4 }, /id/],
    ["null children", { id: "a", type: "row", children: null }, /children.*array/],
    ["object children", { id: "a", type: "column", children: {} }, /children.*array/],
    ["text children", { id: "a", type: "stack", children: "b" }, /children.*array/],
    ["null child", { id: "a", type: "row", children: [null] }, /children\[0\].*object/],
    ["bad child type", { id: "a", type: "row", children: [{ id: "b", type: "bad" }] }, /type/],
    ["bad child id", { id: "a", type: "row", children: [{ type: "block" }] }, /id/],
    ["duplicate id", { id: "a", type: "row", children: [block("a")] }, /Duplicate.*a/],
    [
      "duplicate siblings",
      { id: "a", type: "column", children: [block("b"), block("b")] },
      /Duplicate.*b/,
    ],
    [
      "missing stack target",
      { id: "a", type: "stack", children: [block("b")], active: "c" },
      /active.*direct children/,
    ],
    [
      "numeric stack target",
      { id: "a", type: "stack", children: [block("b")], active: 0 },
      /active/,
    ],
    [
      "null stack target",
      { id: "a", type: "stack", children: [block("b")], active: null },
      /active/,
    ],
    ["empty active stack", { id: "a", type: "stack", children: [], active: "b" }, /active/],
  ])("rejects %s in validation and transforms", (_label, root, message) => {
    expect(() => validateLayout(root)).toThrow(message)
    expect(() => addPanel(root, { name: "alpha" })).toThrow(message)
    expect(() => removePanel(root, "alpha")).toThrow(message)
    expect(() => dockPosition(root)).toThrow(message)
    expect(() => moveDock(root, "left")).toThrow(message)
    expect(() => reorderPanel(root, "alpha")).toThrow(message)
  })

  it("requires a stack target to be a direct child, not a descendant", () => {
    const root = {
      id: "a",
      type: "stack",
      active: "c",
      children: [{ id: "b", type: "column", children: [block("c")] }],
    }
    expect(() => validateLayout(root)).toThrow(/direct children/)
  })

  it("accepts stacks without an explicit active target", () => {
    expect(validateLayout({ id: "a", type: "stack", children: [] }).id).toBe("a")
    expect(validateLayout({ id: "a", type: "stack", children: [block("b")] }).id).toBe("a")
  })

  it("rejects structural cycles without traversing forever", () => {
    const root = { id: "a", type: "row", children: [] }
    root.children.push(root)
    expect(() => validateLayout(root)).toThrow(/Duplicate/)
  })
})

describe("adding and listing managed panels", () => {
  it.each(["row", "column", "stack"])(
    "wraps a %s root without changing its id or structure",
    (type) => {
      const root = freeze(layout(type))
      const result = addPanel(root, { name: "alpha", title: "My Alpha", props: { file: "new.md" } })
      expect(result).not.toBe(root)
      expect(result.id).toBe(FRAME_ID)
      expect(result.type).toBe("row")
      expect(result.divider).toEqual({ width: 1, color: "border" })
      expect(result.children).toHaveLength(2)
      expect(result.children[0]).toEqual(withoutBackground(root))
      expect(result.children[0]).not.toBe(root)
      expect(result.background).toEqual(root.background)
      expect(dock(result)).toMatchObject({
        id: DOCK_ID,
        type: "column",
        size: { px: 380 },
        min: 240,
        max: 900,
        background: "chrome",
        resizable: false,
        hidden: false,
      })
      expect(header(result)).toEqual({
        id: HEADER_ID,
        type: "block",
        size: { px: 36 },
        content: { mod: MOD_NAME, props: { mode: "dock", titles: { alpha: "My Alpha" } } },
      })
      expect(stack(result)).toEqual({
        id: STACK_ID,
        type: "stack",
        active: slotId("alpha"),
        children: [block(slotId("alpha"), { mod: "alpha", props: { file: "new.md" } })],
      })
      expect(managedSlots(result)).toEqual([
        { id: slotId("alpha"), name: "alpha", title: "My Alpha", props: { file: "new.md" } },
      ])
      expect(validateLayout(result)).toBe(result)
    },
  )

  it("wraps an original block root", () => {
    const root = freeze(block("terminal-root"))
    expect(removePanel(addPanel(root, { name: "alpha" }), "alpha")).toEqual(root)
  })

  it("moves root look and background but keeps body borders, spacing, and unknown fields", () => {
    const settings = rootSettings()
    const root = freeze({ ...layout(), ...settings })
    const result = addPanel(root, { name: "alpha" })
    expect(result).toMatchObject(settings)
    for (const key of Object.keys(settings))
      expect(Object.hasOwn(result.children[0], key)).toBe(false)
    const body = clone(root)
    for (const key of Object.keys(settings)) delete body[key]
    expect(result.children[0]).toEqual(body)
    expect(result.children[0].custom).toEqual(root.custom)
    expect(result.background).toEqual(root.background)
    expect(root).toMatchObject(settings)
  })

  it("does not leave an opaque body that masks a changed root background", () => {
    const added = addPanel({ ...block("root"), background: "#111111" }, { name: "alpha" })
    expect(Object.hasOwn(added.children[0], "background")).toBe(false)
    added.background = "#222222"
    expect(removePanel(added, "alpha").background).toBe("#222222")
    delete added.background
    expect(Object.hasOwn(removePanel(added, "alpha"), "background")).toBe(false)
  })

  it("does not add a background when the original root has none", () => {
    expect(Object.hasOwn(addPanel(block("root"), { name: "alpha" }), "background")).toBe(false)
  })

  it("keeps nested look settings in their original nodes", () => {
    const root = layout()
    root.children[1].font_size = 10
    root.children[1].movable = true
    root.children[1].theme = "ink"
    expect(addPanel(freeze(root), { name: "alpha" }).children[0]).toEqual(withoutBackground(root))
  })

  it("updates one managed mod, selects it and shows the dock without editing other placements", () => {
    const input = twoPanels()
    dock(input).hidden = true
    dock(input).size.px = 520
    const before = clone(input)
    freeze(input)
    const props = freeze({ file: "replacement.md", nested: { enabled: true } })
    const result = addPanel(input, { name: "alpha", title: "Updated", props })
    expect(input).toEqual(before)
    expect(result.children[0]).toEqual(input.children[0])
    expect(managedSlots(result)).toEqual([
      { id: slotId("alpha"), name: "alpha", title: "Updated", props },
      { id: slotId("beta"), name: "beta", title: "Beta", props: { second: true } },
    ])
    expect(stack(result).active).toBe(slotId("alpha"))
    expect(dock(result).hidden).toBe(false)
    expect(dock(result).size.px).toBe(520)
    expect(findNode(result, "existing-alpha").content.props.file).toBe("original.md")
    expect(findNode(result, "workspace").content.pane.header.content.mod).toBe("pane")
    expect(findNode(result, slotId("alpha")).content.props).not.toBe(props)
  })

  it("defaults omitted props and title and retains an explicit empty title", () => {
    const root = addPanel(layout(), { name: "alpha" })
    expect(managedSlots(root)[0]).toEqual({
      id: slotId("alpha"),
      name: "alpha",
      title: "alpha",
      props: {},
    })
    expect(managedSlots(addPanel(root, { name: "alpha", title: "" }))[0].title).toBe("")
  })

  it("has no inventory dependency and keeps a missing mod's stable slot", () => {
    const root = addPanel(twoPanels(), { name: "missing-mod.v2", props: { restore: ["later"] } })
    const missing = managedSlots(root)[2]
    expect(missing).toEqual({
      id: slotId("missing-mod.v2"),
      name: "missing-mod.v2",
      title: "missing-mod.v2",
      props: { restore: ["later"] },
    })
    const reinstalled = addPanel(root, { name: "missing-mod.v2", props: { restore: ["later"] } })
    expect(managedSlots(reinstalled)).toHaveLength(3)
    expect(managedSlots(reinstalled)[2]).toEqual(missing)
    const removed = removePanel(root, "missing-mod.v2")
    expect(managedSlots(addPanel(removed, { name: "missing-mod.v2" }))[2].id).toBe(missing.id)
  })

  it("supports valid names that are Object prototype property names", () => {
    const root = addPanel(addPanel(layout(), { name: "constructor" }), {
      name: "toString",
      title: "String",
    })
    delete header(root).content.props.titles.constructor
    expect(managedSlots(root).map((slot) => slot.title)).toEqual(["constructor", "String"])
    expect(managedSlots(removePanel(root, "constructor")).map((slot) => slot.name)).toEqual([
      "toString",
    ])
  })

  it("returns props without exposing caller-owned mutable objects", () => {
    const root = freeze(addPanel(layout(), { name: "alpha", props: { nested: [1] } }))
    const slots = managedSlots(root)
    slots[0].props.nested.push(2)
    expect(managedSlots(root)[0].props).toEqual({ nested: [1] })
  })

  it("lists an unmanaged layout as empty even when it already places the same mod", () => {
    expect(managedSlots(freeze(layout()))).toEqual([])
  })

  it("uses the mod name and empty props when owned optional values are absent or null", () => {
    const root = twoPanels()
    delete header(root).content.props.titles.alpha
    header(root).content.props.titles.beta = null
    delete findNode(root, slotId("alpha")).content.props
    findNode(root, slotId("beta")).content.props = null
    expect(managedSlots(freeze(root))).toEqual([
      { id: slotId("alpha"), name: "alpha", title: "alpha", props: {} },
      { id: slotId("beta"), name: "beta", title: "beta", props: {} },
    ])
  })

  it.each([
    null,
    [],
    "text",
    4,
    true,
    new Date(0),
    { nested: undefined },
    { nested: () => 1 },
    { nested: Infinity },
  ])("rejects non-JSON props %j without changing the layout", (props) => {
    const root = freeze(layout())
    expect(() => addPanel(root, { name: "alpha", props })).toThrow(/Props.*JSON/)
    expect(root).toEqual(layout())
  })

  it("rejects circular props", () => {
    const props = {}
    props.circular = props
    expect(() => addPanel(layout(), { name: "alpha", props })).toThrow(/circular/)
  })

  it.each([null, [], 42, {}])("rejects a non-string title %j", (title) => {
    expect(() => addPanel(layout(), { name: "alpha", title })).toThrow(/title.*string/)
  })
})

describe("dock position and immutable movement", () => {
  it.each(["row", "column", "stack", "block"])(
    "returns null for an unowned %s without creating a dock",
    (type) => {
      const input = type === "block" ? block("root") : layout(type)
      const before = clone(input)
      freeze(input)
      expect(dockPosition(input)).toBeNull()
      expect(() => moveDock(input, "left")).toThrow(/no managed dock/)
      expect(input).toEqual(before)
    },
  )

  it("keeps the existing right dock as the default", () => {
    expect(dockPosition(freeze(twoPanels()))).toBe("right")
  })

  it.each(edges)("recognizes an existing %s dock without metadata", (position, type, index) => {
    const input = twoPanels()
    input.type = type
    if (index === 0) input.children.reverse()
    const before = clone(input)
    freeze(input)
    expect(dockPosition(input)).toBe(position)
    expect(managedSlots(input).map((slot) => slot.name)).toEqual(["alpha", "beta"])
    const updated = addPanel(input, { name: "gamma" })
    expect(dockPosition(updated)).toBe(position)
    expect(dockPosition(removePanel(input, "alpha"))).toBe(position)
    expect(input).toEqual(before)
  })

  it.each(edges)(
    "moves to %s and changes only frame direction and child order",
    (position, type, index) => {
      const input = addPanel(
        { ...layout("stack"), ...rootSettings() },
        {
          name: "alpha",
          title: "Custom title",
          props: { nested: [1, { keep: true }], position: "right" },
        },
      )
      dock(input).size.px = 900
      dock(input).hidden = true
      input.children[0].custom.after = { keep: ["body"] }
      input.background = "#222222"
      delete input.preview
      const before = clone(input)
      freeze(input)
      const result = moveDock(input, position)
      const expected = clone(before)
      expected.type = type
      if (index === 0) expected.children.reverse()
      expect(result).toEqual(expected)
      expect(result).not.toBe(input)
      expect(result.children[index]).not.toBe(dock(input))
      expect(result.children[1 - index]).not.toBe(input.children[0])
      expect(dockPosition(result)).toBe(position)
      expect(input).toEqual(before)
      // Returned data must not expose frozen input objects.
      result.children[1 - index].custom.after.keep.push("changed")
      dock(result).size.px = 240
      header(result).content.props.titles.alpha = "Changed"
      stack(result).children[0].content.props.nested[1].keep = false
      result.colors.accent = "changed"
      expect(input).toEqual(before)
    },
  )

  for (const [from] of edges) {
    it.each(edges)(
      `switches from ${from} to %s without changing dock contents`,
      (to, type, index) => {
        const input = moveDock(twoPanels(), from)
        dock(input).hidden = true
        dock(input).size.px = 520
        const before = clone(input)
        freeze(input)
        const result = moveDock(input, to)
        const expected = clone(input)
        const expectedDock = dock(expected)
        const expectedBody = expected.children.find((child) => child.id !== DOCK_ID)
        expected.type = type
        expected.children =
          index === 0 ? [expectedDock, expectedBody] : [expectedBody, expectedDock]
        expect(result).toEqual(expected)
        expect(dockPosition(result)).toBe(to)
        expect(moveDock(freeze(result), from)).toEqual(input)
        expect(input).toEqual(before)
      },
    )
  }

  for (const type of ["row", "column", "stack", "block"]) {
    it.each(edges)(`removes the last panel at %s and restores the original ${type}`, (position) => {
      const original = freeze({
        ...(type === "block" ? block("root") : layout(type)),
        ...rootSettings(),
      })
      const added = freeze(addPanel(original, { name: "alpha" }))
      const moved = freeze(moveDock(added, position))
      expect(removePanel(moved, "alpha")).toEqual(original)
      expect(dockPosition(moved)).toBe(position)
      expect(dockPosition(added)).toBe("right")
    })
  }

  it.each(edges)("keeps current root settings when unwrapping a %s dock", (position) => {
    const original = { ...layout("stack"), ...rootSettings() }
    const input = addPanel(original, { name: "alpha" })
    input.theme = "changed"
    input.font_size = 24
    input.movable = true
    delete input.background
    delete input.preview
    // Stale body settings must not override the current outer settings.
    input.children[0].background = "stale"
    input.children[0].preview = "stale.svg"
    input.children[0].custom.edited = true
    const before = clone(input)
    const moved = moveDock(freeze(input), position)
    const expected = { ...clone(original), theme: "changed", font_size: 24, movable: true }
    delete expected.background
    delete expected.preview
    expected.custom.edited = true
    expect(removePanel(freeze(moved), "alpha")).toEqual(expected)
    expect(input).toEqual(before)
  })

  it("does not add absent active, hidden or props values", () => {
    const input = twoPanels()
    delete stack(input).active
    delete dock(input).hidden
    delete findNode(input, slotId("alpha")).content.props
    findNode(input, slotId("beta")).content.props = null
    const before = clone(input)
    expect(moveDock(freeze(input), "right")).toEqual(before)
    const reordered = reorderPanel(input, "beta", "alpha")
    expect(Object.hasOwn(stack(reordered), "active")).toBe(false)
    expect(Object.hasOwn(dock(reordered), "hidden")).toBe(false)
    expect(findNode(reordered, slotId("alpha")).content).toEqual({ mod: "alpha" })
    expect(findNode(reordered, slotId("beta")).content.props).toBeNull()
    expect(input).toEqual(before)
  })

  it("can move an empty owned dock but cannot reorder a missing slot", () => {
    const input = twoPanels()
    delete stack(input).active
    stack(input).children = []
    header(input).content.props.titles = {}
    const before = clone(input)
    const moved = moveDock(freeze(input), "top")
    expect(dockPosition(moved)).toBe("top")
    expect(managedSlots(moved)).toEqual([])
    expect(() => reorderPanel(moved, "alpha")).toThrow(/not managed/)
    expect(input).toEqual(before)
  })

  it.each(["", "LEFT", "Right", "center", "top ", "left\n", null, undefined, 0, {}, [], ["left"]])(
    "rejects invalid dock position %j without changing the input",
    (position) => {
      const input = freeze(twoPanels())
      const before = clone(input)
      expect(() => moveDock(input, position)).toThrow(/Dock position/)
      expect(input).toEqual(before)
    },
  )
})

describe("immutable managed panel reordering", () => {
  it.each([
    ["alpha", "gamma", ["beta", "alpha", "gamma", "delta"]],
    ["alpha", "delta", ["beta", "gamma", "alpha", "delta"]],
    ["delta", "beta", ["alpha", "delta", "beta", "gamma"]],
    ["gamma", "alpha", ["gamma", "alpha", "beta", "delta"]],
    ["beta", null, ["alpha", "gamma", "delta", "beta"]],
    ["alpha", undefined, ["beta", "gamma", "delta", "alpha"]],
    ["delta", null, ["alpha", "beta", "gamma", "delta"]],
    ["alpha", "beta", ["alpha", "beta", "gamma", "delta"]],
    ["beta", "beta", ["alpha", "beta", "gamma", "delta"]],
  ])("moves %s before %s without changing any slot or active value", (name, before, order) => {
    const input = addPanel(addPanel(twoPanels(), { name: "gamma", props: { nested: [1] } }), {
      name: "delta",
      props: { restore: { enabled: true } },
    })
    stack(input).active = slotId("beta")
    dock(input).hidden = true
    dock(input).size.px = 640
    const snapshot = clone(input)
    freeze(input)
    const result = reorderPanel(input, name, before)
    const expected = clone(input)
    const expectedStack = stack(expected)
    const slots = expectedStack.children
    expectedStack.children = order.map((mod) => slots.find((slot) => slot.content.mod === mod))
    expect(result).toEqual(expected)
    expect(result).not.toBe(input)
    expect(managedSlots(result).map((slot) => slot.name)).toEqual(order)
    expect(stack(result).active).toBe(slotId("beta"))
    expect(input).toEqual(snapshot)
    findNode(result, slotId("delta")).content.props.restore.enabled = false
    header(result).content.props.titles.alpha = "Changed"
    result.children[0].custom.keep.push("changed")
    expect(input).toEqual(snapshot)
  })

  it.each(edges)(
    "reorders a %s dock and preserves stable references for a missing mod",
    (position) => {
      const input = moveDock(
        addPanel(twoPanels(), {
          name: "missing-mod.v2",
          title: "Missing",
          props: { restore: ["later"] },
        }),
        position,
      )
      const before = clone(input)
      freeze(input)
      const result = reorderPanel(input, "missing-mod.v2", "alpha")
      expect(dockPosition(result)).toBe(position)
      expect(managedSlots(result).map((slot) => slot.name)).toEqual([
        "missing-mod.v2",
        "alpha",
        "beta",
      ])
      expect(stack(result).active).toBe(slotId("missing-mod.v2"))
      expect(findNode(result, slotId("missing-mod.v2"))).toEqual(
        findNode(input, slotId("missing-mod.v2")),
      )
      expect(references(result, "missing-mod.v2")).toEqual(references(input, "missing-mod.v2"))
      expect(references(result, "alpha")).toEqual(references(input, "alpha"))
      expect(reorderPanel(freeze(result), "missing-mod.v2")).toEqual(input)
      expect(input).toEqual(before)
    },
  )

  it("accepts prototype property names without looking up inherited properties", () => {
    const input = freeze(
      addPanel(addPanel(twoPanels(), { name: "constructor" }), { name: "toString" }),
    )
    const result = reorderPanel(input, "toString", "constructor")
    expect(managedSlots(result).map((slot) => slot.name)).toEqual([
      "alpha",
      "beta",
      "toString",
      "constructor",
    ])
    expect(stack(result).active).toBe(slotId("toString"))
  })

  it("keeps a single slot unchanged, including self and end moves", () => {
    const input = freeze(addPanel(layout(), { name: "alpha" }))
    expect(reorderPanel(input, "alpha", "alpha")).toEqual(input)
    expect(reorderPanel(input, "alpha")).toEqual(input)
  })

  it.each([
    ["missing", null],
    ["alpha", "missing"],
    ["missing", "missing"],
    ["existing-alpha", null],
    [slotId("alpha"), null],
    ["alpha", slotId("beta")],
    ["alpha", "constructor"],
  ])("rejects missing managed references %s before %s", (name, before) => {
    const input = freeze(twoPanels())
    const snapshot = clone(input)
    expect(() => reorderPanel(input, name, before)).toThrow(/not managed/)
    expect(input).toEqual(snapshot)
  })

  it("does not reorder arbitrary body nodes or adopt an unowned same-mod placement", () => {
    const input = freeze(layout())
    const before = clone(input)
    expect(() => reorderPanel(input, "alpha")).toThrow(/not managed/)
    expect(() => reorderPanel(input, "workspace", "sidebar")).toThrow(/not managed/)
    expect(input).toEqual(before)
  })
})

describe("read-only references", () => {
  it("reports content, pane headers, stack headers and floating mod refs", () => {
    const root = layout("stack")
    root.header.content.mod = "alpha"
    root.children[0].content.pane.header.content.mod = "alpha"
    root.children[0].floating = [{ content: { mod: "alpha" } }, { content: { terminal: "t4" } }]
    root.children[1].children.push(block("other-mod", { mod: "other", props: { mod: "alpha" } }))
    const result = addPanel(root, { name: "alpha" })
    const before = clone(result)
    expect(references(freeze(result), "alpha")).toEqual([
      { id: "original-root", role: "stack-header", managed: false },
      { id: "float", role: "floating", managed: false },
      { id: "workspace", role: "pane-header", managed: false },
      { id: "workspace", role: "floating", managed: false },
      { id: "existing-alpha", role: "content", managed: false },
      { id: slotId("alpha"), role: "content", managed: true },
    ])
    expect(result).toEqual(before)
    expect(references(result, "absent")).toEqual([])
    expect(references(result, "layout-manager")).toEqual([
      { id: HEADER_ID, role: "content", managed: false },
    ])
  })

  it("does not count arbitrary props or nested pane layout nodes as mod references", () => {
    const root = block("root", { mod: "other", props: { content: { mod: "alpha" }, mod: "alpha" } })
    root.pane = { header: { content: { mod: "alpha" } } }
    root.header = { content: { mod: "alpha" } }
    expect(references(root, "alpha")).toEqual([])
  })

  it("ignores plain built-in stack headers and non-mod floating content", () => {
    const root = layout("stack")
    root.header = "tabs"
    root.floating = [null, "unknown", { content: { terminal: "t7" } }]
    expect(references(root, "tabs")).toEqual([])
  })
})

describe("removing managed panels", () => {
  it("removes only the requested slot and title, then repairs active to the first slot", () => {
    const input = freeze(twoPanels())
    const result = removePanel(input, "beta")
    expect(result.children[0]).toEqual(input.children[0])
    expect(managedSlots(result)).toEqual([managedSlots(input)[0]])
    expect(header(result).content.props.titles).toEqual({ alpha: "Alpha" })
    expect(stack(result).active).toBe(slotId("alpha"))
    expect(findNode(result, "existing-alpha")).toEqual(findNode(input, "existing-alpha"))
    expect(managedSlots(input)).toHaveLength(2)
  })

  it("repairs active when removing the first active slot", () => {
    const input = twoPanels()
    stack(input).active = slotId("alpha")
    const result = removePanel(freeze(input), "alpha")
    expect(stack(result).active).toBe(slotId("beta"))
    expect(header(result).content.props.titles).toEqual({ beta: "Beta" })
    expect(findNode(result, "existing-alpha").content.mod).toBe("alpha")
  })

  it("keeps the selected slot when removing a different slot", () => {
    const result = removePanel(freeze(twoPanels()), "alpha")
    expect(stack(result).active).toBe(slotId("beta"))
  })

  it("chooses the first remaining slot when an owned stack has no active value", () => {
    const input = twoPanels()
    delete stack(input).active
    expect(stack(removePanel(freeze(input), "alpha")).active).toBe(slotId("beta"))
  })

  it.each(["row", "column", "stack"])("unwraps the last panel back to the original %s", (type) => {
    const original = freeze({ ...layout(type), ...rootSettings() })
    const added = freeze(addPanel(original, { name: "alpha" }))
    const removed = removePanel(added, "alpha")
    expect(removed).toEqual(original)
    expect(removed).not.toBe(original)
    expect(removed.id).toBe("original-root")
    expect(managedSlots(removed)).toEqual([])
    expect(findNode(removed, DOCK_ID)).toBeNull()
    expect(managedSlots(added)).toHaveLength(1)
  })

  it("transfers current outer root settings and honors keys removed from the frame", () => {
    const original = { ...layout("stack"), ...rootSettings() }
    const input = addPanel(original, { name: "alpha" })
    const changed = {
      titlebar: "native",
      traffic_lights: [5, 6],
      terminal_menu: "new-menu",
      toast: "new-toast",
      preview: "layouts/new.svg",
      cloned_from: { name: "custom", version: "2" },
      theme: "moss",
      colors: { accent: "#333333" },
      font: "Other Mono",
      font_size: 20,
      ui_font: "Other UI",
      terminal_padding: 0,
      terminal_opacity: 1,
      movable: true,
      background: "#222222",
    }
    Object.assign(input, changed)
    expect(removePanel(freeze(input), "alpha")).toEqual({ ...original, ...changed })
    const deleted = addPanel(original, { name: "alpha" })
    for (const key of Object.keys(rootSettings())) {
      delete deleted[key]
      deleted.children[0][key] = original[key]
    }
    const expected = clone(original)
    for (const key of Object.keys(rootSettings())) delete expected[key]
    expect(removePanel(freeze(deleted), "alpha")).toEqual(expected)
  })

  it("preserves body structure edits and foreign nodes made after wrapping", () => {
    const input = addPanel(layout(), { name: "alpha" })
    input.children[0].children.push(block("new-foreign", { mod: "alpha", props: { keep: true } }))
    input.children[0].custom.after = "keep"
    input.children[0].gap = 12
    const expected = { ...clone(input.children[0]), background: clone(input.background) }
    expect(removePanel(freeze(input), "alpha")).toEqual(expected)
  })

  it("does not reveal a hidden dock when removing one of several panels", () => {
    const input = twoPanels()
    dock(input).hidden = true
    expect(dock(removePanel(freeze(input), "alpha")).hidden).toBe(true)
  })

  it("refuses to remove an unmanaged placement of the same mod", () => {
    expect(() => removePanel(freeze(layout()), "alpha")).toThrow(/not managed/)
    expect(() => removePanel(freeze(twoPanels()), "missing")).toThrow(/not managed/)
  })
})

describe("namespace collisions and unexpected owned edits fail closed", () => {
  it.each([FRAME_ID, DOCK_ID, HEADER_ID, STACK_ID, slotId("alpha"), slotId("unrelated")])(
    "rejects a reserved id %s in the original tree",
    (id) => {
      const input = layout()
      input.children.push(block(id, { mod: "unrelated", props: { keep: true } }))
      const before = clone(input)
      freeze(input)
      expect(() => managedSlots(input)).toThrow(/structure changed|Reserved layout id/)
      expect(() => addPanel(input, { name: "alpha" })).toThrow(
        /structure changed|Reserved layout id/,
      )
      expect(() => removePanel(input, "alpha")).toThrow(/structure changed|Reserved layout id/)
      expect(() => dockPosition(input)).toThrow(/structure changed|Reserved layout id/)
      expect(() => moveDock(input, "top")).toThrow(/structure changed|Reserved layout id/)
      expect(() => reorderPanel(input, "alpha", "beta")).toThrow(
        /structure changed|Reserved layout id/,
      )
      expect(input).toEqual(before)
    },
  )

  it("does not adopt an unrelated root that happens to use the frame id", () => {
    const input = freeze({ ...layout(), id: FRAME_ID })
    expect(() => addPanel(input, { name: "alpha" })).toThrow(/structure changed/)
  })

  it("does not adopt a valid managed frame nested inside another layout", () => {
    const input = freeze({ id: "outer", type: "column", children: [twoPanels()] })
    expect(() => managedSlots(input)).toThrow(/must be the layout root/)
  })

  it.each([
    [
      "frame direction",
      (root) => {
        root.type = "block"
      },
    ],
    [
      "frame stack direction",
      (root) => {
        root.type = "stack"
      },
    ],
    [
      "frame extra child",
      (root) => {
        root.children.push(block("foreign"))
      },
    ],
    [
      "missing direct dock",
      (root) => {
        dock(root).id = "foreign-dock"
      },
    ],
    [
      "frame unknown setting",
      (root) => {
        root.new_setting = { keep: true }
      },
    ],
    [
      "frame floating content",
      (root) => {
        root.floating = [{ id: "foreign", content: { mod: "other" } }]
      },
    ],
    [
      "frame divider",
      (root) => {
        root.divider.color = "accent"
      },
    ],
    [
      "dock direction",
      (root) => {
        dock(root).type = "row"
      },
    ],
    [
      "dock foreign child",
      (root) => {
        dock(root).children.push(block("foreign"))
      },
    ],
    [
      "dock child order",
      (root) => {
        dock(root).children.reverse()
      },
    ],
    [
      "dock unknown setting",
      (root) => {
        dock(root).custom = { keep: true }
      },
    ],
    [
      "dock floating content",
      (root) => {
        dock(root).floating = [{ id: "foreign", content: { mod: "other" } }]
      },
    ],
    [
      "dock width",
      (root) => {
        dock(root).size.px = 100
      },
    ],
    [
      "dock bounds",
      (root) => {
        dock(root).min = 100
      },
    ],
    [
      "dock resizing",
      (root) => {
        dock(root).resizable = true
      },
    ],
    [
      "dock background",
      (root) => {
        dock(root).background = "accent"
      },
    ],
    [
      "dock hidden",
      (root) => {
        dock(root).hidden = "yes"
      },
    ],
    [
      "header id",
      (root) => {
        header(root).id = "foreign"
      },
    ],
    [
      "header height",
      (root) => {
        header(root).size.px = 48
      },
    ],
    [
      "header mod",
      (root) => {
        header(root).content.mod = "foreign"
      },
    ],
    [
      "header foreign content",
      (root) => {
        header(root).content.terminal = "t7"
      },
    ],
    [
      "header foreign props",
      (root) => {
        header(root).content.props.keep = true
      },
    ],
    [
      "header mode",
      (root) => {
        header(root).content.props.mode = "other"
      },
    ],
    [
      "missing titles",
      (root) => {
        delete header(root).content.props.titles
      },
    ],
    [
      "bad titles",
      (root) => {
        header(root).content.props.titles = []
      },
    ],
    [
      "orphan title",
      (root) => {
        header(root).content.props.titles.foreign = "Keep"
      },
    ],
    [
      "bad title value",
      (root) => {
        header(root).content.props.titles.alpha = 4
      },
    ],
    [
      "stack id",
      (root) => {
        stack(root).id = "foreign"
      },
    ],
    [
      "stack header",
      (root) => {
        stack(root).header = { content: { mod: "foreign" } }
      },
    ],
    [
      "foreign stack slot",
      (root) => {
        stack(root).children.push(block("foreign", { mod: "other" }))
      },
    ],
    [
      "slot foreign field",
      (root) => {
        findNode(root, slotId("alpha")).custom = { keep: true }
      },
    ],
    [
      "slot foreign content",
      (root) => {
        findNode(root, slotId("alpha")).content.tab = "active"
      },
    ],
    [
      "slot props",
      (root) => {
        findNode(root, slotId("alpha")).content.props = []
      },
    ],
    [
      "slot mod",
      (root) => {
        findNode(root, slotId("alpha")).content.mod = "other"
      },
    ],
    [
      "slot unsafe mod",
      (root) => {
        findNode(root, slotId("alpha")).content.mod = "../other"
      },
    ],
    [
      "body namespace collision",
      (root) => {
        root.children[0].children.push(block(slotId("other")))
      },
    ],
  ])("rejects %s without deleting or modifying any input", (_label, change) => {
    const input = twoPanels()
    change(input)
    const before = clone(input)
    freeze(input)
    expect(() => managedSlots(input)).toThrow(/structure changed|Props/)
    expect(() => addPanel(input, { name: "alpha" })).toThrow(/structure changed|Props/)
    expect(() => removePanel(input, "alpha")).toThrow(/structure changed|Props/)
    expect(() => dockPosition(input)).toThrow(/structure changed|Props/)
    expect(() => moveDock(input, "bottom")).toThrow(/structure changed|Props/)
    expect(() => reorderPanel(input, "alpha", "beta")).toThrow(/structure changed|Props/)
    expect(input).toEqual(before)
  })

  it("refuses an owned slot id change even when its active target is repaired", () => {
    const input = twoPanels()
    findNode(input, slotId("alpha")).id = "foreign-alpha"
    expect(() => removePanel(input, "alpha")).toThrow(/matching managed mod id/)
  })

  it("refuses a malformed active target instead of silently repairing the input", () => {
    const input = twoPanels()
    stack(input).active = "missing"
    expect(() => addPanel(freeze(input), { name: "alpha" })).toThrow(/active/)
    expect(() => removePanel(input, "beta")).toThrow(/active/)
    expect(() => dockPosition(input)).toThrow(/active/)
    expect(() => moveDock(input, "left")).toThrow(/active/)
    expect(() => reorderPanel(input, "alpha", "alpha")).toThrow(/active/)
  })

  it("does not discard an edited frame when removing its final slot", () => {
    const input = addPanel(layout(), { name: "alpha" })
    dock(input).children.push(block("foreign", { mod: "other" }))
    expect(() => removePanel(freeze(input), "alpha")).toThrow(/structure changed/)
  })
})
