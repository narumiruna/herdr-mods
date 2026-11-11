// Pure transforms for the reviewed, installed Files source. No installed source is bundled.
export const FILES_SOURCE_SHA256 =
  "33a7f26f03b9b3579d30fc97498b9f3cbbdcb59b983c91ce6bea3cc2eabe273b"
export const REQUIRED_ICONS = ["chevron-down.svg", "chevron-right.svg", "file.svg", "folder.svg"]

export function safeName(name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("Use a lowercase name with letters, digits, or hyphens (1–64 characters)")
  }
  return name
}

export function replaceOnce(source, target, replacement) {
  const count = source.split(target).length - 1
  if (count !== 1) {
    throw new Error(`Unsupported Files source: expected one replacement target, found ${count}`)
  }
  return source.replace(target, () => replacement)
}

// This function is also emitted into the generated mod. Keep it self-contained.
// root is the workspace folder, not the pane's current directory. The reader must
// reject remote identities, then canonicalize file/root before any document read.
export function markdownTab(path, context) {
  if (!/\.(md|markdown)$/i.test(path)) return null
  const { cwd, root, on, space } = context
  const absolute = (value) =>
    typeof value === "string" && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value) && !value.includes("\0")
  if (
    !absolute(cwd) ||
    !absolute(root) ||
    typeof space !== "string" ||
    !space ||
    !(on === null || (typeof on === "string" && on.length > 0)) ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Markdown Reader requires an absolute file location and workspace folder")
  }
  return {
    space,
    name: path.split("/").pop(),
    mod: "markdown-reader",
    props: { file: `${cwd.replace(/[\\/]$/, "")}/${path}`, on, root },
  }
}

export function transformFilesSource(source, cloneName = "files-markdown") {
  safeName(cloneName)
  if (cloneName === "files" || cloneName === "markdown-reader") {
    throw new Error("The Files clone must have a separate personal name")
  }
  const replacements = [
    ["watchFolder, theme, settings, window }", "watchFolder, theme, settings, window, run }"],
    ["space: space?.id };", "space: space?.id, root: space?.folder };"],
    [
      "const { cwd, on } = location(), next = key();",
      "const { cwd, on, space, root } = location(), next = key();",
    ],
    [
      "this.context = { key: next, cwd, on };",
      "this.context = { key: next, cwd, on, space, root };",
    ],
    [
      "  rows(prefix, depth, out, t) {",
      '  openFile(path, cx, context) {\n    const tab = markdownTab(path, context);\n    if (tab) run("tab.new", tab);\n    else this.show(path, cx);\n  }\n\n  rows(prefix, depth, out, t) {\n    const context = this.context;',
    ],
    [
      ".on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))",
      ".on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.openFile(path, cx, context))",
    ],
    ["mods/files/chevron-", `mods/${cloneName}/chevron-`],
    ["mods/files/${entry.dir", `mods/${cloneName}/\${entry.dir`],
  ]
  let result = source
  for (const [target, replacement] of replacements) {
    result = replaceOnce(result, target, replacement)
  }
  return `// Personal Markdown click integration; generated offline.\nconst markdownTab = ${markdownTab.toString()};\n${result}`
}

// Change only actual content.mod references. IDs, active stack children, props,
// strings, other mod names, and source objects remain unchanged.
export function cloneLayout(layout, cloneName = "files-markdown") {
  safeName(cloneName)
  let replacements = 0
  function visit(node) {
    if (Array.isArray(node)) return node.map(visit)
    if (!node || typeof node !== "object") return node
    const result = { ...node }
    if (node.content?.mod === "files") {
      result.content = { ...node.content, mod: cloneName }
      replacements++
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children))
        throw new Error("Unsupported layout: children must be an array")
      result.children = node.children.map(visit)
    }
    // Pane headers can contain content.mod, but props are not layout nodes.
    if (node.content?.pane?.header) {
      result.content = {
        ...result.content,
        pane: { ...node.content.pane, header: visit(node.content.pane.header) },
      }
    }
    return result
  }
  if (!layout || Array.isArray(layout) || typeof layout !== "object" || layout.id !== "root") {
    throw new Error("Unsupported layout: expected a root layout node")
  }
  const result = visit(layout)
  if (!replacements) throw new Error("Unsupported layout: no content.mod Files reference")
  return { layout: result, replacements }
}
