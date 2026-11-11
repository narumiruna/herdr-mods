export const GALLERY_URL = "https://herdr.dev/gallery/?type=mods"
export const INDEX_URL = "https://assets.herdr.dev/mods/index.json"

/** @typedef {"all" | "github" | "development" | "local" | "shipped"} Source */
/** @typedef {"install" | "update" | "uninstall"} ModAction */
/** @typedef {"idle" | "loading" | "ready" | "error"} LoadStatus */
/**
 * @typedef {object} ManagerMod
 * @property {string} id Stable repository, recipe and folder identity, or a local discovery ID.
 * @property {string} name
 * @property {string} description
 * @property {string} version
 * @property {string} repository
 * @property {string} recipePath
 * @property {string} modName Original folder name and backend ID. Never renamed.
 * @property {Exclude<Source, "all">} source
 * @property {string} icon
 * @property {boolean} managed
 * @property {string} path
 * @property {string} commit
 * @property {string} [identityToken]
 * @property {"package" | "git"} [kind]
 * @property {string} [archivePath]
 * @property {string} [protectedReason]
 * @property {"available" | "installed"} state
 * @property {boolean} gallery
 * @property {string} [updateCommit]
 */
/**
 * @typedef {object} OperationRequest
 * @property {ModAction | "check-update" | "migrate"} action
 * @property {string} [migrationToken]
 * @property {boolean} [archiveGit]
 * @property {string} [archivePath]
 * @property {string} [id] Backend folder ID, not the Gallery card ID.
 * @property {string} [repository]
 * @property {string} [recipePath]
 * @property {string[]} [modNames]
 * @property {string} [expectedCommit]
 * @property {string} [targetCommit] Checked update revision, distinct from installed expectedCommit.
 * @property {string} [path]
 * @property {string} [identityToken]
 */
/**
 * @typedef {object} OperationResult
 * @property {string[]} [ids]
 * @property {string} [commit]
 * @property {string | null} [updateCommit] check-update candidate; commit is the installed revision.
 * @property {string} [message]
 */
/** @typedef {Readonly<{id: string, path: string, repository: string, kind: string}>} MigrationTarget */
/** @typedef {Readonly<{required: boolean, blocked: boolean, token: string, targets: readonly MigrationTarget[], reason?: string}>} Migration */
/** @typedef {Readonly<{summary: Migration, managed: readonly ManagerMod[]}>} MigrationConfirmation */
/** @typedef {{mods: unknown[], warnings: string[], migration?: Migration}} Discovery */
/**
 * @typedef {object} ManagerIO
 * @property {() => Promise<Discovery>} discover
 * @property {(ms: number) => Promise<void>} [wait] Native wait, injected by the view. Used only for Gallery requests.
 * @property {() => Promise<unknown>} fetchGallery
 * @property {(request: OperationRequest) => Promise<OperationResult>} operate
 */
/** @typedef {Readonly<{id: string, name: string, path: string, commit: string, identityToken?: string, kind?: "package" | "git", archivePath?: string}>} Confirmation */

const GALLERY_WAIT_MS = 15_000
const MAX_MODS = 10000
const MAX_CARDS = 20000
const COMMIT = /^[a-f0-9]{40}$/i
const FOLDER = /^[a-z0-9][a-z0-9_.-]{0,127}$/i

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid metadata object.")
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {string} value @param {boolean} [allowLines] */
function hasControl(value, allowLines = false) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && !(allowLines && (code === 9 || code === 10))) || code === 127
  })
}

/** @param {unknown} value @param {number} max @param {boolean} [empty] */
function text(value, max, empty = true) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    hasControl(value, true) ||
    (!empty && !value.trim())
  ) {
    throw new Error("Invalid or oversized metadata text.")
  }
  return value
}

/** @param {unknown} value @param {number} max */
function count(value, max) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error("Invalid metadata count.")
  }
  return value
}

/** @param {unknown} value */
function commit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error("Invalid commit: expected 40 hexadecimal characters.")
  }
  return value.toLowerCase()
}

/** @param {unknown} value */
function folder(value) {
  if (typeof value !== "string" || !FOLDER.test(value)) {
    throw new Error("Unsafe mod folder ID.")
  }
  return value
}

/** @param {unknown} value */
function recipePath(value) {
  const path = text(value, 1024)
  if (
    path &&
    (path.split("/").length > 64 ||
      !path.split("/").every((part) => /^[a-z0-9_][a-z0-9_.-]{0,127}$/i.test(part)))
  ) {
    throw new Error("Unsafe relative recipe path.")
  }
  return path
}

