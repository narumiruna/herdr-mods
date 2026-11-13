// Markdown click routing for Better Files. The reader validates canonical paths.
export function markdownRoot(cwd, workspace) {
  if (typeof cwd !== "string") return cwd
  if (typeof workspace !== "string" || !workspace) return cwd
  const normalize = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  let folder = normalize(cwd)
  let root = normalize(workspace)
  if (/^[a-z]:/i.test(folder)) {
    folder = folder.toLowerCase()
    root = root.toLowerCase()
  }
  return folder === root || folder.startsWith(`${root}/`) ? workspace : cwd
}

export function markdownEntry(path, context) {
  if (typeof path !== "string" || !/\.(md|markdown)$/i.test(path)) return null
  const { cwd, root, on, space } = context || {}
  const controls = (value) => [...value].some((char) => char.charCodeAt(0) < 32)
  const absolute = (value) =>
    typeof value === "string" && /^(?:\/(?!\/)|[a-z]:[\\/])/i.test(value) && !controls(value)
  if (
    !absolute(cwd) ||
    !absolute(root) ||
    typeof space !== "string" ||
    !space ||
    !(on === null || (typeof on === "string" && on.length > 0)) ||
    controls(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Markdown Reader requires an absolute file location and workspace folder")
  }
  return { file: `${cwd.replace(/[\\/]$/, "")}/${path}`, root, on }
}
