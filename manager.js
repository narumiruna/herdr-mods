export const GALLERY_URL = "https://herdr.dev/gallery/?type=mods"
const MARKER = "herdr-mod-manager.json"

/** @import { Runtime } from "./runtime.js" */
/** @typedef {"all" | "github" | "development" | "local"} Source */
/**
 * @typedef {object} Mod
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} repository
 * @property {string} version
 * @property {Exclude<Source, "all">} source
 * @property {string} icon
 * @property {boolean} managed
 * @property {string} problem
 */

/** @param {string} value */
export function parseRepository(value) {
  const match =
    /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d][a-z\d._-]{0,103})\/?$/i.exec(
      value.trim(),
    )
  if (!match) throw new Error("Use a public repository URL: https://github.com/owner/repository")
  const owner = match[1].toLowerCase()
  const name = match[2].replace(/\.git$/i, "").toLowerCase()
  if (!name || name.length > 100 || name.endsWith(".")) {
    throw new Error("The repository name is not supported.")
  }
  return { id: name, label: `${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` }
}

/** @param {readonly Mod[]} mods @param {string} query @param {Source} source */
export function filterMods(mods, query, source) {
  const term = query.trim().toLowerCase()
  return mods.filter(
    (mod) =>
      (source === "all" || mod.source === source) &&
      `${mod.name} ${mod.description} ${mod.repository} ${mod.id}`.toLowerCase().includes(term),
  )
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mod.json must contain a JSON object.")
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {string} json @param {string} entry */
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

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {Runtime} io */
export function createManager(io) {
  /** @param {string} path @param {string[]} args */
  async function git(path, args) {
    const result = await io.git(path, args)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Git ${args[0]} failed. Install Git and retry.`)
    }
    return result.stdout.trim()
  }

  /** @param {string} path @param {string} commit */
  async function validateTree(path, commit) {
    const tree = await git(path, ["ls-tree", "-rz", commit])
    const entries = tree.split("\0").filter(Boolean)
    const files = new Set()
    for (const record of entries) {
      const tab = record.indexOf("\t")
      const mode = record.slice(0, 6)
      const name = record.slice(tab + 1)
      if (tab < 0 || (mode !== "100644" && mode !== "100755")) {
        throw new Error("Repositories with symbolic links or submodules are not supported.")
      }
      if (
        [...name].some((character) => character === "\\" || character.charCodeAt(0) < 32) ||
        name.split("/").some((part) => part.toLowerCase() === ".git")
      ) {
        throw new Error("The repository contains an unsafe file path.")
      }
      files.add(name)
    }
    if (!files.has("mod.json") || !files.has("main.js")) {
      throw new Error(
        "The repository needs root mod.json and main.js files; build-only mods are not supported.",
      )
    }
    const json = await git(path, ["show", `${commit}:mod.json`])
    const entry = await git(path, ["show", `${commit}:main.js`])
    return validateManifest(json, entry)
  }

  /** @param {string} path */
  async function checkRepository(path) {
    await io.checkPaths()
    if ((await io.kind(path)) !== "directory" || (await io.kind(`${path}/.git`)) !== "directory") {
      throw new Error("Updates require a real checkout, not a symbolic link or linked worktree.")
    }
    if (
      (await io.kind(`${path}/.git/config`)) !== "file" ||
      (await io.kind(`${path}/.git/HEAD`)) !== "file"
    ) {
      throw new Error("Git metadata must be regular files, not symbolic links.")
    }
    // Do not let local configuration redirect the worktree, run filters, or include extra config.
    const config = await io.git(path, [
      "config",
      "--local",
      "--no-includes",
      "--get-regexp",
      "^(include\\.|includeif\\.|filter\\.|url\\.|extensions\\.|core\\.(worktree|sparsecheckout)|remote\\..*\\.(uploadpack|receivepack|proxy))",
    ])
    if (config.code !== 1) {
      throw new Error("Checkout has unsupported local Git configuration; update it manually.")
    }
  }

  /** @param {string} path */
  async function ownership(path) {
    if ((await io.kind(`${path}/.git/${MARKER}`)) !== "file") {
      throw new Error("This mod was not installed by Mod Manager.")
    }
    const record = object(JSON.parse((await io.read(`${path}/.git/${MARKER}`)) ?? "null"))
    if (
      record.version !== 1 ||
      typeof record.url !== "string" ||
      typeof record.branch !== "string"
    ) {
      throw new Error("Invalid manager metadata; update this mod manually.")
    }
    const repository = parseRepository(record.url)
    if (path !== `${io.mods}/${repository.id}`) throw new Error("The managed checkout was moved.")
    await git(path, ["check-ref-format", `refs/heads/${record.branch}`])
    if ((await git(path, ["symbolic-ref", "HEAD"])) !== `refs/heads/${record.branch}`) {
      throw new Error("The checkout is not on its manager-recorded branch.")
    }
    if (
      (await git(path, ["config", "--local", "--no-includes", "--get", "remote.origin.url"])) !==
      repository.url
    ) {
      throw new Error("The checkout's GitHub origin has changed.")
    }
    return { ...repository, branch: record.branch }
  }

  /** @param {string} path */
  async function clean(path) {
    // Hidden index flags can hide edits from status. Reject them, and ignored files too.
    const tracked = await git(path, ["ls-files", "-vz"])
    if (tracked.split("\0").some((entry) => entry && !entry.startsWith("H "))) {
      throw new Error("Checkout has hidden index flags; update it manually.")
    }
    if (
      await git(path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])
    ) {
      throw new Error(
        "Local changes, untracked files, or ignored files exist. Nothing was updated.",
      )
    }
  }

  return {
    async list() {
      /** @type {Mod[]} */
      const mods = []
      for (const id of await io.list()) {
        const path = `${io.mods}/${id}`
        const kind = await io.kind(path)
        if (kind !== "directory" && kind !== "link") continue
        /** @type {Mod} */
        const mod = {
          id,
          name: id,
          description: "Local Herdr mod",
          repository: "Local files",
          version: "",
          source: kind === "link" ? "development" : "local",
          icon: kind === "link" ? "terminal" : "package",
          managed: false,
          problem: "",
        }
        try {
          const json = await io.read(`${path}/mod.json`)
          if (json !== null) {
            const manifest = object(JSON.parse(json))
            if (typeof manifest.title === "string") mod.name = manifest.title
            if (typeof manifest.description === "string") mod.description = manifest.description
            if (typeof manifest.version === "string") mod.version = manifest.version
          }
          if (kind === "link") {
            mod.repository = "Development symbolic link · never updated"
          } else if ((await io.kind(`${path}/.git`)) === "directory") {
            await checkRepository(path)
            const remote = await io.git(path, [
              "config",
              "--local",
              "--no-includes",
              "--get",
              "remote.origin.url",
            ])
            if (remote.code === 0) {
              const url = remote.stdout.trim().replace(/^git@github.com:/, "https://github.com/")
              try {
                mod.repository = parseRepository(url).label
                mod.source = "github"
              } catch {
                mod.repository = "Git checkout (not a supported GitHub source)"
              }
            }
            if ((await io.kind(`${path}/.git/${MARKER}`)) !== "missing") {
              await ownership(path)
              mod.managed = true
            }
          }
        } catch (error) {
          mod.problem = errorMessage(error)
        }
        mods.push(mod)
      }
      return mods.sort((a, b) => a.name.localeCompare(b.name))
    },

    /** @param {string} url */
    async install(url) {
      const repository = parseRepository(url)
      const destination = `${io.mods}/${repository.id}`
      await io.acquire()
      let stage = ""
      let publishing = false
      try {
        if ((await io.kind(destination)) !== "missing") {
          throw new Error("Destination already exists; nothing was overwritten.")
        }
        stage = await io.stage()
        await git(stage, [
          "clone",
          "--no-checkout",
          "--no-recurse-submodules",
          "--template=",
          "--",
          repository.url,
          ".",
        ])
        const branchRef = await git(stage, ["symbolic-ref", "HEAD"])
        if (!branchRef.startsWith("refs/heads/")) throw new Error("The default branch is invalid.")
        const branch = branchRef.slice("refs/heads/".length)
        const commit = await git(stage, ["rev-parse", "--verify", "HEAD^{commit}"])
        await validateTree(stage, commit)
        // Only this private, new staging checkout can be reset. Never reset an installed checkout.
        await git(stage, ["reset", "--hard", commit])
        await io.write(
          `${stage}/.git/${MARKER}`,
          JSON.stringify({ version: 1, url: repository.url, branch }),
          null,
        )
        publishing = true
        if (!(await io.publish(stage, destination))) {
          publishing = false
          throw new Error("Destination already exists; nothing was overwritten.")
        }
        publishing = false
        stage = ""
        return `Installed ${repository.label}. Herdr may load it immediately; reopen its view to use it.`
      } finally {
        // A publication failure may have moved some files. Do not destroy recovery evidence.
        if (!publishing) {
          if (stage) await io.cleanup(stage)
          await io.release()
        }
      }
    },

    /** @param {string} id */
    async update(id) {
      if (!/^[a-z\d][a-z\d._-]{0,99}$/.test(id) || id.endsWith(".")) {
        throw new Error("Invalid mod folder name.")
      }
      const path = `${io.mods}/${id}`
      await io.acquire()
      try {
        await checkRepository(path)
        const repository = await ownership(path)
        await clean(path)
        const before = await git(path, ["rev-parse", "HEAD"])
        // Fetch one explicit branch from the recorded HTTPS URL, never a mutable remote refspec.
        await git(path, [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          repository.url,
          `refs/heads/${repository.branch}`,
        ])
        const target = await git(path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
        await validateTree(path, target)
        if ((await io.git(path, ["merge-base", "--is-ancestor", before, target])).code !== 0) {
          throw new Error(
            "Update is not a fast-forward. Local commits or rewritten upstream history were preserved.",
          )
        }
        await checkRepository(path)
        await ownership(path)
        await clean(path)
        if ((await git(path, ["rev-parse", "HEAD"])) !== before) {
          throw new Error(
            "Checkout changed during the update; retry after other Git operations finish.",
          )
        }
        if (before === target) return `${repository.label} is already up to date.`
        await git(path, [
          "merge",
          "--ff-only",
          "--no-edit",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--no-verify",
          target,
        ])
        return `Updated ${repository.label}. Reopen its view; restart Herdr only if it still shows the old version.`
      } finally {
        await io.release()
      }
    },
  }
}
