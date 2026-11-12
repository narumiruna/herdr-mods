import { describe, expect, it } from "vitest"
import {
  addPanel,
  copy,
  DOCK_ID,
  FRAME_ID,
  findNode,
  HEADER_ID,
  managedSlots,
  moveDock,
  ROOT_FIELDS,
  removePanel,
  STACK_ID,
  validateLayout,
} from "./model.js"
import { ordinaryNodes, placementError, placementValidator, placeNode } from "./tree.js"

const block = (id, fields = {}) => ({ id, type: "block", content: { terminal: id }, ...fields })
const container = (id, type, children, fields = {}) => ({ id, type, children, ...fields })
const existing = (id) => ({ kind: "node", id })
const fresh = (name = "alpha", props = {}) => ({ kind: "new", name, props })
const sides = [
  ["left", "row", true],
  ["right", "row", false],
  ["top", "column", true],
  ["bottom", "column", false],
]
const ids = (node) => node.children.map((child) => child.id)
const nodeIds = (root) => ordinaryNodes(root).map(({ node }) => node.id)

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}

function layout() {
  return container("root", "row", [block("a"), block("b"), block("c")])
}

function place(input, source, target, side) {
  const snapshot = copy(input)
  freeze(input)
  freeze(source)
  expect(placementError(input, source, target, side)).toBe("")
  const result = placeNode(input, source, target, side)
  expect(input).toEqual(snapshot)
  expect(validateLayout(result)).toBe(result)
  expect(() => managedSlots(result)).not.toThrow()
  const beforeIds = nodeIds(input)
  const afterIds = nodeIds(result)
  for (const id of beforeIds) expect(afterIds.filter((item) => item === id)).toHaveLength(1)
  expect(new Set(afterIds).size).toBe(afterIds.length)
  return result
}

function reject(input, source, target, side, pattern) {
  const snapshot = copy(input)
  freeze(input)
  const error = placementError(input, source, target, side)
  expect(error).toMatch(pattern)
  expect(() => placeNode(input, source, target, side)).toThrow(error)
  expect(input).toEqual(snapshot)
}

describe("ordinary structural traversal", () => {
  it("returns every structural node in preorder with its actual parent and depth", () => {
    const leaf = block("deep")
    let nested = leaf
    for (let depth = 8; depth > 0; depth -= 1) {
      nested = container(`level-${depth}`, depth % 2 ? "row" : "column", [nested])
    }
    const hidden = block("hidden", { hidden: true })
    const input = freeze(container("root", "stack", [nested, hidden], { active: "hidden" }))
    const entries = ordinaryNodes(input)
    expect(entries.map(({ node }) => node.id)).toEqual([
      "root",
      ...Array.from({ length: 8 }, (_, index) => `level-${index + 1}`),
      "deep",
      "hidden",
    ])
    expect(entries[0]).toEqual({ node: input, parent: null, depth: 0 })
    for (let index = 1; index <= 9; index += 1) {
      expect(entries[index]).toEqual({
        node: entries[index - 1].node.children[0],
        parent: entries[index - 1].node,
        depth: index,
      })
    }
    expect(entries.at(-1)).toEqual({ node: hidden, parent: input, depth: 1 })
  })

  it("does not traverse content, props, pane layouts, headers, floating or unknown fields", () => {
    const opaque = { type: "not-a-layout", id: "a", children: [block("fake")] }
    const input = freeze(
      container("root", "stack", [block("a", { content: opaque, props: opaque })], {
        header: opaque,
        floating: [opaque],
        custom: opaque,
      }),
    )
    expect(nodeIds(input)).toEqual(["root", "a"])
  })

  it.each(["left", "right", "top", "bottom"])(
    "returns only the original legacy body with a %s dock",
    (side) => {
      const input = freeze(moveDock(addPanel(layout(), { name: "alpha" }), side))
      const entries = ordinaryNodes(input)
      expect(entries.map(({ node }) => node.id)).toEqual(["root", "a", "b", "c"])
      expect(entries[0].parent).toBeNull()
      expect(entries[0].depth).toBe(0)
      expect(entries[0].node).toBe(findNode(input, "root"))
      expect(entries[1].parent).toBe(entries[0].node)
    },
  )

  it("validates the entire layout and owned dock before returning any ordinary nodes", () => {
    const input = addPanel(layout(), { name: "alpha" })
    findNode(input, DOCK_ID).custom = true
    expect(() => ordinaryNodes(freeze(input))).toThrow(/structure changed.*custom/)
    const invalid = container("root", "row", [block("a"), block("a")])
    expect(() => ordinaryNodes(freeze(invalid))).toThrow(/Duplicate layout id/)
  })
})

