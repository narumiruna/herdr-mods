export const MOD_NAME = "layout-manager"
export const FRAME_ID = "layout-manager-frame"
export const DOCK_ID = "layout-manager-dock"
export const HEADER_ID = "layout-manager-header"
export const STACK_ID = "layout-manager-stack"

const SLOT_PREFIX = "layout-manager-mod-"
const RESERVED_IDS = new Set([FRAME_ID, DOCK_ID, HEADER_ID, STACK_ID])
const NODE_TYPES = new Set(["block", "row", "column", "stack"])
const ROOT_FIELDS = [
  "titlebar",
  "traffic_lights",
  "terminal_menu",
  "toast",
  "preview",
  "cloned_from",
  "theme",
  "colors",
  "font",
  "font_size",
  "ui_font",
  "terminal_padding",
  "terminal_opacity",
  "movable",
  "background",
]

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Copy JSON-shaped data without discarding unknown fields or special property names.
function copy(value) {
  if (Array.isArray(value)) return value.map(copy)
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
  }
  return value
}

export function validName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
}

function checkName(name) {
  if (!validName(name)) {
    throw new Error(
      "Use a nonempty mod name with letters, digits, dots, underscores or hyphens; start with a letter or digit.",
    )
  }
}

function checkProps(props) {
  if (!isObject(props))
    throw new Error("Props must be a JSON object, not null, an array or a scalar.")
  const ancestors = new Set()
  function check(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number" && Number.isFinite(value)) return
    if (!Array.isArray(value) && !isObject(value)) {
      throw new Error("Props must contain only JSON values.")
    }
    if (ancestors.has(value)) throw new Error("Props must not contain a circular reference.")
    ancestors.add(value)
    for (const item of Object.values(value)) check(item)
    ancestors.delete(value)
  }
  check(props)
}

export function parseProps(text) {
  if (typeof text !== "string") throw new Error("Enter props as JSON text containing an object.")
  if (!text.trim()) return {}
  let props
  try {
    props = JSON.parse(text)
  } catch {
    throw new Error("Props contain invalid JSON. Enter an object such as {}.")
  }
  checkProps(props)
  return props
}

/** Validate only the documented node tree, not terminal or pane internals. */
export function validateLayout(root) {
  const ids = new Set()
  function visit(node, path) {
    if (!isObject(node)) throw new Error(`Layout node at ${path} must be an object.`)
    if (!NODE_TYPES.has(node.type)) {
      throw new Error(`Layout node at ${path} needs type block, row, column or stack.`)
    }
    if (typeof node.id !== "string" || !node.id.trim()) {
      throw new Error(`Layout node at ${path} needs a nonempty string id.`)
    }
    if (ids.has(node.id))
      throw new Error(`Duplicate layout id "${node.id}". Give each node a unique id.`)
    ids.add(node.id)
    if (Object.hasOwn(node, "children")) {
      if (!Array.isArray(node.children)) {
        throw new Error(`Layout node "${node.id}" children must be an array.`)
      }
      for (const [index, child] of node.children.entries()) {
        visit(child, `${path}.children[${index}]`)
      }
    }
    if (node.type === "stack" && Object.hasOwn(node, "active")) {
      if (
        typeof node.active !== "string" ||
        !node.children?.some((child) => child.id === node.active)
      ) {
        throw new Error(`Stack "${node.id}" active must name one of its direct children.`)
      }
    }
  }
  visit(root, "root")
  return root
}

function nodes(root) {
  const result = []
  function visit(node) {
    result.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return result
}

export function findNode(root, id) {
  validateLayout(root)
  return nodes(root).find((node) => node.id === id) ?? null
}

function reserved(id) {
  return RESERVED_IDS.has(id) || id.startsWith(SLOT_PREFIX)
}

function ownedError(detail) {
  throw new Error(
    `Layout Manager structure changed: ${detail}. Restore the owned frame before changing managed panels.`,
  )
}

function checkKeys(value, allowed, label) {
  if (!isObject(value)) ownedError(`${label} must be an object`)
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra !== undefined) ownedError(`${label} has unexpected field "${extra}"`)
}

