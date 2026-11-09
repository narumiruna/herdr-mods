export const GALLERY_URL = "https://herdr.dev/gallery/?type=mods"

/** @typedef {"all" | "github" | "development"} Source */
/** @typedef {"available" | "enabled" | "disabled"} ModState */
/** @typedef {"install" | "enable" | "disable" | "uninstall"} ModAction */

/**
 * @typedef {object} PreviewMod
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} repository
 * @property {string} version
 * @property {Exclude<Source, "all">} source
 * @property {string} icon
 * @property {boolean} gallery
 * @property {ModState} state
 * @property {string} [protectedReason]
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
    gallery: true,
    state: "enabled",
  },
  {
    id: "workspace-notes",
    name: "Workspace Notes",
    description: "Keep a little context beside every project.",
    repository: "example/workspace-notes",
    version: "1.2.0",
    source: "github",
    icon: "notes",
    gallery: true,
    state: "disabled",
  },
  {
    id: "terminal-tools",
    name: "Terminal Tools",
    description: "Small shortcuts for the things you do every day.",
    repository: "example/terminal-tools",
    version: "0.8.1",
    source: "github",
    icon: "terminal",
    gallery: true,
    state: "available",
  },
  {
    id: "mod-manager",
    name: "Mod Manager",
    description: "A home for your Herdr extensions. This is the UI preview.",
    repository: "Local development checkout",
    version: "0.0.0",
    source: "development",
    icon: "package",
    gallery: false,
    state: "enabled",
    protectedReason: "The running manager is a protected development link.",
  },
]

/**
 * @param {readonly PreviewMod[]} mods
 * @param {string} query
 * @param {Source} source
 */
export function filterMods(mods, query, source) {
  const term = query.trim().toLowerCase()
  return mods.filter(
    (mod) =>
      (source === "all" || mod.source === source) &&
      `${mod.name} ${mod.description} ${mod.repository}`.toLowerCase().includes(term),
  )
}

/** @param {PreviewMod} mod @returns {ModAction[]} */
export function actionsFor(mod) {
  if (mod.state === "available") return ["install"]
  return [mod.state === "enabled" ? "disable" : "enable", "uninstall"]
}

/** @param {string} input */
export function normalizeRepository(input) {
  const match = input
    .trim()
    .match(/^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]+)\/?$/i)
  const repository = match?.[2].replace(/\.git$/i, "")
  if (!repository || repository === "." || repository === ".." || repository.length > 100) {
    throw new Error("Enter a GitHub repository URL: https://github.com/owner/repository")
  }
  return `${match[1]}/${repository}`.toLowerCase()
}

// Each view owns its session. Nothing is persisted, fetched, or read from disk.
export class PreviewSession {
  mods = PREVIEW_MODS.map((mod) => ({ ...mod }))
  /** @type {{ action: ModAction, mod: PreviewMod } | null} */
  pending = null
  /** @type {string | null} */
  uninstallId = null

  /**
   * @param {"gallery" | "installed"} section
   * @param {string} query
   * @param {Source} source
   */
  list(section, query = "", source = "all") {
    return filterMods(
      this.mods.filter((mod) => (section === "gallery" ? mod.gallery : mod.state !== "available")),
      query,
      source,
    )
  }

  /** @param {string} id */
  mod(id) {
    const mod = this.mods.find((mod) => mod.id === id)
    if (!mod) throw new Error("The sample mod was not found.")
    return mod
  }

  /** @param {ModAction} action @param {PreviewMod} mod */
  validate(action, mod) {
    if (this.pending) throw new Error("Another preview action is in progress.")
    if (this.uninstallId && (action !== "uninstall" || this.uninstallId !== mod.id)) {
      throw new Error("Confirm or cancel the preview uninstall first.")
    }
    if (mod.protectedReason) throw new Error(mod.protectedReason)
    if (!actionsFor(mod).includes(action)) {
      throw new Error("This action is not available for the sample's current state.")
    }
  }

  /** @param {ModAction} action @param {string} id */
  start(action, id) {
    const mod = this.mod(id)
    this.validate(action, mod)
    if (action === "uninstall") {
      if (this.uninstallId !== id) throw new Error("Confirm the preview uninstall first.")
      this.uninstallId = null
    }
    this.pending = { action, mod }
  }

  /** @param {string} id */
  requestUninstall(id) {
    const mod = this.mod(id)
    this.validate("uninstall", mod)
    this.uninstallId = id
  }

  cancelUninstall() {
    this.uninstallId = null
  }

  /** @param {string} input */
  installRepository(input) {
    const repository = normalizeRepository(input)
    const existing = this.mods.find(
      (mod) => mod.source === "github" && mod.repository.toLowerCase() === repository,
    )
    if (existing) {
      this.start("install", existing.id)
      return
    }
    /** @type {PreviewMod} */
    const mod = {
      id: `github:${repository}`,
      name: repository.split("/")[1],
      description: "Simulated GitHub installation. Repository contents are not checked.",
      repository,
      version: "",
      source: "github",
      icon: "github",
      gallery: false,
      state: "available",
    }
    this.validate("install", mod)
    this.pending = { action: "install", mod }
  }

  complete() {
    if (!this.pending) throw new Error("No preview action is in progress.")
    const { action, mod } = this.pending
    /** @type {ModState} */
    const state =
      action === "uninstall" ? "available" : action === "disable" ? "disabled" : "enabled"
    const updated = { ...mod, state }
    const existing = this.mods.some((item) => item.id === mod.id)
    this.mods = existing
      ? this.mods.map((item) => (item.id === mod.id ? updated : item))
      : [...this.mods, updated]
    this.pending = null
    return { action, mod: updated }
  }

  fail() {
    this.pending = null
  }
}