describe("render-scoped placement validation", () => {
  it.each([existing("a"), existing("root"), fresh(), fresh("alpha", []), null])(
    "matches fresh validation for every side and destination with %j",
    (source) => {
      const input = container("root", "column", [
        container("a", "row", [block("leaf")]),
        block("b"),
      ])
      const validator = placementValidator(freeze(input), source)
      for (const id of [...validator.entries.map(({ node }) => node.id), "missing", ""]) {
        for (const side of ["left", "right", "top", "bottom", "invalid"]) {
          expect(validator.error(id, side)).toBe(placementError(input, source, id, side))
        }
      }
    },
  )

  it("does not revisit layout nodes when checking all destinations and sides", () => {
    let reads = 0
    const children = Array.from({ length: 1000 }, (_, index) => ({
      ...block(`node-${index}`),
      get id() {
        reads += 1
        return `node-${index}`
      },
    }))
    const validator = placementValidator(container("root", "row", children), existing("node-0"))
    const initialReads = reads
    for (let index = 1; index < children.length; index += 1) {
      for (const side of ["left", "right", "top", "bottom"]) {
        expect(validator.error(`node-${index}`, side)).toBe("")
      }
    }
    expect(reads).toBe(initialReads)
  })
})

describe("four-side placement and sizing", () => {
  it.each(sides)("inserts a new view on the %s in an existing %s", (side, axis, before) => {
    const input = container("root", axis, [block("a"), block("target"), block("c")], {
      resizable: true,
      gap: 7,
    })
    const result = place(input, fresh("alpha", { file: "new.md" }), "target", side)
    const added = result.children[before ? 1 : 2]
    expect(ids(result)).toEqual(
      before ? ["a", added.id, "target", "c"] : ["a", "target", added.id, "c"],
    )
    expect(added).toEqual({
      id: added.id,
      type: "block",
      content: { mod: "alpha", props: { file: "new.md" } },
    })
    expect(result.resizable).toBe(true)
    expect(result.gap).toBe(7)
    expect(result.children).toHaveLength(4)
  })

  it.each(sides)("wraps an opposite-axis target on its %s", (side, axis, before) => {
    const target = container("target", "row", [block("inner")], {
      size: { ratio: 2 },
      min: 15,
      max: 500,
      resizable: true,
      gap: 11,
      hidden: true,
      background: "paint",
      divider: { width: 3 },
      padding: [1, 2],
    })
    const input = container("root", axis === "row" ? "column" : "row", [target, block("other")])
    const result = place(input, fresh(), "target", side)
    const wrapper = result.children[0]
    const inner = wrapper.children[before ? 1 : 0]
    expect(wrapper).toEqual({
      id: wrapper.id,
      type: axis,
      children: wrapper.children,
      size: { ratio: 2 },
      min: 15,
      max: 500,
    })
    const expectedTarget = copy(target)
    for (const key of ["size", "min", "max"]) delete expectedTarget[key]
    expect(inner).toEqual(expectedTarget)
    expect(result.children[1]).toEqual(input.children[1])
  })

  it.each(sides)(
    "moves within the same parent to the %s without index drift",
    (side, axis, before) => {
      const input = container("root", axis, [block("a"), block("b"), block("c"), block("d")])
      const result = place(input, existing("a"), "c", side)
      expect(ids(result)).toEqual(before ? ["b", "a", "c", "d"] : ["b", "c", "a", "d"])
      const reverse = place(result, existing("d"), "b", side)
      expect(ids(reverse)).toEqual(before ? ["d", "b", "a", "c"] : ["b", "d", "c", "a"])
    },
  )

  it.each(sides)(
    "returns the original identity for a genuine adjacent %s no-op",
    (side, axis, before) => {
      const input = container("root", axis, [block("a"), block("b"), block("c")])
      expect(place(input, existing(before ? "a" : "c"), "b", side)).toBe(input)
    },
  )

  it.each(sides)("does not treat opposite-axis adjacent %s placement as a no-op", (side, axis) => {
    const input = container("root", axis === "row" ? "column" : "row", [block("a"), block("b")])
    const result = place(input, existing("a"), "b", side)
    expect(result).not.toBe(input)
    expect(result.children).toHaveLength(1)
    expect(result.children[0].type).toBe(axis)
  })

  it.each(sides)(
    "moves across parents on the %s and keeps source constraints unchanged",
    (side, axis, before) => {
      const moving = block("moving", { size: { px: 123 }, min: 10, max: 222, resizable: false })
      const input = container("root", "row", [
        container("from", axis === "row" ? "column" : "row", [moving]),
        container("to", axis, [block("target"), block("last")]),
      ])
      const result = place(input, existing("moving"), "target", side)
      expect(findNode(result, "from")).toEqual({ ...input.children[0], children: [] })
      expect(ids(findNode(result, "to"))).toEqual(
        before ? ["moving", "target", "last"] : ["target", "moving", "last"],
      )
      expect(findNode(result, "moving")).toEqual(moving)
    },
  )

  it.each(sides)(
    "keeps cross-axis source sizes and transfers only target constraints on %s",
    (side, axis) => {
      const moving = container("moving", "column", [block("child")], {
        size: { percent: 35 },
        min: { px: 12 },
        max: 400,
        resizable: true,
        gap: 9,
      })
      const target = block("target", { size: { px: 80 }, min: 20, max: 100, hidden: false })
      const input = container("root", axis === "row" ? "column" : "row", [
        container("from", axis, [moving]),
        target,
      ])
      const result = place(input, existing("moving"), "target", side)
      expect(findNode(result, "moving")).toEqual(moving)
      expect(result.children[1]).toMatchObject({ type: axis, size: target.size, min: 20, max: 100 })
      expect(findNode(result, "target")).toEqual(block("target", { hidden: false }))
      expect(result.children[1]).not.toHaveProperty("resizable")
    },
  )

  it("does not create absent size, min, max or resizable fields", () => {
    const result = place(container("root", "stack", [block("a")]), fresh(), "a", "left")
    for (const node of ordinaryNodes(result).map(({ node }) => node)) {
      for (const key of ["size", "min", "max", "resizable", "active"]) {
        expect(Object.hasOwn(node, key)).toBe(false)
      }
    }
  })
})