/** @param {string} path */
function safeTarget(path) {
  return (
    path.startsWith("/") &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    !hasControl(path) &&
    path
      .slice(1)
      .split("/")
      .every((part) => part && part !== "." && part !== "..")
  )
}

/** @param {unknown} value @param {number} [max] */
function warningList(value, max = 200) {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid metadata warnings.")
  const warnings = value.map((warning) => text(warning, 4096, false))
  return warnings.length <= 200
    ? warnings
    : [...warnings.slice(0, 200), `${warnings.length - 200} additional discovery warnings.`]
}

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} input */
export function normalizeRepository(input) {
  return parseRepository(input).label
}

/** @param {string} value */
export function parseRepository(value) {
  const match =
    /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d][a-z\d._-]{0,103})\/?$/i.exec(
      value.trim(),
    )
  if (!match) throw new Error("Enter a GitHub repository URL: https://github.com/owner/repository")
  const owner = match[1].toLowerCase()
  const name = match[2].replace(/\.git$/i, "").toLowerCase()
  if (!name || name.length > 100 || name.endsWith(".")) {
    throw new Error("Enter a GitHub repository URL: the repository name is not supported.")
  }
  return { id: name, label: `${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` }
}

/** Structural checks do not execute or rewrite mod code.
 * @param {string} json @param {string} entry
 */
export function validateManifest(json, entry) {
  const manifest = object(JSON.parse(json))
  if (!entry.trim()) throw new Error("The repository needs a nonempty root main.js.")
  if (
    manifest.place !== undefined &&
    (typeof manifest.place !== "string" ||
      !["none", "left", "right", "top", "bottom"].includes(manifest.place))
  ) {
    throw new Error("mod.json has an invalid place.")
  }
  if (
    manifest.title !== undefined &&
    (typeof manifest.title !== "string" || !manifest.title.trim())
  ) {
    throw new Error("mod.json title must be a nonempty string.")
  }
  if (
    manifest.size !== undefined &&
    (typeof manifest.size !== "number" || !Number.isFinite(manifest.size) || manifest.size <= 0)
  ) {
    throw new Error("mod.json size must be a positive number.")
  }
  if (manifest.overlay !== undefined) {
    const overlay = object(manifest.overlay)
    if (
      overlay.kind !== undefined &&
      (typeof overlay.kind !== "string" || !["dialog", "popup", "window"].includes(overlay.kind))
    ) {
      throw new Error("mod.json has an invalid overlay kind.")
    }
    for (const key of ["width", "height"]) {
      const value = overlay[key]
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      ) {
        throw new Error(`mod.json overlay ${key} must be a positive number.`)
      }
    }
  }
  return manifest
}

/** @param {string} repository @param {string} path @param {string} name */
function identity(repository, path, name) {
  return `mods:${repository}/${path}/${name}`
}

/** @param {readonly ManagerMod[]} mods @param {string} query @param {Source} source */
export function filterMods(mods, query = "", source = "all") {
  const term = query.trim().toLowerCase()
  return mods.filter(
    (mod) =>
      (source === "all" || mod.source === source) &&
      `${mod.name} ${mod.description} ${mod.repository} ${mod.id} ${mod.modName || ""}`
        .toLowerCase()
        .includes(term),
  )
}

// Protection does not hide actions. The view can disable them and display the reason.
/** @param {ManagerMod} mod @returns {ModAction[]} */
export function actionsFor(mod) {
  if (mod.state === "available") return ["install"]
  return mod.managed && mod.updateCommit ? ["uninstall", "update"] : ["uninstall"]
}

