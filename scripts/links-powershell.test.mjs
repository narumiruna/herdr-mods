import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "herdr-powershell-links-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "checkout with spaces")
  const appHome = join(root, "profile with spaces")
  const mods = join(repo, "mods")
  const layouts = join(repo, "layouts")
  const installed = join(appHome, "mods")
  const installedLayouts = join(appHome, "layouts")
  const cwd = join(root, "other working directory")
  for (const path of [join(repo, "scripts"), mods, layouts, cwd]) {
    mkdirSync(path, { recursive: true })
  }
  copyFileSync(join(repoRoot, "scripts/link.ps1"), join(repo, "scripts/link.ps1"))
  return { root, repo, appHome, mods, layouts, installed, installedLayouts, cwd }
}

function run(f, args = []) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(f.repo, "scripts/link.ps1"),
      "-AppHome",
      f.appHome,
      ...args,
    ],
    { cwd: f.cwd, encoding: "utf8", timeout: 30_000 },
  )
  assert.ifError(result.error)
  return result
}

function assertStatus(result, status = 0) {
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`)
}

function assertMissing(path) {
  assert.throws(() => lstatSync(path), { code: "ENOENT" })
}

function addMod(f, name) {
  const source = join(f.mods, name)
  mkdirSync(source)
  writeFileSync(join(source, "main.js"), "// source\n")
  return source
}

function addLayout(f, name = "workbench") {
  const layout = join(f.layouts, `${name}.json`)
  const preview = join(f.layouts, `${name}.svg`)
  writeFileSync(layout, "{}\n")
  writeFileSync(preview, '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  return { layout, preview }
}

describe("PowerShell link script", { skip: process.platform !== "win32" }, () => {
  test("links mod directories, skips hidden entries, and permits repeat runs", (t) => {
    const f = fixture(t)
    const first = addMod(f, "first mod")
    addMod(f, ".hidden")
    writeFileSync(join(f.mods, "notes.txt"), "keep")
    assertStatus(run(f))
    assert.equal(readlinkSync(join(f.installed, "first mod")), first)
    assertMissing(join(f.installed, ".hidden"))
    assertMissing(join(f.installed, "notes.txt"))
    const repeated = run(f)
    assertStatus(repeated)
    assert.match(repeated.stdout, /Already linked:/)
    const second = addMod(f, "second")
    assertStatus(run(f))
    assert.equal(readlinkSync(join(f.installed, "second")), second)
    writeFileSync(join(f.installed, "first mod/main.js"), "// changed through junction\n")
    assert.equal(readFileSync(join(first, "main.js"), "utf8"), "// changed through junction\n")
  })

  test("WhatIf does not create the profile or links", (t) => {
    const f = fixture(t)
    addMod(f, "matching")
    addLayout(f)
    const result = run(f, ["-WhatIf"])
    assertStatus(result)
    assert.match(result.stdout, /What if:/i)
    assertMissing(f.appHome)
  })

  test("preserves files, directories, foreign junctions, and broken junctions", (t) => {
    const f = fixture(t)
    mkdirSync(f.installed, { recursive: true })
    for (const name of ["file", "directory", "foreign", "broken", "z-new"]) addMod(f, name)
    const outside = join(f.root, "outside")
    const missing = join(f.root, "missing")
    mkdirSync(outside)
    writeFileSync(join(f.installed, "file"), "keep file")
    mkdirSync(join(f.installed, "directory"))
    symlinkSync(outside, join(f.installed, "foreign"), "junction")
    symlinkSync(missing, join(f.installed, "broken"), "junction")
    const result = run(f)
    assertStatus(result, 1)
    assert.match(result.stdout, /Conflict, not changed:/)
    assert.equal(readFileSync(join(f.installed, "file"), "utf8"), "keep file")
    assert.ok(lstatSync(join(f.installed, "directory")).isDirectory())
    assert.equal(readlinkSync(join(f.installed, "foreign")), outside)
    assert.equal(readlinkSync(join(f.installed, "broken")), missing)
    assert.equal(readlinkSync(join(f.installed, "z-new")), join(f.mods, "z-new"))
  })

  test("preserves layout conflicts and continues with mod links", (t) => {
    const f = fixture(t)
    const mod = addMod(f, "matching")
    addLayout(f)
    mkdirSync(f.installedLayouts, { recursive: true })
    writeFileSync(join(f.installedLayouts, "workbench.json"), "keep layout")
    mkdirSync(join(f.installedLayouts, "workbench.svg"))
    assertStatus(run(f), 1)
    assert.equal(readFileSync(join(f.installedLayouts, "workbench.json"), "utf8"), "keep layout")
    assert.ok(lstatSync(join(f.installedLayouts, "workbench.svg")).isDirectory())
    assert.equal(readlinkSync(join(f.installed, "matching")), mod)
  })

  test("reports directory errors and continues with the other destination", (t) => {
    const f = fixture(t)
    mkdirSync(f.appHome)
    writeFileSync(f.installed, "keep file")
    const result = run(f)
    assertStatus(result, 1)
    assert.match(result.stdout, /Cannot process mods:/)
    assert.equal(readFileSync(f.installed, "utf8"), "keep file")
    assert.ok(lstatSync(f.installedLayouts).isDirectory())
  })

  test("permits missing source directories without creating them", (t) => {
    const f = fixture(t)
    rmSync(f.mods, { recursive: true })
    rmSync(f.layouts, { recursive: true })
    assertStatus(run(f))
    assertMissing(f.mods)
    assertMissing(f.layouts)
    assert.ok(lstatSync(f.installed).isDirectory())
    assert.ok(lstatSync(f.installedLayouts).isDirectory())
  })

  test("file link errors give a permission hint without copying files", (t) => {
    const f = fixture(t)
    addLayout(f)
    const result = run(f)
    if (result.status === 0) {
      assert.ok(lstatSync(join(f.installedLayouts, "workbench.json")).isSymbolicLink())
      assert.ok(lstatSync(join(f.installedLayouts, "workbench.svg")).isSymbolicLink())
      return
    }
    assertStatus(result, 1)
    assert.match(result.stdout, /Administrator privilege required|A required privilege is not held/i)
    assert.match(result.stdout, /Developer Mode/)
    assertMissing(join(f.installedLayouts, "workbench.json"))
    assertMissing(join(f.installedLayouts, "workbench.svg"))
    assert.ok(existsSync(join(f.layouts, "workbench.json")))
  })

  test("links layouts and SVG previews, recognizes repeat runs, and skips other entries", (t) => {
    const f = fixture(t)
    const { layout, preview } = addLayout(f)
    writeFileSync(join(f.layouts, "README.md"), "keep")
    writeFileSync(join(f.layouts, ".hidden.json"), "{}")
    mkdirSync(join(f.layouts, "directory.json"))
    mkdirSync(join(f.layouts, ".state"))
    writeFileSync(join(f.layouts, ".state/workbench.json"), "{}")
    const result = run(f)
    const lacksPrivilege = /Administrator privilege required|A required privilege is not held/i
    if (result.status !== 0 && lacksPrivilege.test(result.stdout)) {
      t.skip("Windows PowerShell cannot create file symbolic links with the current permissions")
      return
    }
    assertStatus(result)
    assert.equal(readlinkSync(join(f.installedLayouts, "workbench.json")), layout)
    assert.equal(readlinkSync(join(f.installedLayouts, "workbench.svg")), preview)
    for (const name of ["README.md", ".hidden.json", "directory.json", ".state"]) {
      assertMissing(join(f.installedLayouts, name))
    }
    const repeated = run(f)
    assertStatus(repeated)
    assert.match(repeated.stdout, /Already linked:/)
    const second = addLayout(f, "second layout")
    assertStatus(run(f))
    assert.equal(readlinkSync(join(f.installedLayouts, "second layout.json")), second.layout)
    writeFileSync(join(f.installedLayouts, "workbench.json"), '{"changed":true}\n')
    assert.equal(readFileSync(layout, "utf8"), '{"changed":true}\n')
  })
})