describe("container moves and ancestor targets", () => {
  it.each(sides)("moves a container as one complete subtree to the %s", (side, axis) => {
    const moving = container("moving", "stack", [block("one"), block("two")], {
      active: "two",
      header: { content: { mod: "header" } },
      custom: { keep: [true] },
    })
    const input = container("root", axis, [block("target"), container("from", "column", [moving])])
    const result = place(input, existing("moving"), "target", side)
    expect(findNode(result, "moving")).toEqual(moving)
    expect(findNode(result, "from").children).toEqual([])
    expect(ordinaryNodes(result).filter(({ node }) => node.content?.terminal)).toHaveLength(3)
  })

  it.each(sides)(
    "detaches a descendant before placing it beside an ancestor on the %s",
    (side, axis, before) => {
      const input = container("root", axis, [
        container("ancestor", "column", [container("from", "row", [block("moving")])]),
        block("last"),
      ])
      const result = place(input, existing("moving"), "ancestor", side)
      expect(ids(result)).toEqual(
        before ? ["moving", "ancestor", "last"] : ["ancestor", "moving", "last"],
      )
      expect(findNode(result, "from").children).toEqual([])
    },
  )

  it.each(sides)(
    "wraps an ancestor after detaching its descendant on the %s",
    (side, axis, before) => {
      const input = container("root", axis === "row" ? "column" : "row", [
        container("ancestor", "stack", [block("moving")], { active: "moving" }),
        block("last"),
      ])
      const result = place(input, existing("moving"), "ancestor", side)
      expect(ids(result.children[0])).toEqual(
        before ? ["moving", "ancestor"] : ["ancestor", "moving"],
      )
      expect(findNode(result, "ancestor")).toEqual(container("ancestor", "stack", []))
    },
  )

  it("allows a direct child to be placed beside its root after detaching", () => {
    const input = container("root", "row", [block("moving")], { gap: 6 })
    const result = place(input, existing("moving"), "root", "left")
    expect(result.id).not.toBe("root")
    expect(ids(result)).toEqual(["moving", "root"])
    expect(findNode(result, "root")).toEqual(container("root", "row", [], { gap: 6 }))
  })
})