/** @param {unknown} response */
function parseGallery(response) {
  const index = object(response)
  if (index.schemaVersion !== 1) {
    throw new Error(`Unsupported Gallery schema version: ${String(index.schemaVersion)}.`)
  }
  if (!Array.isArray(index.mods) || index.mods.length > MAX_MODS) {
    throw new Error("Invalid Gallery listing count.")
  }
  if (count(index.modCount, MAX_MODS) !== index.mods.length) {
    throw new Error("Gallery listing count does not match its metadata.")
  }
  if (!Number.isFinite(Date.parse(text(index.generatedAt, 64, false)))) {
    throw new Error("Invalid Gallery generation date.")
  }
  const source = object(index.source)
  if (source.provider !== "github" || typeof source.truncated !== "boolean") {
    throw new Error("Invalid Gallery collection source.")
  }
  text(source.query, 512, false)
  for (const key of ["totalCount", "collectedCount", "blacklistedCount", "skippedCount"]) {
    count(source[key], 10000000)
  }
  const warnings = source.warnings === undefined ? [] : warningList(source.warnings)
  if (source.truncated === true) warnings.push("The Gallery source reports truncated results.")
  /** @type {ManagerMod[]} */
  const mods = []
  const identities = new Set()
  const repositories = new Set()
  const listings = new Set()
  for (const value of index.mods) {
    const entry = object(value)
    const owner = text(entry.owner, 39, false)
    const repo = text(entry.repo, 104, false)
    const fullName = text(entry.fullName, 144, false)
    const repository = normalizeRepository(`https://github.com/${owner}/${repo}`)
    if (
      fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      normalizeRepository(text(entry.url, 200, false)) !== repository
    ) {
      throw new Error("Gallery repository owner, repo, fullName and URL do not match.")
    }
    const path = recipePath(entry.path)
    const listingId = `${repository}/${path}`
    if (listings.has(listingId)) throw new Error("Duplicate Gallery listing identity.")
    listings.add(listingId)
    repositories.add(repository)
    const revision = commit(entry.headCommit)
    const name = text(entry.name, 256, false)
    const description = text(entry.blurb, 4096)
    const version = entry.version === undefined ? "" : text(entry.version, 128)
    if (entry.defaultBranch !== undefined) text(entry.defaultBranch, 255, false)
    if (entry.stars !== undefined) count(entry.stars, 1000000000)
    if (entry.recipeBytes !== undefined) count(entry.recipeBytes, 64 * 1024 * 1024)
    if (entry.previewUrl !== undefined) text(entry.previewUrl, 2048)
    for (const key of ["hasKeys", "hasPreview"]) {
      if (entry[key] !== undefined && typeof entry[key] !== "boolean") {
        throw new Error("Invalid Gallery listing flag.")
      }
    }
    if (
      entry.pushedAt !== undefined &&
      !Number.isFinite(Date.parse(text(entry.pushedAt, 64, false)))
    ) {
      throw new Error("Invalid Gallery repository date.")
    }
    if (!Array.isArray(entry.modNames) || !entry.modNames.length || entry.modNames.length > 128) {
      throw new Error("Invalid Gallery mod folder count.")
    }
    for (const value of entry.modNames) {
      const modName = folder(value)
      const id = identity(repository, path, modName)
      if (identities.has(id)) throw new Error("Duplicate Gallery mod identity.")
      identities.add(id)
      mods.push({
        id,
        name: entry.modNames.length > 1 ? `${name} — ${modName}` : name,
        description,
        version,
        repository,
        recipePath: path,
        modName,
        source: "github",
        icon: "package",
        managed: false,
        path: "",
        commit: revision,
        state: "available",
        gallery: true,
      })
      if (mods.length > MAX_CARDS) throw new Error("Too many Gallery mod folders.")
    }
  }
  if (count(index.repositoryCount, MAX_MODS) !== repositories.size) {
    throw new Error("Gallery repository count does not match its metadata.")
  }
  return { mods, warnings }
}