function checkSize(size, px, label) {
  checkKeys(size, ["px"], `${label} size`)
  if (size.px !== px) ownedError(`${label} size must be ${px}px`)
}

/** Return the owned nodes only after checking the complete reserved namespace. */
function owned(root) {
  validateLayout(root)
  const all = nodes(root)
  const frame = all.find((node) => node.id === FRAME_ID)
  if (!frame) {
    const collision = all.find((node) => reserved(node.id))
    if (collision) {
      throw new Error(
        `Reserved layout id "${collision.id}" is outside the Layout Manager frame. Rename that node first.`,
      )
    }
    return null
  }
  if (frame !== root) ownedError(`"${FRAME_ID}" must be the layout root`)
  checkKeys(frame, ["id", "type", "children", "divider", "background", ...ROOT_FIELDS], "frame")
  if (frame.type !== "row" || frame.children?.length !== 2) {
    ownedError("frame must be a row containing the original body and one dock")
  }
  checkKeys(frame.divider, ["width", "color"], "frame divider")
  if (frame.divider.width !== 1 || frame.divider.color !== "border") {
    ownedError("frame divider must have width 1 and color border")
  }
  const [body, dock] = frame.children
  if (dock.id !== DOCK_ID || dock.type !== "column" || dock.children?.length !== 2) {
    ownedError(`the second frame child must be column "${DOCK_ID}" with a header and stack`)
  }
  checkKeys(
    dock,
    ["id", "type", "children", "size", "min", "max", "background", "resizable", "hidden"],
    "dock",
  )
  checkKeys(dock.size, ["px"], "dock size")
  if (!Number.isFinite(dock.size.px) || dock.size.px < 240 || dock.size.px > 900) {
    ownedError("dock size must be between 240px and 900px")
  }
  if (
    dock.min !== 240 ||
    dock.max !== 900 ||
    dock.background !== "chrome" ||
    dock.resizable !== false
  ) {
    ownedError("dock must keep min 240, max 900, background chrome and resizable false")
  }
  if (Object.hasOwn(dock, "hidden") && typeof dock.hidden !== "boolean") {
    ownedError("dock hidden must be a boolean")
  }
  const [header, stack] = dock.children
  if (header.id !== HEADER_ID || header.type !== "block") {
    ownedError(`dock must start with block "${HEADER_ID}"`)
  }
  checkKeys(header, ["id", "type", "size", "content"], "dock header")
  checkSize(header.size, 36, "dock header")
  checkKeys(header.content, ["mod", "props"], "dock header content")
  if (header.content.mod !== MOD_NAME) ownedError(`dock header must use mod "${MOD_NAME}"`)
  checkKeys(header.content.props, ["mode", "titles"], "dock header props")
  if (header.content.props.mode !== "dock") ownedError("dock header mode must be dock")
  const titles = header.content.props.titles
  if (!isObject(titles)) ownedError("dock header titles must be an object")
  if (stack.id !== STACK_ID || stack.type !== "stack" || !Array.isArray(stack.children)) {
    ownedError(`dock must end with stack "${STACK_ID}"`)
  }
  checkKeys(stack, ["id", "type", "children", "active"], "dock stack")
  const allowed = new Set([frame, dock, header, stack])
  const names = new Set()
  for (const slot of stack.children) {
    checkKeys(slot, ["id", "type", "content"], `managed slot "${slot.id}"`)
    checkKeys(slot.content, ["mod", "props"], `managed slot "${slot.id}" content`)
    const name = slot.content.mod
    if (slot.type !== "block" || !validName(name) || slot.id !== SLOT_PREFIX + name) {
      ownedError(`slot "${slot.id}" must be a block with its matching managed mod id`)
    }
    if (names.has(name)) ownedError(`mod "${name}" has more than one managed slot`)
    checkProps(slot.content.props ?? {})
    names.add(name)
    allowed.add(slot)
  }
  for (const [name, title] of Object.entries(titles)) {
    if (!names.has(name)) ownedError(`title "${name}" has no managed slot`)
    if (title !== null && typeof title !== "string") {
      ownedError(`title for "${name}" must be a string`)
    }
  }
  const collision = all.find((node) => reserved(node.id) && !allowed.has(node))
  if (collision) ownedError(`reserved id "${collision.id}" is outside its owned position`)
  return { body, dock, header, stack, titles }
}