describe("stack active repair", () => {
  it.each([
    ["a", "a", "b"],
    ["a", "b", "b"],
    ["b", "b", "a"],
    ["b", "c", "c"],
    ["c", undefined, undefined],
  ])("removes %s with active %s and selects only when required", (moving, active, expected) => {
    const fields = active === undefined ? {} : { active }
    const input = container("root", "row", [
      container("tabs", "stack", [block("a"), block("b"), block("c")], fields),
      block("target"),
    ])
    const result = place(input, existing(moving), "target", "left")
    const tabs = findNode(result, "tabs")
    expect(tabs.active).toBe(expected)
    expect(Object.hasOwn(tabs, "active")).toBe(expected !== undefined)
  })

  it.each([true, false])(
    "keeps an empty authored stack and clears active (explicit=%s)",
    (explicit) => {
      const input = container("root", "column", [
        container("tabs", "stack", [block("moving")], explicit ? { active: "moving" } : {}),
        block("target"),
      ])
      const result = place(input, existing("moving"), "target", "bottom")
      expect(findNode(result, "tabs")).toEqual(container("tabs", "stack", []))
    },
  )

  it.each(sides)("maps selected target child to its new %s wrapper", (side) => {
    const input = container("root", "stack", [block("target"), block("other")], {
      active: "target",
    })
    const result = place(input, fresh(), "target", side)
    expect(result.active).toBe(result.children[0].id)
    expect(findNode(result, "target")).toEqual(input.children[0])
  })

  it.each([undefined, "other"])("preserves unrelated or absent active %s on wrapping", (active) => {
    const input = container(
      "root",
      "stack",
      [block("target"), block("other")],
      active === undefined ? {} : { active },
    )
    const result = place(input, fresh(), "target", "right")
    expect(result.active).toBe(active)
    expect(Object.hasOwn(result, "active")).toBe(active !== undefined)
  })

  it("repairs a selected removed sibling before wrapping the new selected child", () => {
    const input = container("root", "stack", [block("moving"), block("target"), block("other")], {
      active: "moving",
    })
    const result = place(input, existing("moving"), "target", "top")
    expect(result.active).toBe(result.children[0].id)
    expect(ids(result.children[0])).toEqual(["moving", "target"])
  })

  it("does not repair an ancestor stack when a nested descendant moves", () => {
    const tabs = container("tabs", "stack", [container("selected", "row", [block("moving")])], {
      active: "selected",
    })
    const input = container("root", "row", [tabs, block("target")])
    const result = place(input, existing("moving"), "target", "left")
    expect(findNode(result, "tabs").active).toBe("selected")
  })
})