/** @param {unknown} response */
function parseDiscovery(response) {
  const data = object(response)
  if (!Array.isArray(data.mods) || data.mods.length > MAX_MODS) {
    throw new Error("Invalid discovery mod count.")
  }
  const warnings = warningList(data.warnings, MAX_MODS)
  /** @type {ManagerMod[]} */
  const mods = data.mods.map((value) => {
    const entry = object(value)
    // Existing local folder names need not satisfy our stricter install policy.
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.id.length > 1024 ||
      typeof entry.modName !== "string"
    ) {
      throw new Error("Invalid discovery folder metadata.")
    }
    const localId = entry.id
    const modName = entry.modName
    const path = typeof entry.path === "string" ? entry.path : ""
    const source = text(entry.source, 32, false)
    if (!["github", "development", "local", "shipped"].includes(source)) {
      throw new Error("Invalid discovery source.")
    }
    if (typeof entry.managed !== "boolean") throw new Error("Invalid discovery ownership.")
    const display = (/** @type {unknown} */ value, /** @type {number} */ max, fallback = "") => {
      if (typeof value !== "string") return fallback
      const cleaned = Array.from(value)
        .map((character) => {
          const code = character.charCodeAt(0)
          return code < 32 || code === 127 ? " " : character
        })
        .join("")
      if ((cleaned !== value || cleaned.length > max) && warnings.length < 200) {
        warnings.push(`${localId.slice(0, 128)}: display metadata was shortened or sanitized.`)
      }
      return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
    }
    let reason = entry.protectedReason ? display(entry.protectedReason, 4096) : ""
    let repository = ""
    let recipe = ""
    let revision = ""
    try {
      folder(localId)
      folder(modName)
      if (modName !== localId) throw new Error("Mod folder identity does not match its local ID.")
      if (entry.repository) {
        const supplied = text(entry.repository, 144, false)
        repository = normalizeRepository(`https://github.com/${supplied}`)
        recipe = recipePath(entry.recipePath)
        if (modName !== localId) throw new Error("Mod folder identity does not match its local ID.")
      } else if (entry.managed) {
        throw new Error("Managed mod has no verified repository identity.")
      }
      if (entry.commit) revision = commit(entry.commit)
      if (entry.managed && !revision) throw new Error("Managed mod has no verified commit.")
    } catch (error) {
      reason ||= errorMessage(error)
      repository = ""
    }
    const token = entry.identityToken === undefined ? "" : text(entry.identityToken, 256, false)
    if (!safeTarget(path) || path.split("/").at(-1) !== localId) {
      reason ||= "The installed target path is unsafe or does not match its folder ID."
    }
    if (entry.managed && !token) reason ||= "The installed ownership token is missing."
    const kind = entry.kind === undefined ? "package" : text(entry.kind, 32, false)
    if (!["package", "git"].includes(kind)) throw new Error("Invalid installed ownership kind.")
    const archivePath = entry.archivePath === undefined ? "" : text(entry.archivePath, 4096, false)
    if (
      kind === "git" &&
      (!safeTarget(archivePath) || archivePath === path || archivePath.startsWith(`${path}/`))
    ) {
      reason ||= "The Git archive destination is unsafe or missing."
    }
    if (!entry.managed) reason ||= "Only manager-owned mods can be changed."
    return {
      id: repository
        ? identity(repository, recipe, modName)
        : `local:${encodeURIComponent(localId)}`,
      name: display(entry.name, 256, display(localId, 256)),
      description: display(entry.description, 4096),
      version: display(entry.version, 128),
      repository,
      recipePath: recipe,
      modName: localId,
      source: /** @type {ManagerMod["source"]} */ (source),
      icon: text(entry.icon || "package", 64, false),
      managed: entry.managed,
      kind: /** @type {"package" | "git"} */ (kind),
      ...(archivePath ? { archivePath } : {}),
      path,
      commit: revision,
      ...(token ? { identityToken: token } : {}),
      ...(reason ? { protectedReason: reason } : {}),
      state: "installed",
      gallery: false,
    }
  })
  // Discovery conflicts stay visible, but no conflicting record can be changed or matched.
  const ids = new Map()
  const folders = new Map()
  for (const mod of mods) {
    ids.set(mod.id, (ids.get(mod.id) ?? 0) + 1)
    folders.set(mod.modName, (folders.get(mod.modName) ?? 0) + 1)
  }
  mods.forEach((mod, index) => {
    if (ids.get(mod.id) > 1 || folders.get(mod.modName) > 1) {
      const reason = `Installed identity collision for ${mod.modName}.`
      warnings.push(reason)
      mod.protectedReason = reason
      mod.id = `collision:${mod.modName}:${index}`
    }
  })
  return { mods, warnings, migration: parseMigration(data.migration) }
}

/** @param {unknown} value @returns {Migration | null} */
function parseMigration(value) {
  if (value === undefined) return null
  const data = object(value)
  const inactive = data.blocked === true || data.required === false
  const entries = data.targets === undefined && inactive ? [] : data.targets
  if (
    typeof data.required !== "boolean" ||
    typeof data.blocked !== "boolean" ||
    !Array.isArray(entries) ||
    entries.length > MAX_MODS
  ) {
    throw new Error("Invalid migration summary.")
  }
  const ids = new Set()
  const targets = entries.map((value) => {
    const target = object(value)
    const id = text(target.id, 1024, false)
    const path = text(target.path, 4096, false)
    if (!safeTarget(path) || path.split("/").at(-1) !== id || ids.has(id)) {
      throw new Error("Invalid or duplicate migration target.")
    }
    ids.add(id)
    const repository = text(target.repository, 256)
    const kind = text(target.kind, 128, false)
    if (data.required && !data.blocked) {
      folder(id)
      if (
        normalizeRepository(`https://github.com/${repository}`) !== repository ||
        !["package", "git"].includes(kind)
      ) {
        throw new Error("Invalid migration source or target kind.")
      }
    }
    return Object.freeze({ id, path, repository, kind })
  })
  const token = text(data.token === undefined && inactive ? "" : data.token, 256, inactive)
  if (data.required && !data.blocked && !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid migration summary token.")
  }
  return Object.freeze({
    required: data.required,
    blocked: data.blocked,
    token,
    targets: Object.freeze(targets),
    ...(data.reason === undefined ? {} : { reason: text(data.reason, 4096, false) }),
  })
}