export function managedSlots(root) {
  const structure = owned(root)
  if (!structure) return []
  return structure.stack.children.map((slot) => {
    const name = slot.content.mod
    const title = Object.hasOwn(structure.titles, name) ? structure.titles[name] : null
    return { id: slot.id, name, title: title ?? name, props: copy(slot.content.props ?? {}) }
  })
}

/** Describe mod placements without following or executing their props. */
export function references(root, name) {
  const managed = new Set(managedSlots(root).map((slot) => slot.id))
  const result = []
  function add(content, id, role) {
    if (isObject(content) && typeof content.mod === "string" && content.mod === name) {
      result.push({ id, role, managed: role === "content" && managed.has(id) })
    }
  }
  for (const node of nodes(root)) {
    add(node.content, node.id, "content")
    if (isObject(node.content) && Object.hasOwn(node.content, "tab")) {
      add(node.content.pane?.header?.content, node.id, "pane-header")
    }
    if (node.type === "stack" && isObject(node.header)) {
      add(node.header.content, node.id, "stack-header")
    }
    if (Array.isArray(node.floating)) {
      for (const floating of node.floating) {
        if (isObject(floating)) add(floating.content, floating.id ?? node.id, "floating")
      }
    }
  }
  return result
}

function wrap(body) {
  const frame = {
    id: FRAME_ID,
    type: "row",
    divider: { width: 1, color: "border" },
    children: [
      body,
      {
        id: DOCK_ID,
        type: "column",
        size: { px: 380 },
        min: 240,
        max: 900,
        background: "chrome",
        resizable: false,
        children: [
          {
            id: HEADER_ID,
            type: "block",
            size: { px: 36 },
            content: { mod: MOD_NAME, props: { mode: "dock", titles: {} } },
          },
          { id: STACK_ID, type: "stack", children: [] },
        ],
      },
    ],
  }
  for (const key of ROOT_FIELDS) {
    if (Object.hasOwn(body, key)) {
      frame[key] = body[key]
      delete body[key]
    }
  }
  return frame
}

export function addPanel(root, { name, title = name, props = {} }) {
  checkName(name)
  checkProps(props)
  if (typeof title !== "string") throw new Error("Panel title must be a string.")
  const existing = owned(root)
  const result = existing ? copy(root) : wrap(copy(root))
  const { dock, header, stack } = owned(result)
  const slot = stack.children.find((child) => child.content.mod === name)
  if (slot) slot.content.props = copy(props)
  else
    stack.children.push({
      id: SLOT_PREFIX + name,
      type: "block",
      content: { mod: name, props: copy(props) },
    })
  header.content.props.titles = { ...header.content.props.titles, [name]: title }
  stack.active = SLOT_PREFIX + name
  dock.hidden = false
  owned(result)
  return result
}

export function removePanel(root, name) {
  checkName(name)
  const structure = owned(root)
  if (!structure?.stack.children.some((slot) => slot.content.mod === name)) {
    throw new Error(
      `Mod "${name}" is not managed by Layout Manager. Select a panel from the managed dock.`,
    )
  }
  const result = copy(root)
  const { body, header, stack } = owned(result)
  stack.children = stack.children.filter((slot) => slot.content.mod !== name)
  delete header.content.props.titles[name]
  if (!stack.children.length) {
    // Absence on the current frame is deliberate: do not restore stale body settings.
    for (const key of ROOT_FIELDS) {
      delete body[key]
      if (Object.hasOwn(result, key)) body[key] = result[key]
    }
    owned(body)
    return body
  }
  if (!stack.children.some((slot) => slot.id === stack.active)) stack.active = stack.children[0].id
  owned(result)
  return result
}
