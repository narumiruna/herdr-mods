import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { addPanel, removePanel } from "./model.js"
import { discoverMods, includeMissing, overlaySpec, readSnapshot, saveSnapshot } from "./runtime.js"

const temporary = []
const baseTree = { id: "original", type: "block", content: { tab: "active" } }

async function fixture(index = {}) {
  const directory = await mkdtemp(join(tmpdir(), "layout-manager-test-"))
  temporary.push(directory)
  const home = join(directory, "profile")
  await mkdir(join(home, "mods"), { recursive: true })
  await mkdir(join(home, "layouts"))
  await writeFile(join(home, "installed.json"), JSON.stringify(index))
  await writeFile(join(home, "layouts", "personal.json"), JSON.stringify(baseTree))
  const io = {
    home,
    currentName: () => "personal",
    list: (path) => readdir(path),
    async exists(path) {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    async readText(path) {
      try {
        return await readFile(path, "utf8")
      } catch (error) {
        if (error.code === "ENOENT") return null
        throw error
      }
    },
    async writeText(path, text, expected) {
      if ((await io.readText(path)) !== expected) throw new Error("Stale snapshot")
      await writeFile(path, text)
    },
  }
  return { home, directory, io }
}

async function mod(directory, name, manifest = {}) {
  const path = join(directory, name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "main.js"), 'throw new Error("Discovery must never execute mod code")')
  await writeFile(join(path, "mod.json"), JSON.stringify(manifest))
  return path
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("discovery", () => {
  it("reads real and linked mod roots without executing their entry points", async () => {
    const { home, directory, io } = await fixture({ agents: {} })
    await mod(join(home, "mods"), "agents", { title: "Agents" })
    const linked = await mod(directory, "source", { title: "Linked Mod" })
    await symlink(linked, join(home, "mods", "linked"))
    await symlink(join(directory, "not-installed"), join(home, "mods", "broken"))
    await writeFile(join(home, "mods", "notes.txt"), "not a mod")
    const result = await discoverMods(io)
    expect(result.map((item) => [item.name, item.title, item.shipped, item.available])).toEqual([
      ["linked", "Linked Mod", false, true],
      ["agents", "Agents", true, true],
    ])
  })

  it("reports invalid manifests without hiding valid mods", async () => {
    const { home, io } = await fixture()
    const invalid = await mod(join(home, "mods"), "invalid")
    await writeFile(join(invalid, "mod.json"), "not JSON")
    await mod(join(home, "mods"), "valid", { title: "Valid" })
    const result = await discoverMods(io)
    expect(result.find((item) => item.name === "invalid").available).toBe(false)
    expect(result.find((item) => item.name === "valid").available).toBe(true)
  })

  it("reports missing entry points and rejects non-object manifests", async () => {
    const { home, io } = await fixture()
    const missing = await mod(join(home, "mods"), "missing")
    await rm(join(missing, "main.js"))
    await mod(join(home, "mods"), "array", [])
    const result = await discoverMods(io)
    expect(result.find((item) => item.name === "missing").error).toContain("main.js is missing")
    expect(result.find((item) => item.name === "array").error).toContain("JSON object")
  })

  it("keeps missing managed placements and restores the same mod after reinstall", async () => {
    const { home, io } = await fixture()
    const tree = addPanel(baseTree, { name: "example", title: "Example", props: { footer: true } })
    await writeFile(join(home, "layouts", "personal.json"), JSON.stringify(tree))
    const snapshot = await readSnapshot(io, "personal")
    const missing = includeMissing(await discoverMods(io), snapshot)
    expect(missing).toMatchObject([{ name: "example", available: false }])
    await mod(join(home, "mods"), "example", { title: "Example" })
    const reinstalled = includeMissing(await discoverMods(io), snapshot)
    expect(reinstalled).toHaveLength(1)
    expect(reinstalled[0].available).toBe(true)
    expect(snapshot.slots[0].props).toEqual({ footer: true })
  })
})

describe("layout writes", () => {
  it("edits only the captured personal file and removes the final managed panel", async () => {
    const { home, io } = await fixture({ "layout:main": {} })
    await writeFile(join(home, "layouts", "main.json"), "do not touch")
    const first = await readSnapshot(io, "personal")
    const added = await saveSnapshot(io, first, (tree) =>
      addPanel(tree, { name: "example", title: "Example", props: { mode: "list" } }),
    )
    expect(JSON.parse(await io.readText(first.path))).toEqual(added.tree)
    const removed = await saveSnapshot(io, added, (tree) => removePanel(tree, "example"))
    expect(removed.tree).toEqual(baseTree)
    expect(await io.readText(join(home, "layouts", "main.json"))).toBe("do not touch")
  })

  it("rejects shipped layouts even when a stale snapshot said personal", async () => {
    const { home, io } = await fixture()
    const snapshot = await readSnapshot(io, "personal")
    await writeFile(join(home, "installed.json"), JSON.stringify({ "layout:personal": {} }))
    await expect(saveSnapshot(io, snapshot, (tree) => tree)).rejects.toThrow("read-only")
    expect(await io.readText(snapshot.path)).toBe(snapshot.raw)
  })

  it("rejects changed files without overwriting the external edit", async () => {
    const { io } = await fixture()
    const snapshot = await readSnapshot(io, "personal")
    const external = `${snapshot.raw}\n`
    await writeFile(snapshot.path, external)
    await expect(
      saveSnapshot(io, snapshot, (tree) => addPanel(tree, { name: "example", props: {} })),
    ).rejects.toThrow("Stale snapshot")
    expect(await io.readText(snapshot.path)).toBe(external)
  })

  it("rejects layout switches, tampered paths, unsafe names, and invalid transforms", async () => {
    const { io } = await fixture()
    const snapshot = await readSnapshot(io, "personal")
    io.currentName = () => "different"
    await expect(saveSnapshot(io, snapshot, (tree) => tree)).rejects.toThrow(
      "current layout changed",
    )
    io.currentName = () => "personal"
    await expect(saveSnapshot(io, { ...snapshot, path: "/other" }, (tree) => tree)).rejects.toThrow(
      "target changed",
    )
    await expect(readSnapshot(io, "../main")).rejects.toThrow("not supported")
    await expect(saveSnapshot(io, snapshot, () => null)).rejects.toThrow()
    expect(await io.readText(snapshot.path)).toBe(snapshot.raw)
  })

  it("fails closed when shipped-layout metadata is absent or invalid", async () => {
    const { home, io } = await fixture()
    const snapshot = await readSnapshot(io, "personal")
    for (const raw of ["null", "[]", "invalid JSON"]) {
      await writeFile(join(home, "installed.json"), raw)
      await expect(saveSnapshot(io, snapshot, (tree) => tree)).rejects.toThrow("installed.json")
      await expect(readSnapshot(io, "personal")).rejects.toThrow("installed.json")
    }
    await rm(join(home, "installed.json"))
    await expect(saveSnapshot(io, snapshot, (tree) => tree)).rejects.toThrow(
      "installed.json is missing",
    )
    expect(await io.readText(snapshot.path)).toBe(snapshot.raw)
  })
})

describe("overlays", () => {
  it("honors supported manifest dimensions and kind without keeping the window", () => {
    const item = {
      name: "example",
      available: true,
      manifest: {
        overlay: { kind: "window", width: 480, height: 0.85, key: "foreign", keep: true },
      },
    }
    expect(overlaySpec(item, { mode: "list" })).toEqual({
      mod: "example",
      props: { mode: "list" },
      kind: "window",
      width: 480,
      height: 0.85,
    })
  })

  it("uses safe defaults and refuses unavailable mods or invalid props", () => {
    const item = {
      name: "example",
      available: true,
      manifest: { overlay: { kind: "unknown", width: -1, height: "large" } },
    }
    expect(overlaySpec(item, {})).toMatchObject({ kind: "dialog", width: 720, height: 0.8 })
    expect(() => overlaySpec({ ...item, available: false }, {})).toThrow("not available")
    expect(() => overlaySpec(item, [])).toThrow("JSON object")
  })
})