/** @param {ManagerMod | undefined} mod */
function verifiedInstalled(mod) {
  return Boolean(
    mod?.managed &&
      mod.identityToken &&
      safeTarget(mod.path) &&
      mod.path.split("/").at(-1) === mod.modName &&
      mod.repository &&
      mod.id === identity(mod.repository, mod.recipePath, mod.modName),
  )
}

/** @param {unknown} value */
function operationResult(value) {
  const result = object(value)
  if (result.ids !== undefined) {
    if (!Array.isArray(result.ids) || !result.ids.length || result.ids.length > 128) {
      throw new Error("Invalid operation result IDs.")
    }
    result.ids.forEach(folder)
    if (new Set(result.ids).size !== result.ids.length) throw new Error("Duplicate operation IDs.")
  }
  if (result.commit !== undefined) commit(result.commit)
  if (result.message !== undefined) text(result.message, 4096)
  return /** @type {OperationResult} */ (result)
}

// The injected adapter owns all platform, network, file and git operations.
export class ManagerSession {
  /** @type {readonly ManagerMod[]} */
  mods = Object.freeze([])
  /** @type {LoadStatus} */
  galleryStatus = "idle"
  /** @type {LoadStatus} */
  discoveryStatus = "idle"
  galleryError = ""
  discoveryError = ""
  /** @type {string[]} */
  warnings = []
  /** @type {Migration | null} */
  migration = null
  /** @type {MigrationConfirmation | null} */
  migrationConfirmation = null
  /** @type {Readonly<{id: string, action: ModAction | "check-update" | "migrate"}> | null} */
  pending = null
  /** @type {string | null} */
  uninstallId = null
  /** @type {Confirmation | null} */
  confirmation = null
  /** @type {Record<string, string>} */
  updateErrors = {}
  lastMessage = ""
  /** @type {ManagerMod[]} */
  _gallery = []
  /** @type {ManagerMod[]} */
  _installed = []
  /** @type {string[]} */
  _galleryWarnings = []
  /** @type {string[]} */
  _discoveryWarnings = []
  /** @type {Map<string, {commit: string, identityToken: string, candidate: string}>} */
  _updates = new Map()
  _galleryRequest = 0
  _discoveryRequest = 0

  /** @param {ManagerIO} io */
  constructor(io) {
    this.io = io
  }

  /** @param {() => void} [onChange] */
  async load(onChange = () => {}) {
    await this.refresh(onChange)
  }

  /** @param {() => void} [onChange] */
  async refresh(onChange = () => {}) {
    await Promise.all([this.refreshGallery(onChange), this.refreshInstalled(onChange)])
  }

  /** @param {() => void} [onChange] */
  async refreshGallery(onChange = () => {}) {
    await this._fetchGallery()
    onChange()
  }

  /** @param {() => void} [onChange] */
  async refreshInstalled(onChange = () => {}) {
    await this._discover()
    onChange()
  }

  async _fetchGallery() {
    const request = ++this._galleryRequest
    this.galleryStatus = "loading"
    this.galleryError = ""
    try {
      const response = this.io.fetchGallery()
      const data = parseGallery(
        await (this.io.wait
          ? Promise.race([
              response,
              this.io.wait(GALLERY_WAIT_MS).then(() => {
                throw new Error("Gallery request timed out. Refresh to retry.")
              }),
            ])
          : response),
      )
      if (request !== this._galleryRequest) return
      this._gallery = data.mods
      this._galleryWarnings = data.warnings
      this.galleryStatus = "ready"
    } catch (error) {
      if (request !== this._galleryRequest) return
      this.galleryStatus = "error"
      this.galleryError = errorMessage(error)
    }
    this._rebuild()
  }

  async _discover() {
    const request = ++this._discoveryRequest
    this.discoveryStatus = "loading"
    this.discoveryError = ""
    try {
      const data = parseDiscovery(await this.io.discover())
      if (request !== this._discoveryRequest) throw new Error("Discovery was superseded. Retry.")
      this._installed = data.mods
      this.migration = data.migration
      this._discoveryWarnings = data.warnings
      this.discoveryStatus = "ready"
      this._rebuild()
      return true
    } catch (error) {
      if (request === this._discoveryRequest) {
        this.discoveryStatus = "error"
        this.discoveryError = errorMessage(error)
        this._rebuild()
      }
      return false
    }
  }

