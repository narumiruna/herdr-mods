export const GALLERY_URL = "https://herdr.dev/gallery/?type=mods"

/** @typedef {"all" | "github" | "development"} Source */

/**
 * @typedef {object} PreviewMod
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} repository
 * @property {string} version
 * @property {Exclude<Source, "all">} source
 * @property {string} icon
 */

/** @type {readonly PreviewMod[]} */
export const PREVIEW_MODS = [
  {
    id: "focus-mode",
    name: "Focus Mode",
    description: "A quieter workspace. Keep the terminal, hide the distractions.",
    repository: "example/focus-mode",
    version: "0.4.2",
    source: "github",
    icon: "focus",
  },
  {
    id: "workspace-notes",
    name: "Workspace Notes",
    description: "Keep a little context beside every project.",
    repository: "example/workspace-notes",
    version: "1.2.0",
    source: "github",
    icon: "notes",
  },
  {
    id: "terminal-tools",
    name: "Terminal Tools",
    description: "Small shortcuts for the things you do every day.",
    repository: "example/terminal-tools",
    version: "0.8.1",
    source: "github",
    icon: "terminal",
  },
  {
    id: "mod-manager",
    name: "Mod Manager",
    description: "A home for your Herdr extensions. This is the UI preview.",
    repository: "Local development checkout",
    version: "0.0.0",
    source: "development",
    icon: "package",
  },
]

/**
 * @param {string} query
 * @param {Source} source
 * @returns {readonly PreviewMod[]}
 */
export function filterMods(query, source) {
  const term = query.trim().toLowerCase()
  return PREVIEW_MODS.filter(
    (mod) =>
      (source === "all" || mod.source === source) &&
      `${mod.name} ${mod.description} ${mod.repository}`.toLowerCase().includes(term),
  )
}