describe("root settings and legacy coexistence", () => {
  const settings = Object.fromEntries(ROOT_FIELDS.map((key) => [key, { keep: key }]))

  it.each(sides)(
    "promotes the shared root fields to a new %s document split",
    (side, axis, before) => {
      const input = block("root", {
        ...settings,
        size: { px: 300 },
        min: 20,
        max: 800,
        gap: 4,
        resizable: true,
        hidden: false,
        custom: { keep: true },
      })
      const result = place(input, fresh(), "root", side)
      expect(result).toMatchObject({
        ...settings,
        type: axis,
        size: { px: 300 },
        min: 20,
        max: 800,
      })
      expect(result.children[before ? 1 : 0]).toEqual(
        block("root", { gap: 4, resizable: true, hidden: false, custom: { keep: true } }),
      )
      for (const key of ROOT_FIELDS)
        expect(Object.hasOwn(findNode(result, "root"), key)).toBe(false)
      expect(Object.hasOwn(result, "resizable")).toBe(false)
    },
  )

  it("retains root settings and style when inserting within the existing root axis", () => {
    const input = { ...layout(), ...settings, gap: 12, resizable: true }
    const result = place(input, fresh(), "b", "left")
    expect(result.id).toBe("root")
    for (const key of ROOT_FIELDS) expect(result[key]).toEqual(settings[key])
    expect(result.gap).toBe(12)
    expect(result.resizable).toBe(true)
  })

  it.each(sides)(
    "wraps only the legacy body on the %s and supports old final removal",
    (side, axis, before) => {
      const original = { ...layout(), ...settings }
      const input = moveDock(addPanel(original, { name: "managed", props: { keep: [1] } }), "top")
      const result = place(input, fresh("new-view"), "root", side)
      expect(result.id).toBe(FRAME_ID)
      expect(result.type).toBe(input.type)
      expect(result.children[0]).toEqual(input.children[0])
      expect(managedSlots(result)).toEqual(managedSlots(input))
      const body = ordinaryNodes(result)[0].node
      expect(body.type).toBe(axis)
      expect(body.children[before ? 1 : 0].id).toBe("root")
      expect(ordinaryNodes(result)[0].parent).toBeNull()
      expect(result).toEqual({ ...input, children: [input.children[0], body] })
      const restored = removePanel(freeze(result), "managed")
      expect(restored).toEqual({ ...body, ...settings })
      expect(restored.id).toBe(body.id)
      expect(findNode(restored, "root")).toEqual(findNode(input, "root"))
      expect(managedSlots(restored)).toEqual([])
    },
  )

  it("moves a legacy body descendant beside the body without moving the frame or dock", () => {
    const input = addPanel({ ...layout(), ...settings }, { name: "managed" })
    const result = place(input, existing("a"), "root", "top")
    expect(result.id).toBe(FRAME_ID)
    expect(findNode(result, DOCK_ID)).toEqual(findNode(input, DOCK_ID))
    const body = ordinaryNodes(result)[0].node
    expect(ids(body)).toEqual(["a", "root"])
    expect(ids(findNode(result, "root"))).toEqual(["b", "c"])
    expect(removePanel(result, "managed")).toEqual({ ...body, ...settings })
  })
})