  _rebuild() {
    const remaining = new Map(this._installed.map((mod) => [mod.id, mod]))
    const folders = new Set(this._installed.map((mod) => mod.modName))
    const mods = this._gallery.map((listing) => {
      const installed = remaining.get(listing.id)
      if (installed) {
        remaining.delete(listing.id)
        return {
          ...listing,
          ...installed,
          name: listing.name,
          description: listing.description || installed.description,
          version: installed.version || listing.version,
          gallery: true,
        }
      }
      const conflict = folders.has(listing.modName)
      return {
        ...listing,
        ...(conflict
          ? { protectedReason: "The destination folder belongs to another installed identity." }
          : {}),
      }
    })
    mods.push(...remaining.values())
    this.mods = Object.freeze(
      mods.map((mod) => {
        const update = this._updates.get(mod.id)
        return Object.freeze({
          ...mod,
          ...(update &&
          update.commit === mod.commit &&
          update.identityToken === mod.identityToken &&
          update.candidate !== mod.commit
            ? { updateCommit: update.candidate }
            : {}),
        })
      }),
    )
    this.warnings = [...this._galleryWarnings, ...this._discoveryWarnings]
  }

  /** @param {"gallery" | "installed"} section @param {string} query @param {Source} source */
  list(section, query = "", source = "all") {
    return filterMods(
      this.mods.filter((mod) => (section === "gallery" ? mod.gallery : mod.state === "installed")),
      query,
      source,
    )
  }

  /** @param {string} id */
  mod(id) {
    const mod = this.mods.find((item) => item.id === id)
    if (!mod) throw new Error("The mod was not found. Refresh the list.")
    return mod
  }

  _available() {
    if (this.pending) throw new Error("Another operation is in progress.")
    if (this.confirmation) throw new Error("Confirm or cancel the uninstall first.")
    if (this.migrationConfirmation) throw new Error("Confirm or cancel the migration first.")
    this._migrationReady()
    if (this.discoveryStatus !== "ready") {
      throw new Error("Installed-mod discovery must succeed before an operation.")
    }
  }

  _migrationReady() {
    if (this.migration?.required || this.migration?.blocked) {
      throw new Error(
        this.migration.reason || "Ownership migration is required before file operations.",
      )
    }
  }

  /** @param {ModAction} action @param {ManagerMod} mod */
  _validate(action, mod) {
    this._migrationReady()
    if (mod.protectedReason) throw new Error(mod.protectedReason)
    if (!actionsFor(mod).includes(action)) throw new Error("This action is not available.")
    if (action === "install" && this.galleryStatus !== "ready") {
      throw new Error("The Gallery must load successfully before installation.")
    }
  }

  requestMigration() {
    if (this.pending || this.confirmation || this.migrationConfirmation) {
      throw new Error("Finish or cancel the current operation first.")
    }
    if (this.discoveryStatus !== "ready")
      throw new Error("Installed-mod discovery must succeed first.")
    if (!this.migration?.required || this.migration.blocked) {
      throw new Error(this.migration?.reason || "No eligible ownership migration is available.")
    }
    this.migrationConfirmation = Object.freeze({
      summary: this.migration,
      managed: Object.freeze(
        this._installed.filter((mod) => mod.managed).map((mod) => Object.freeze({ ...mod })),
      ),
    })
    return this.migrationConfirmation
  }

  cancelMigration() {
    if (this.pending) throw new Error("Another operation is in progress.")
    this.migrationConfirmation = null
  }

  async confirmMigration() {
    if (this.pending) throw new Error("Another operation is in progress.")
    const confirmation = this.migrationConfirmation
    if (!confirmation) throw new Error("Confirm the ownership migration first.")
    this.pending = Object.freeze({ id: "migration", action: "migrate" })
    this.lastMessage = ""
    try {
      await this._readDiscovery()
      if (
        JSON.stringify(this.migration) !== JSON.stringify(confirmation.summary) ||
        this.migration.blocked
      ) {
        throw new Error("The migration summary is stale. Cancel, refresh and confirm again.")
      }
      const result = operationResult(
        await this.io.operate({
          action: "migrate",
          migrationToken: confirmation.summary.token,
        }),
      )
      await this._readDiscovery()
      if (this.migration?.required !== false || this.migration.blocked) {
        throw new Error(
          this.migration?.reason ||
            "Migration readback failed: ownership is still blocked or unverified.",
        )
      }
      for (const before of confirmation.managed) {
        const after = this._installed.find((mod) => mod.modName === before.modName)
        if (
          !verifiedInstalled(after) ||
          after.path !== before.path ||
          after.repository !== before.repository ||
          after.recipePath !== before.recipePath ||
          after.commit !== before.commit ||
          after.kind !== before.kind
        ) {
          throw new Error("Migration readback failed: an original managed identity changed.")
        }
      }
      for (const target of confirmation.summary.targets) {
        const after = this._installed.find((mod) => mod.modName === target.id)
        if (
          !verifiedInstalled(after) ||
          after.path !== target.path ||
          after.repository !== target.repository ||
          after.kind !== target.kind
        ) {
          throw new Error("Migration readback failed: a target identity is not verified.")
        }
      }
      this.migrationConfirmation = null
      this.lastMessage =
        result.message || "Ownership migration verified. Git history and mod files are retained."
      return { ...result, message: this.lastMessage }
    } catch (error) {
      await this._discover()
      throw error
    } finally {
      this.pending = null
    }
  }

