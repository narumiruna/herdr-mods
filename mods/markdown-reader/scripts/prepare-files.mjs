#!/usr/bin/env node
// Offline preparation only. This command never calls Herdr or modifies a profile.
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  cloneLayout,
  FILES_SOURCE_SHA256,
  REQUIRED_ICONS,
  safeName,
  transformFilesSource,
} from "../integration.js"

const LAYOUT_SHA256 = "b4438dafcf1aa379b0d08b62a97af37b31bb63b9ff9e5537d1848a8f221bea7f"
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function contains(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

// Reject links in every existing component, including parent directories. Output
// must have an existing parent. This is an offline tool, not a concurrent installer.
async function checkPath(path, allowMissingLeaf = false) {
  const root = parse(path).root
  let current = root
  const components = path.slice(root.length).split(sep).filter(Boolean)
  for (const [index, part] of components.entries()) {
    current = join(current, part)
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`)
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error(`Expected a directory: ${current}`)
    }
  }
}

async function readRegular(path) {
  await checkPath(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error(`Unsupported source: expected a regular file of at most 1 MiB: ${path}`)
  }
  return readFile(path)
}

/** Prepare an isolated mods/files-markdown + layouts/markdown-reader.json tree.
 * profile/output must be explicit absolute paths; output must not exist.
 * No reader runtime is copied. Install that mod separately with place: "none".
 */
export async function prepareFilesIntegration({
  profile,
  output,
  cloneName = "files-markdown",
  layoutName = "markdown-reader",
}) {
  for (const [name, value] of Object.entries({ profile, output })) {
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      value.includes("\0") ||
      value.split(sep).includes("..")
    ) {
      throw new Error(`${name} must be an explicit absolute path without parent traversal`)
    }
  }
  safeName(cloneName)
  safeName(layoutName)
  if (["main", "terminals", "win98"].includes(layoutName)) {
    throw new Error("The personal layout must not use a shipped layout name")
  }
  // Validate clone names even if the source is unavailable.
  if (["files", "markdown-reader"].includes(cloneName)) {
    throw new Error("The Files clone must have a separate personal name")
  }
  profile = resolve(profile)
  output = resolve(output)
  let active = resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"))
  try {
    active = await realpath(active)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  for (const protectedPath of [profile, active]) {
    if (contains(protectedPath, output) || contains(output, protectedPath)) {
      throw new Error("Output must be separate from the source and active profiles")
    }
  }
  await checkPath(profile)
  // A personal name must not collide with a shipped or personal installed name.
  for (const destination of [
    join(profile, "mods", cloneName),
    join(profile, "layouts", `${layoutName}.json`),
  ]) {
    try {
      await lstat(destination)
      throw new Error(`Personal name is already installed; choose a new name: ${destination}`)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  await checkPath(output, true)
  try {
    await lstat(output)
    throw new Error(`Output already exists; nothing was changed: ${output}`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  const files = join(profile, "mods/files")
  const source = (await readRegular(join(files, "main.js"))).toString("utf8")
  const modSource = await readRegular(join(files, "mod.json"))
  const layoutSource = await readRegular(join(profile, "layouts/main.json"))
  // Validate target uniqueness before the version check for a specific failure.
  const main = transformFilesSource(source, cloneName)
  if (sha256(source) !== FILES_SOURCE_SHA256 || sha256(layoutSource) !== LAYOUT_SHA256) {
    throw new Error(
      "Unsupported source version: Files/main layout differs from the reviewed snapshot",
    )
  }
  let mod
  try {
    mod = JSON.parse(modSource.toString("utf8"))
  } catch {
    throw new Error("Unsupported Files manifest: invalid JSON")
  }
  if (!mod || Object.keys(mod).length !== 1 || mod.place !== "none") {
    throw new Error("Unsupported Files manifest: expected only place: none")
  }
  const { layout, replacements } = cloneLayout(JSON.parse(layoutSource.toString("utf8")), cloneName)
  const icons = await Promise.all(
    REQUIRED_ICONS.map(async (name) => [name, await readRegular(join(files, name))]),
  )
  const metadata = {
    filesSourceSha256: FILES_SOURCE_SHA256,
    layoutSourceSha256: LAYOUT_SHA256,
    cloneName,
    layoutName,
    replacements,
  }

  // All source validation is complete. Exclusive mkdir refuses existing output,
  // including dangling links. On a write failure, remove only our new directory.
  await mkdir(output)
  try {
    const destination = join(output, "mods", cloneName)
    await mkdir(destination, { recursive: true })
    await mkdir(join(output, "layouts"))
    const generated = [
      [join(destination, "main.js"), main],
      [join(destination, "mod.json"), `${JSON.stringify({ place: "none" }, null, 2)}\n`],
      [join(output, "layouts", `${layoutName}.json`), `${JSON.stringify(layout, null, 2)}\n`],
      [join(output, "preparation.json"), `${JSON.stringify(metadata, null, 2)}\n`],
      ...icons.map(([name, bytes]) => [join(destination, name), bytes]),
    ]
    for (const [path, value] of generated) await writeFile(path, value, { flag: "wx" })
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
  return {
    ...metadata,
    output,
    filesMod: join(output, "mods", cloneName),
    layout: join(output, "layouts", `${layoutName}.json`),
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = {}
  const names = {
    "--profile": "profile",
    "--output": "output",
    "--clone-name": "cloneName",
    "--layout-name": "layoutName",
  }
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]]
    const value = args[index + 1]
    if (!name || !value || value.startsWith("--") || options[name] !== undefined) {
      throw new Error(
        "Usage: node scripts/prepare-files.mjs --profile /absolute/profile --output /absolute/new-directory [--clone-name files-markdown] [--layout-name markdown-reader]",
      )
    }
    options[name] = value
  }
  const result = await prepareFilesIntegration(options)
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Files integration preparation failed: ${error.message}`)
    process.exitCode = 1
  })
}