describe("IDs, exact instances and opaque fields", () => {
  it.each(["alpha.v2_3", "constructor", "toString", "hasOwnProperty", "layout-manager-frame"])(
    "adds multiple instances of %s without reusing IDs or the reserved namespace",
    (name) => {
      const input = container("root", "stack", [block("a"), block(`view-${name}`)])
      const first = place(input, fresh(name), "a", "left")
      const result = place(first, fresh(name), "a", "top")
      const views = ordinaryNodes(result).filter(({ node }) => node.content?.mod === name)
      expect(views).toHaveLength(2)
      expect(views[0].node.id).not.toBe(views[1].node.id)
      for (const { node } of ordinaryNodes(result)) {
        expect(node.id.startsWith("layout-manager-")).toBe(false)
      }
    },
  )

  it("avoids IDs of new views, wrappers, source nodes and arbitrary prototype keys", () => {
    const input = container("constructor", "stack", [
      block("view-constructor"),
      block("view-constructor-1"),
      block("split"),
      block("split-1"),
      block("__proto__"),
      block("toString"),
    ])
    const added = place(input, fresh("constructor"), "__proto__", "left")
    expect(findNode(added, "view-constructor-2").content.mod).toBe("constructor")
    expect(findNode(added, "split-2").type).toBe("row")
    const result = place(added, existing("split"), "toString", "bottom")
    expect(findNode(result, "split-3").type).toBe("column")
    expect(findNode(result, "split")).toEqual(block("split"))
  })

  it("moves an unavailable existing mod without inventory lookup or a new mod instance", () => {
    const moving = block("missing", {
      content: { mod: "unavailable.mod", props: { restore: ["session", { key: 1 }] } },
      hidden: true,
    })
    const sameMod = block("other-instance", {
      content: { mod: "unavailable.mod", props: { key: 2 } },
    })
    const input = container("root", "column", [moving, sameMod, block("target")])
    const result = place(input, existing("missing"), "target", "left")
    expect(findNode(result, "missing")).toEqual(moving)
    expect(findNode(result, "other-instance")).toEqual(sameMod)
    expect(
      ordinaryNodes(result).filter(({ node }) => node.content?.mod === "unavailable.mod"),
    ).toHaveLength(2)
  })

  it("preserves opaque data, special property names and unrelated subtrees on frozen input", () => {
    const opaque = JSON.parse(
      '{"__proto__":{"safe":[1]},"constructor":{"keep":true},"children":[{"id":"a","type":"invalid"}]}',
    )
    const moving = container("moving", "stack", [block("child")], {
      active: "child",
      content: { tab: "active", pane: { layout: opaque, header: opaque }, props: opaque },
      header: opaque,
      floating: [opaque],
      custom: opaque,
    })
    const unrelated = container("unrelated", "row", [block("u", { content: opaque })], { gap: 8 })
    const input = container("root", "row", [moving, unrelated, block("target")], { custom: opaque })
    const result = place(input, existing("moving"), "target", "top")
    expect(findNode(result, "moving")).toEqual(moving)
    expect(findNode(result, "unrelated")).toEqual(unrelated)
    expect(result.custom).toEqual(opaque)
    expect(Object.hasOwn(findNode(result, "moving").custom, "__proto__")).toBe(true)
    expect({}.safe).toBeUndefined()
    Object.getOwnPropertyDescriptor(findNode(result, "moving").custom, "__proto__").value.safe.push(
      2,
    )
    expect(Object.getOwnPropertyDescriptor(moving.custom, "__proto__").value.safe).toEqual([1])
  })

  it("copies supplied props and preserves JSON prototype keys", () => {
    const props = freeze(JSON.parse('{"__proto__":{"keep":[true]},"constructor":"safe"}'))
    const result = place(layout(), fresh("alpha", props), "b", "left")
    const added = ordinaryNodes(result).find(({ node }) => node.content?.mod === "alpha").node
    expect(added.content.props).toEqual(props)
    expect(added.content.props).not.toBe(props)
    expect(Object.hasOwn(added.content.props, "__proto__")).toBe(true)
  })
})

