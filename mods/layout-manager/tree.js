import {
  checkProps,
  copy,
  DOCK_ID,
  FRAME_ID,
  managedSlots,
  ROOT_FIELDS,
  validateLayout,
  validName,
} from "./model.js"

const SIDES = new Set(["left", "right", "top", "bottom"])
const SIZE_FIELDS = ["size", "min", "max"]

/** Traverse only structural children, after validating all managed boundaries. */
export function ordinaryNodes(root) {
  validateLayout(root)
  managedSlots(root)
  const body = root.id === FRAME_ID ? root.children.find((child) => child.id !== DOCK_ID) : root
  const result = []
  function visit(node, parent, depth) {
    result.push({ node, parent, depth })
    for (const child of node.children ?? []) visit(child, node, depth + 1)
  }
  visit(body, null, 0)
  return result
}

/** Shared validation for target eligibility and immutable placement. */
export function placementError(root, source, targetId, side) {
  try {
    const entries = ordinaryNodes(root)
    const byId = new Map(entries.map((entry) => [entry.node.id, entry]))
    if (!SIDES.has(side)) return "Placement side must be left, right, top or bottom."
    if (typeof targetId !== "string" || !targetId.trim()) {
      return "Select a destination node with a nonempty ID."
    }
    const target = byId.get(targetId)
    if (!target) return `Destination "${targetId}" is missing or outside the ordinary layout body.`
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return "Select an existing node or a new view as the source."
    }
    if (source.kind === "new") {
      if (!validName(source.name)) {
        return "Use a nonempty mod name with letters, digits, dots, underscores or hyphens; start with a letter or digit."
      }
      checkProps(source.props === undefined ? {} : source.props)
      return ""
    }
    if (source.kind !== "node") return "Source kind must be node or new."
    if (typeof source.id !== "string" || !source.id.trim()) {
      return "Select a source node with a nonempty ID."
    }
    const from = byId.get(source.id)
    if (!from) return `Source "${source.id}" is missing or outside the ordinary layout body.`
    if (!from.parent) return "The layout root or original body cannot be moved."
    if (source.id === targetId) return "A node cannot be placed beside itself."
    for (let ancestor = target.parent; ancestor; ancestor = byId.get(ancestor.id).parent) {
      if (ancestor.id === source.id) {
        return "A container cannot be placed beside one of its own descendants."
      }
    }
    return ""
  } catch (error) {
    return error.message
  }
}

function nextId(ids, base) {
  let id = base
  for (let suffix = 1; ids.has(id); suffix += 1) id = `${base}-${suffix}`
  ids.add(id)
  return id
}

function transferFields(from, to, fields) {
  for (const key of fields) {
    if (Object.hasOwn(from, key)) {
      to[key] = from[key]
      delete from[key]
    }
  }
}

/** Move one existing subtree or add one new view; never collapse authored containers. */
export function placeNode(root, source, targetId, side) {
  const error = placementError(root, source, targetId, side)
  if (error) throw new Error(error)
  const axis = side === "left" || side === "right" ? "row" : "column"
  const before = side === "left" || side === "top"
  const entries = ordinaryNodes(root)
  const targetEntry = entries.find(({ node }) => node.id === targetId)
  const sourceEntry =
    source.kind === "node" ? entries.find(({ node }) => node.id === source.id) : null
  if (sourceEntry?.parent === targetEntry.parent && targetEntry.parent?.type === axis) {
    const siblings = targetEntry.parent.children
    const distance = siblings.indexOf(sourceEntry.node) - siblings.indexOf(targetEntry.node)
    if (distance === (before ? -1 : 1)) return root
  }

  let result = copy(root)
  const ids = new Set(entries.map(({ node }) => node.id))
  let moving
  if (source.kind === "node") {
    const { node, parent } = ordinaryNodes(result).find(({ node }) => node.id === source.id)
    moving = node
    parent.children.splice(parent.children.indexOf(node), 1)
    if (parent.type === "stack" && parent.active === node.id) {
      if (parent.children.length) parent.active = parent.children[0].id
      else delete parent.active
    }
  } else {
    moving = {
      id: nextId(ids, `view-${source.name}`),
      type: "block",
      content: { mod: source.name, props: copy(source.props === undefined ? {} : source.props) },
    }
  }

  // Detaching can change sibling indices and the contents of an ancestor target.
  const { node: target, parent } = ordinaryNodes(result).find(({ node }) => node.id === targetId)
  if (parent?.type === axis) {
    const index = parent.children.indexOf(target)
    parent.children.splice(index + (before ? 0 : 1), 0, moving)
  } else {
    const wrapper = {
      id: nextId(ids, "split"),
      type: axis,
      children: before ? [moving, target] : [target, moving],
    }
    transferFields(target, wrapper, SIZE_FIELDS)
    if (parent) {
      parent.children.splice(parent.children.indexOf(target), 1, wrapper)
      if (parent.type === "stack" && parent.active === target.id) parent.active = wrapper.id
    } else if (result.id === FRAME_ID) {
      result.children.splice(result.children.indexOf(target), 1, wrapper)
    } else {
      transferFields(target, wrapper, ROOT_FIELDS)
      result = wrapper
    }
  }
  validateLayout(result)
  managedSlots(result)
  return result
}
