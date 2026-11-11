import { managedSlots, validateLayout, validName } from "./model.js"

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function installation(raw) {
  if (raw === null) throw new Error("installed.json is missing. Layout editing is blocked.")
  let index
  try {
    index = JSON.parse(raw)
  } catch {
    throw new Error("installed.json is invalid. Layout editing is blocked.")
  }
  if (!object(index))
    throw new Error("installed.json must be an object. Layout editing is blocked.")
  return index
}

function layoutPath(home, name) {
  if (!validName(name)) throw new Error("The current layout name is not supported.")
  return `${home}/layouts/${name}.json`
}

export async function readSnapshot(io, name) {
  const path = layoutPath(io.home, name)
  const [raw, installed] = await Promise.all([
    io.readText(path),
    io.readText(`${io.home}/installed.json`),
  ])
  const index = installation(installed)
  if (raw === null) throw new Error(`Layout ${name} is missing. Select another layout and refresh.`)
  let tree
  try {
    tree = JSON.parse(raw)
  } catch {
    throw new Error(`Layout ${name} contains invalid JSON. No changes were made.`)
  }
  validateLayout(tree)
  const slots = managedSlots(tree)
  return { name, path, raw, tree, slots, shipped: Object.hasOwn(index, `layout:${name}`) }
}

export async function discoverMods(io) {
  const names = await io.list(`${io.home}/mods`)
  const index = installation(await io.readText(`${io.home}/installed.json`))
  const mods = await Promise.all(
    names.filter(validName).map(async (name) => {
      const directory = `${io.home}/mods/${name}`
      try {
        // Read through the path, not Dirent.isDirectory(): development links are valid mods.
        const [main, manifestExists] = await Promise.all([
          io.exists(`${directory}/main.js`),
          io.exists(`${directory}/mod.json`),
        ])
        if (!main && !manifestExists) return null
        const raw = manifestExists ? await io.readText(`${directory}/mod.json`) : null
        const manifest = raw === null ? null : JSON.parse(raw)
        if (!object(manifest)) throw new Error("mod.json is missing or is not a JSON object.")
        if (!main) throw new Error("main.js is missing.")
        return {
          name,
          title:
            typeof manifest.title === "string" && manifest.title.trim() ? manifest.title : name,
          manifest,
          shipped: Object.hasOwn(index, name),
          available: true,
          error: "",
        }
      } catch (error) {
        return {
          name,
          title: name,
          manifest: {},
          shipped: Object.hasOwn(index, name),
          available: false,
          error: `Cannot load this mod: ${String(error?.message ?? error)}`,
        }
      }
    }),
  )
  return mods
    .filter(Boolean)
    .sort((a, b) => Number(a.shipped) - Number(b.shipped) || a.title.localeCompare(b.title))
}

export function includeMissing(mods, snapshot) {
  const found = new Set(mods.map((mod) => mod.name))
  return [
    ...mods,
    ...(snapshot?.slots ?? [])
      .filter((slot) => !found.has(slot.name))
      .map((slot) => ({
        name: slot.name,
        title: slot.title,
        manifest: {},
        shipped: false,
        available: false,
        missing: true,
        error: "Not installed. Reinstall the same folder name to reuse this panel and its props.",
      })),
  ]
}

export async function saveSnapshot(io, snapshot, transform) {
  if (!snapshot || typeof snapshot.raw !== "string") throw new Error("Refresh the layout first.")
  const path = layoutPath(io.home, snapshot.name)
  if (path !== snapshot.path) throw new Error("The layout target changed. Refresh before editing.")
  const index = installation(await io.readText(`${io.home}/installed.json`))
  if (snapshot.shipped || Object.hasOwn(index, `layout:${snapshot.name}`)) {
    throw new Error("Herdr's layouts are read-only. Clone this layout before editing it.")
  }
  if (io.currentName() !== snapshot.name) {
    throw new Error("The current layout changed. Refresh before editing.")
  }
  const tree = transform(snapshot.tree)
  validateLayout(tree)
  const slots = managedSlots(tree)
  if (JSON.stringify(tree) === JSON.stringify(snapshot.tree)) return snapshot
  const raw = `${JSON.stringify(tree, null, 2)}\n`
  // The host atomically rejects a write if the file changed after discovery.
  await io.writeText(path, raw, snapshot.raw)
  return { ...snapshot, raw, tree, slots }
}

export function overlaySpec(mod, props) {
  if (!mod?.available || !validName(mod.name)) throw new Error("This mod is not available.")
  if (!object(props)) throw new Error("Props must be a JSON object.")
  const overlay = object(mod.manifest.overlay) ? mod.manifest.overlay : {}
  const dimension = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    mod: mod.name,
    props,
    kind: ["dialog", "popup", "window"].includes(overlay.kind) ? overlay.kind : "dialog",
    width: dimension(overlay.width, 720),
    height: dimension(overlay.height, 0.8),
  }
}