describe("invalid placements fail without changing input", () => {
  it.each(["", "center", "LEFT", null, undefined, 42, {}, "constructor"])(
    "rejects invalid side %j",
    (side) => reject(layout(), existing("a"), "b", side, /side must be left/),
  )

  it.each(["", " ", null, undefined, 42, {}, "missing", "__proto__"])(
    "rejects missing destination %j",
    (target) => reject(layout(), existing("a"), target, "left", /destination|Destination/),
  )

  it.each([null, undefined, [], "a", {}, { kind: "wrong" }])(
    "rejects invalid source %j",
    (source) => {
      reject(layout(), source, "b", "left", /source|Source/)
    },
  )

  it.each(["", " ", undefined, null, 42, {}, "missing", "__proto__"])(
    "rejects missing source ID %j",
    (id) => reject(layout(), existing(id), "b", "left", /source|Source/),
  )

  it("rejects the document root as source and self-placement", () => {
    reject(layout(), existing("root"), "b", "left", /root.*cannot be moved/)
    reject(layout(), existing("b"), "b", "left", /itself/)
  })

  it.each(sides)("rejects moving a container beside its descendant on the %s", (side) => {
    const input = container("root", "column", [
      container("ancestor", "stack", [container("nested", "row", [block("leaf")])]),
    ])
    reject(input, existing("ancestor"), "leaf", side, /own descendants/)
  })

  it.each(["", "../bad", "a/b", "two words", "-bad", "__proto__", null, 42])(
    "rejects invalid new mod name %j",
    (name) => reject(layout(), fresh(name), "a", "left", /mod name/),
  )

  it.each([
    null,
    [],
    "text",
    42,
    { bad: undefined },
    { bad: Number.NaN },
    { bad: Infinity },
    { bad: () => 1 },
    { bad: new Date() },
  ])("rejects invalid new props %j", (props) =>
    reject(layout(), fresh("alpha", props), "a", "left", /Props/),
  )

  it("rejects circular new props and accepts omitted optional props", () => {
    const props = {}
    props.self = props
    reject(layout(), fresh("alpha", props), "a", "left", /circular/)
    const result = place(layout(), { kind: "new", name: "alpha" }, "a", "left")
    expect(findNode(result, "view-alpha").content.props).toEqual({})
  })

  it.each([FRAME_ID, DOCK_ID, HEADER_ID, STACK_ID, "layout-manager-mod-alpha"])(
    "rejects managed boundary %s as source or destination",
    (id) => {
      const input = addPanel(layout(), { name: "alpha" })
      reject(input, existing(id), "a", "left", /outside the ordinary layout body/)
      reject(input, existing("a"), id, "left", /outside the ordinary layout body/)
      reject(input, fresh(), id, "left", /outside the ordinary layout body/)
    },
  )

  it("rejects the original legacy body as source", () => {
    reject(
      addPanel(layout(), { name: "alpha" }),
      existing("root"),
      "a",
      "top",
      /body cannot be moved/,
    )
  })

  it("rejects node-like IDs inside opaque fields", () => {
    const input = layout()
    input.children[0].content = { pane: { layout: block("opaque") } }
    reject(input, existing("opaque"), "b", "left", /outside the ordinary layout body/)
    reject(input, existing("a"), "opaque", "left", /outside the ordinary layout body/)
  })

  it.each([
    ["duplicate IDs", () => container("root", "row", [block("a"), block("a")]), /Duplicate/],
    ["unknown node type", () => ({ id: "root", type: "other" }), /type block/],
    ["missing node ID", () => ({ type: "row", children: [] }), /nonempty string id/],
    [
      "invalid children",
      () => ({ id: "root", type: "row", children: {} }),
      /children must be an array/,
    ],
    [
      "invalid active",
      () => container("root", "stack", [block("a")], { active: "missing" }),
      /active/,
    ],
    ["reserved foreign ID", () => container("root", "row", [block(DOCK_ID)]), /Reserved layout id/],
    ["foreign frame", () => container(FRAME_ID, "row", [block("a")]), /structure changed/],
    [
      "nested managed frame",
      () => container("outer", "row", [addPanel(layout(), { name: "alpha" })]),
      /must be the layout root/,
    ],
  ])("validates %s before source or side errors", (_label, make, pattern) => {
    const input = make()
    reject(input, null, "missing", "invalid", pattern)
    expect(() => ordinaryNodes(input)).toThrow(pattern)
  })

  it("fails closed for modified owned nodes even on an otherwise adjacent no-op", () => {
    const input = addPanel(layout(), { name: "alpha" })
    findNode(input, STACK_ID).custom = { foreign: true }
    reject(input, existing("a"), "b", "left", /structure changed/)
  })
})
