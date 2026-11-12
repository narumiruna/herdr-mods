// biome-ignore lint/style/useNodejsImportProtocol: Herdr provides this module without node:.
import * as fs from "fs/promises"
import { appHome, exec, layout, panes, readTextFile } from "herdr"

/** @typedef {{code:number, stdout:string, stderr:string}} CommandResult */
/** @typedef {Record<string, unknown>} Request */
/**
 * @typedef {object} Host
 * @property {() => string} root
 * @property {(program:string,args:string[],options?:{timeout?:number}) => Promise<CommandResult>} exec
 * @property {() => unknown} layout
 * @property {() => unknown} panes
 * @property {(url:string) => Promise<{ok:boolean,status:number,text:()=>Promise<string>}>} fetch
 * @property {(path:string) => Promise<string|null>} read
 * @property {typeof fs.readdir} list
 * @property {typeof fs.exists} exists
 * @property {(ms:number) => Promise<void>} [wait]
 */

const INDEX_URL = "https://assets.herdr.dev/mods/index.json"

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Collect references, not display names. Hidden layout nodes also matter.
 * @param {unknown} value @param {Set<string>} names
 */
function references(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) references(item, names)
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["mod", "terminal_menu", "toast_mod"].includes(key) && typeof child === "string") {
        names.add(child)
      }
      references(child, names)
    }
  }
}

/** @param {Host} host */
async function runtimeContext(host) {
  const dependencies = new Set()
  try {
    const tree = host.layout()
    const allPanes = host.panes()
    if (!object(tree) || !Array.isArray(allPanes)) throw new Error("Unavailable runtime inventory")
    references(tree, dependencies)
    references(allPanes, dependencies)
    const result = await host.exec("herdr-app", ["status"], { timeout: 10_000 })
    if (result.code !== 0) throw new Error("Unavailable app status")
    const status = JSON.parse(result.stdout)
    if (!object(status) || !Array.isArray(status.errors) || !Array.isArray(status.overlays)) {
      throw new Error("Invalid app status")
    }
    if (status.errors.length) throw new Error("Herdr reports runtime errors")
    references(status, dependencies)
    for (const overlay of status.overlays) {
      // Herdr status reports mod NAMES, not overlay IDs. Preserve any mod- prefix.
      // A layout overlay or a copy not loaded yet does not name its dependencies.
      if (
        typeof overlay !== "string" ||
        overlay === "layout" ||
        !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(overlay)
      ) {
        throw new Error("Unknown overlay dependency")
      }
      dependencies.add(overlay)
    }
    return { runtimeKnown: true, dependencies: [...dependencies] }
  } catch {
    return { runtimeKnown: false, dependencies: [...dependencies] }
  }
}

/** @param {string} message @param {Request} request */
function backendFailure(message, request) {
  const uncertain = ["install", "update", "uninstall", "migrate"].includes(String(request.action))
  return new Error(
    message +
      (uncertain
        ? " Outcome is unverified. Refresh Installed before retrying. Preserve data/mod-manager/ journals and backups; do not delete locks or recovery data."
        : ""),
  )
}

/** @param {Host} host @param {Request} request */
async function backend(host, request) {
  const root = host.root()
  const context = await runtimeContext(host)
  let result
  try {
    result = await host.exec(
      "uv",
      [
        "run",
        "--no-project",
        "--offline",
        "--no-python-downloads",
        "python",
        "-I",
        "-S",
        `${root}/mods/mod-manager/operations.py`,
        root,
        JSON.stringify({ ...request, ...context }),
      ],
      { timeout: 240_000 },
    )
  } catch {
    throw backendFailure(
      "Local file backend stopped or could not start. File actions need uv, a cached Python and Git. No tools are installed automatically.",
      request,
    )
  }
  if (result.code !== 0) {
    throw backendFailure(
      `Local file backend failed: ${result.stderr.trim().slice(0, 600) || "check uv, cached Python and Git"}`,
      request,
    )
  }
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw backendFailure(
      "Local file backend returned invalid data. No success was verified.",
      request,
    )
  }
  if (!object(value) || value.ok !== true) {
    throw new Error(
      object(value) && typeof value.error === "string" ? value.error : "Local operation failed",
    )
  }
  return /** @type {Record<string, unknown>} */ ({
    ...value,
    message: value.message || value.notice || "Files verified. Runtime reload is not confirmed.",
  })
}