  /** @param {string} id @returns {Confirmation} */
  requestUninstall(id) {
    this._available()
    const mod = this.mod(id)
    this._validate("uninstall", mod)
    this.confirmation = Object.freeze({
      id: mod.id,
      name: mod.name,
      path: mod.path,
      commit: mod.commit,
      identityToken: mod.identityToken,
      kind: mod.kind,
      archivePath: mod.archivePath,
    })
    this.uninstallId = id
    return this.confirmation
  }

  cancelUninstall() {
    if (this.pending) throw new Error("Another operation is in progress.")
    this.confirmation = null
    this.uninstallId = null
  }

  /** @param {"install" | "update"} action @param {string} id */
  async perform(action, id) {
    this._available()
    if (action !== "install" && action !== "update") throw new Error("Unsupported action.")
    const mod = this.mod(id)
    this._validate(action, mod)
    return this._mutate(action, mod)
  }

  async confirmUninstall() {
    if (this.pending) throw new Error("Another operation is in progress.")
    const confirmation = this.confirmation
    if (!confirmation) throw new Error("Confirm the uninstall first.")
    if (this.discoveryStatus !== "ready")
      throw new Error("Installed-mod discovery must succeed first.")
    const mod = this.mod(confirmation.id)
    if (
      mod.path !== confirmation.path ||
      mod.commit !== confirmation.commit ||
      mod.identityToken !== confirmation.identityToken ||
      mod.kind !== confirmation.kind ||
      mod.archivePath !== confirmation.archivePath
    ) {
      throw new Error("The uninstall confirmation is stale. Cancel and try again.")
    }
    this._validate("uninstall", mod)
    this.confirmation = null
    this.uninstallId = null
    return this._mutate("uninstall", mod)
  }

  /** @param {ManagerMod} snapshot @param {ModAction} action */
  _current(snapshot, action) {
    const current = this.mod(snapshot.id)
    if (
      current.state !== snapshot.state ||
      current.path !== snapshot.path ||
      current.commit !== snapshot.commit ||
      current.identityToken !== snapshot.identityToken ||
      current.kind !== snapshot.kind ||
      current.archivePath !== snapshot.archivePath ||
      (action === "update" && current.updateCommit !== snapshot.updateCommit)
    ) {
      throw new Error("The mod changed. Refresh and try again; the confirmation is stale.")
    }
    this._validate(action, current)
  }

  /** @param {ModAction} action @param {ManagerMod} snapshot */
  async _mutate(action, snapshot) {
    this.pending = Object.freeze({ id: snapshot.id, action })
    this.lastMessage = ""
    try {
      await this._readDiscovery()
      this._current(snapshot, action)
      /** @type {OperationRequest} */
      const request =
        action === "install"
          ? {
              action,
              repository: snapshot.repository,
              recipePath: snapshot.recipePath,
              modNames: [snapshot.modName],
              expectedCommit: snapshot.commit,
            }
          : this._targetRequest(action, snapshot)
      const result = operationResult(await this.io.operate(request))
      await this._readDiscovery()
      const expected = action === "update" ? snapshot.updateCommit : snapshot.commit
      if (result.ids && (result.ids.length !== 1 || result.ids[0] !== snapshot.modName)) {
        throw new Error("Operation returned an unexpected mod identity.")
      }
      if (action === "uninstall") {
        if (
          this._installed.some(
            (mod) =>
              mod.id === snapshot.id ||
              mod.modName === snapshot.modName ||
              mod.path === snapshot.path,
          )
        ) {
          throw new Error("Uninstall readback failed: the target is still installed.")
        }
      } else {
        const installed = this._installed.find((mod) => mod.id === snapshot.id)
        if (
          !verifiedInstalled(installed) ||
          installed.commit !== expected ||
          (action === "update" && installed.path !== snapshot.path) ||
          (result.commit !== undefined && commit(result.commit) !== expected)
        ) {
          throw new Error(
            "Operation readback failed: installed membership or commit does not match.",
          )
        }
      }
      this._updates.delete(snapshot.id)
      this._rebuild()
      this.lastMessage = result.message ?? ""
      return result
    } catch (error) {
      // A backend can fail after a file change. Always show actual discovery, not a simulated rollback.
      await this._discover()
      throw error
    } finally {
      this.pending = null
    }
  }

