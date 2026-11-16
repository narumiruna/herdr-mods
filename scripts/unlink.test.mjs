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
import { basename, dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const windowsOnly = { skip: process.platform !== "win32" }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "herdr-unlink-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "checkout with spaces")
  const profile = join(root, "profile with spaces")
  const mods = join(repo, "mods")
  const layouts = join(repo, "layouts")
  const installed = join(profile, "mods")
  const installedLayouts = join(profile, "layouts")
  const cwd = join(root, "other working directory")
  for (const path of [join(repo, "scripts"), mods, layouts, installed, installedLayouts, cwd]) {
    mkdirSync(path, { recursive: true })
  }
  for (const name of ["link.ps1", "unlink.ps1"]) {
    copyFileSync(join(repoRoot, "scripts", name), join(repo, "scripts", name))
  }
  return { root, repo, profile, mods, layouts, installed, installedLayouts, cwd }
}

function run(f, { command = "unlink", args = [], status = 0, appHome = f.profile } = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(f.repo, "scripts", `${command}.ps1`),
      "-AppHome",
      appHome,
      ...args,
    ],
    { cwd: f.cwd, encoding: "utf8", timeout: 30_000 },
  )
  assert.ifError(result.error)
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`)
  return result
}

function addMod(f, name = "matching") {
  const source = join(f.mods, name)
  mkdirSync(join(source, "nested"), { recursive: true })
  writeFileSync(join(source, "nested", "main.js"), "// Keep source files.\n")
  return source
}

function assertMissing(path) {
  assert.throws(() => lstatSync(path), { code: "ENOENT" })
}

function requireSymbolicLinks(t, f) {
  const source = join(f.root, "symlink-source.txt")
  const target = join(f.root, "symlink-probe.txt")
  writeFileSync(source, "probe")
  try {
    symlinkSync(source, target, "file")
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error
    t.skip("File symbolic links require Administrator permissions or Windows Developer Mode")
    return false
  }
  rmSync(target)
  return true
}

test("PowerShell unlink removes link.ps1 junctions without changing sources", windowsOnly, (t) => {
  const f = fixture(t)
  const source = addMod(f)
  run(f, { command: "link" })
  const target = join(f.installed, "matching")
  assert.ok(lstatSync(target).isSymbolicLink())
  assert.match(run(f).stdout, /Unlinked:/)
  assertMissing(target)
  run(f)
  assert.equal(readFileSync(join(source, "nested", "main.js"), "utf8"), "// Keep source files.\n")
  assert.ok(existsSync(f.installed))
})

test(
  "PowerShell unlink WhatIf preserves junctions and accepts a relative AppHome",
  windowsOnly,
  (t) => {
    const f = fixture(t)
    const source = addMod(f)
    const target = join(f.installed, "matching")
    symlinkSync(source, target, "junction")
    const appHome = relative(f.cwd, f.profile)
    assert.match(run(f, { appHome, args: ["-WhatIf"] }).stdout, /What if:/i)
    assert.ok(lstatSync(target).isSymbolicLink())
    assert.ok(existsSync(join(source, "nested", "main.js")))
    run(f, { appHome })
    assertMissing(target)
  },
)

for (const missingParent of [false, true]) {
  test(
    `PowerShell unlink removes broken junctions; missing source parent: ${missingParent}`,
    windowsOnly,
    (t) => {
      const f = fixture(t)
      const source = addMod(f)
      const target = join(f.installed, "matching")
      symlinkSync(source, target, "junction")
      rmSync(missingParent ? f.mods : source, { recursive: true })
      run(f)
      assertMissing(target)
      assert.equal(existsSync(f.mods), !missingParent)
    },
  )
}

test(
  "PowerShell unlink keeps unrelated links, real entries, and unsupported layouts",
  windowsOnly,
  (t) => {
    const f = fixture(t)
    const source = addMod(f)
    const external = join(f.root, "other checkout", "mods", "foreign")
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, "keep.txt"), "external")
    const foreign = join(f.installed, "foreign")
    const wrongName = join(f.installed, "wrong-name")
    const broken = join(f.installed, "broken")
    symlinkSync(external, foreign, "junction")
    symlinkSync(source, wrongName, "junction")
    symlinkSync(join(f.root, "missing elsewhere"), broken, "junction")
    const real = join(f.installed, "real")
    mkdirSync(real)
    symlinkSync(source, join(real, "nested"), "junction")
    writeFileSync(join(f.installed, "keep.txt"), "real file")
    writeFileSync(join(f.installedLayouts, "workbench.json"), "{}")
    const directory = join(f.layouts, "directory.json")
    mkdirSync(directory)
    symlinkSync(directory, join(f.installedLayouts, "directory.json"), "junction")
    for (const name of [".hidden", ".state"]) {
      const hidden = addMod(f, name)
      symlinkSync(hidden, join(f.installed, name), "junction")
    }
    run(f)
    for (const target of [foreign, wrongName, broken, join(real, "nested")]) {
      assert.ok(lstatSync(target).isSymbolicLink())
    }
    assert.equal(readFileSync(join(f.installed, "keep.txt"), "utf8"), "real file")
    assert.equal(readFileSync(join(f.installedLayouts, "workbench.json"), "utf8"), "{}")
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external")
    assert.ok(lstatSync(join(f.installedLayouts, "directory.json")).isSymbolicLink())
    assert.ok(lstatSync(join(f.installed, ".hidden")).isSymbolicLink())
    assert.ok(lstatSync(join(f.installed, ".state")).isSymbolicLink())
  },
)

test(
  "PowerShell unlink compares normalized Windows targets without case sensitivity",
  windowsOnly,
  (t) => {
    const f = fixture(t)
    const source = addMod(f)
    const target = join(f.installed, "matching")
    symlinkSync(`${f.mods.toUpperCase()}\\.\\matching\\`, target, "junction")
    run(f)
    assertMissing(target)
    assert.ok(existsSync(source))
  },
)

test("PowerShell unlink does not create a missing profile", windowsOnly, (t) => {
  const f = fixture(t)
  rmSync(f.profile, { recursive: true })
  run(f, { args: ["-WhatIf"] })
  run(f)
  assertMissing(f.profile)
})

test("PowerShell unlink rejects an empty AppHome without changing links", windowsOnly, (t) => {
  const f = fixture(t)
  const source = addMod(f)
  const target = join(f.installed, "matching")
  symlinkSync(source, target, "junction")
  run(f, { appHome: "", status: 1 })
  assert.ok(lstatSync(target).isSymbolicLink())
})

test(
  "PowerShell unlink reports each noninteractive confirmation failure and continues",
  windowsOnly,
  (t) => {
    const f = fixture(t)
    for (const name of ["first", "second"]) {
      symlinkSync(addMod(f, name), join(f.installed, name), "junction")
    }
    const result = run(f, { args: ["-Confirm"], status: 1 })
    assert.equal([...result.stdout.matchAll(/Cannot unlink/g)].length, 2)
    for (const name of ["first", "second"]) {
      assert.ok(lstatSync(join(f.installed, name)).isSymbolicLink())
      assert.ok(existsSync(join(f.mods, name, "nested", "main.js")))
    }
  },
)

for (const form of ["absolute", "relative", "absolute with dot"]) {
  test(
    `PowerShell unlink removes ${form} layout and directory symbolic links`,
    windowsOnly,
    (t) => {
      const f = fixture(t)
      if (!requireSymbolicLinks(t, f)) return
      const mod = addMod(f)
      const sources = [mod]
      const targets = [join(f.installed, "matching")]
      for (const extension of ["json", "svg"]) {
        const name = `workbench.${extension}`
        const source = join(f.layouts, name)
        writeFileSync(source, extension === "json" ? "{}" : "<svg/>")
        sources.push(source)
        targets.push(join(f.installedLayouts, name))
      }
      for (const [index, source] of sources.entries()) {
        const target = targets[index]
        const stored =
          form === "relative"
            ? relative(dirname(target), source)
            : form === "absolute with dot"
              ? `${dirname(source)}\\.\\${basename(source)}`
              : source
        symlinkSync(stored, target, index === 0 ? "dir" : "file")
      }
      run(f, { args: ["-WhatIf"] })
      for (const target of targets) assert.ok(lstatSync(target).isSymbolicLink())
      run(f)
      run(f)
      for (const target of targets) assertMissing(target)
      for (const source of sources) assert.ok(existsSync(source))
    },
  )
}

for (const missingParent of [false, true]) {
  test(
    `PowerShell unlink removes broken layout links; missing source parent: ${missingParent}`,
    windowsOnly,
    (t) => {
      const f = fixture(t)
      if (!requireSymbolicLinks(t, f)) return
      const targets = []
      for (const extension of ["json", "svg"]) {
        const source = join(f.layouts, `workbench.${extension}`)
        const target = join(f.installedLayouts, `workbench.${extension}`)
        writeFileSync(source, "keep")
        symlinkSync(relative(f.installedLayouts, source), target, "file")
        targets.push(target)
        rmSync(source)
      }
      if (missingParent) rmSync(f.layouts, { recursive: true })
      run(f)
      for (const target of targets) assertMissing(target)
      assert.equal(existsSync(f.layouts), !missingParent)
    },
  )
}

test(
  "PowerShell unlink keeps foreign, wrong-name, and unsupported file links",
  windowsOnly,
  (t) => {
    const f = fixture(t)
    if (!requireSymbolicLinks(t, f)) return
    const sources = [
      join(f.root, "foreign.json"),
      join(f.layouts, "workbench.json"),
      join(f.layouts, "README.md"),
    ]
    const targets = [
      join(f.installedLayouts, "foreign.json"),
      join(f.installedLayouts, "wrong-name.json"),
      join(f.installedLayouts, "README.md"),
    ]
    for (const [index, source] of sources.entries()) {
      writeFileSync(source, "keep")
      symlinkSync(source, targets[index], "file")
    }
    run(f)
    for (const [index, target] of targets.entries()) {
      assert.equal(readlinkSync(target), sources[index])
    }
  },
)