/** Read-only fallback: tool availability must not hide actual installed mods.
 * No ownership is adopted and no file actions are allowed from this inventory.
 * @param {Host} host @param {string} reason
 */
async function readonlyInventory(host, reason) {
  const root = host.root()
  const entries = await host.list(`${root}/mods`, { withFileTypes: true })
  /** @type {Record<string,unknown>} */
  let shipped = {}
  const warnings = [reason]
  try {
    const raw = await host.read(`${root}/installed.json`)
    const value = raw ? JSON.parse(raw) : null
    if (!object(value)) throw new Error("Invalid shipped-mod bookkeeping")
    shipped = value
  } catch {
    warnings.push("Shipped-mod metadata is unreadable. File actions remain blocked.")
  }
  const mods = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = `${root}/mods/${entry.name}`
    if (!(await host.exists(`${path}/main.js`)) && !(await host.exists(`${path}/mod.json`)))
      continue
    /** @type {Record<string,unknown>} */
    let manifest = {}
    try {
      const raw = await host.read(`${path}/mod.json`)
      const value = raw ? JSON.parse(raw) : null
      if (!object(value)) throw new Error("Invalid manifest")
      manifest = value
    } catch {
      warnings.push(`${entry.name}: manifest unreadable; metadata is incomplete.`)
    }
    const source = Object.hasOwn(shipped, entry.name)
      ? "shipped"
      : !entry.isDirectory() || entry.name === "mod-manager"
        ? "development"
        : "local"
    mods.push({
      id: entry.name,
      modName: entry.name,
      name: typeof manifest.title === "string" ? manifest.title : entry.name,
      description: typeof manifest.description === "string" ? manifest.description : "",
      version: typeof manifest.version === "string" ? manifest.version : "",
      repository: "",
      recipePath: "",
      source,
      managed: false,
      path,
      protectedReason:
        "Read-only inventory: ownership and safe local file operations are unavailable.",
    })
  }
  return { mods, warnings, readOnlyReason: reason }
}

// No host calls occur at module evaluation. Mutations run inside unowned tasks.
/** @param {Host} [host] @param {(ms:number) => Promise<void>} [wait] */
export function createIO(host, wait) {
  /** @type {Host} */
  const adapter = host || {
    root: appHome,
    exec,
    layout,
    panes,
    fetch: (url) => fetch(url),
    read: readTextFile,
    list: fs.readdir,
    exists: fs.exists,
  }
  return {
    wait: wait || adapter.wait,
    async discover() {
      try {
        const value = await backend(adapter, { action: "discover" })
        if (!Array.isArray(value.mods) || !Array.isArray(value.warnings)) {
          throw new Error("Local inventory returned invalid data")
        }
        return /** @type {any} */ (value)
      } catch (error) {
        return readonlyInventory(
          adapter,
          error instanceof Error ? error.message : "Local inventory failed",
        )
      }
    },
    async fetchGallery() {
      const response = await adapter.fetch(INDEX_URL)
      if (!response.ok)
        throw new Error(`Gallery request failed (HTTP ${response.status}). Retry later.`)
      const raw = await response.text()
      if (raw.length > 2_000_000) throw new Error("Gallery response exceeds the supported size")
      return JSON.parse(raw)
    },
    /** @param {Request} request */
    async operate(request) {
      if (
        !["install", "update", "uninstall", "check-update", "migrate"].includes(
          String(request.action),
        )
      ) {
        throw new Error("Unsupported local operation")
      }
      if (request.action === "update") {
        // Downloads finish before collecting the commit-time host snapshot.
        const prepared = await backend(adapter, { ...request, action: "prepare-update" })
        if (
          typeof prepared.stageToken !== "string" ||
          !/^[a-f0-9]{32}$/.test(prepared.stageToken) ||
          prepared.commit !== request.targetCommit
        ) {
          throw new Error("Update staging did not verify the checked revision")
        }
        return /** @type {any} */ (
          await backend(adapter, { ...request, stageToken: prepared.stageToken })
        )
      }
      return /** @type {any} */ (await backend(adapter, request))
    },
  }
}