  /** @param {ModAction | "check-update"} action @param {ManagerMod} mod @returns {OperationRequest} */
  _targetRequest(action, mod) {
    return {
      action,
      id: mod.modName,
      expectedCommit: mod.commit,
      ...(action === "update" ? { targetCommit: mod.updateCommit } : {}),
      ...(action === "uninstall" && mod.kind === "git"
        ? { archiveGit: true, archivePath: mod.archivePath }
        : {}),
      path: mod.path,
      identityToken: mod.identityToken,
    }
  }

  async _readDiscovery() {
    if (!(await this._discover())) {
      throw new Error(
        `Installed-mod discovery failed: ${this.discoveryError || "superseded request"}`,
      )
    }
  }

  /** @param {string} input @param {string} [directory] */
  async installRepository(input, directory = "") {
    this._available()
    const repository = normalizeRepository(input)
    const recipe = recipePath(directory.trim())
    const modName = recipe ? folder(recipe.split("/").at(-1)) : undefined
    const alreadyInstalled = () =>
      this._installed.some((mod) => mod.repository === repository && mod.recipePath === recipe)
    if (alreadyInstalled()) {
      throw new Error("This repository mod is already installed.")
    }
    const id = `github:${repository}${recipe ? `/${recipe}` : ""}`
    this.pending = Object.freeze({ id, action: "install" })
    this.lastMessage = ""
    try {
      await this._readDiscovery()
      this._migrationReady()
      if (alreadyInstalled()) {
        throw new Error("This repository mod is already installed.")
      }
      const result = operationResult(
        await this.io.operate({
          action: "install",
          repository,
          ...(recipe ? { recipePath: recipe } : {}),
        }),
      )
      await this._readDiscovery()
      if (!result.ids?.length || !result.commit) {
        throw new Error("Repository installation did not return verified IDs and a commit.")
      }
      if (modName && (result.ids.length !== 1 || result.ids[0] !== modName)) {
        throw new Error("Repository installation returned an unexpected mod selection.")
      }
      for (const installedName of result.ids) {
        const installed = this._installed.find((mod) => mod.modName === installedName)
        if (
          !verifiedInstalled(installed) ||
          installed.repository !== repository ||
          installed.recipePath !== recipe ||
          installed.commit !== commit(result.commit)
        ) {
          throw new Error(
            "Repository installation readback failed: identity or commit does not match.",
          )
        }
      }
      this.lastMessage = result.message ?? ""
      return result
    } catch (error) {
      await this._discover()
      throw error
    } finally {
      this.pending = null
    }
  }

  // Checking is explicit and read-only. A failed check removes any old candidate.
  async checkUpdates() {
    this._available()
    this.pending = Object.freeze({ id: "updates", action: "check-update" })
    try {
      await this._readDiscovery()
      this._migrationReady()
      const eligible = this.mods.filter(
        (mod) => mod.state === "installed" && mod.managed && !mod.protectedReason,
      )
      for (const mod of eligible) {
        this.pending = Object.freeze({ id: mod.id, action: "check-update" })
        this._updates.delete(mod.id)
        delete this.updateErrors[mod.id]
        try {
          const result = operationResult(
            await this.io.operate(this._targetRequest("check-update", mod)),
          )
          if (!result.commit || commit(result.commit) !== mod.commit)
            throw new Error("Update check returned a stale installed commit.")
          if (result.updateCommit !== null) {
            const candidate = commit(result.updateCommit)
            if (candidate !== mod.commit)
              this._updates.set(mod.id, {
                commit: mod.commit,
                identityToken: mod.identityToken,
                candidate,
              })
          }
        } catch (error) {
          this.updateErrors[mod.id] = errorMessage(error)
          await this._discover()
          if (
            this.discoveryStatus !== "ready" ||
            this.migration?.required ||
            this.migration?.blocked
          )
            break
        }
        this._rebuild()
      }
    } finally {
      this.pending = null
    }
  }
}
