import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-mod-links-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "checkout with spaces")
  const home = join(root, "home with spaces")
  const mods = join(repo, "mods")
  const installed = join(home, ".config/herdr-app/mods")
  const cwd = join(root, "other working directory")
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true })
  for (const path of [mods, installed, cwd]) mkdirSync(path, { recursive: true })
  return { root, repo, home, mods, installed, cwd }
}

function run(f, command, status = 0) {
  const result = spawnSync(join(f.repo, "scripts", `${command}-mods.sh`), [], {
    cwd: f.cwd,
    env: { ...process.env, HOME: f.home },
    encoding: "utf8",
  })
  assert.ifError(result.error)
  assert.equal(result.status, status, result.stderr)
  return result
}

function addMod(f, name) {
  const path = join(f.mods, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "main.js"), "// Source must stay unchanged.\n")
  return path
}

function assertMissing(path) {
  assert.throws(() => lstatSync(path), { code: "ENOENT" })
}

test("link discovers directories, uses absolute paths, and permits repeat runs", (t) => {
  const f = fixture(t)
  const first = addMod(f, "first mod")
  writeFileSync(join(f.mods, "not-a-mod.txt"), "keep")
  run(f, "link")
  assert.equal(readlinkSync(join(f.installed, "first mod")), first)
  assertMissing(join(f.installed, "not-a-mod.txt"))
  run(f, "link")
  const second = addMod(f, "second")
  run(f, "link")
  assert.equal(readlinkSync(join(f.installed, "second")), second)
  run(f, "unlink")
  run(f, "unlink")
  assert.equal(readFileSync(join(first, "main.js"), "utf8"), "// Source must stay unchanged.\n")
  assert.ok(existsSync(second))
})

for (const form of ["relative", "absolute with dot", "relative with trailing slash"]) {
  test(`both scripts recognize a matching ${form} link`, (t) => {
    const f = fixture(t)
    const source = addMod(f, "matching")
    const target = join(f.installed, "matching")
    const stored =
      form === "absolute with dot"
        ? `${f.mods}/./matching`
        : `${relative(f.installed, source)}${form.endsWith("slash") ? "/" : ""}`
    symlinkSync(stored, target)
    assert.match(run(f, "link").stdout, /Already linked:/)
    assert.equal(readlinkSync(target), stored)
    run(f, "unlink")
    assertMissing(target)
    assert.ok(existsSync(source))
  })
}

for (const missingParent of [false, true]) {
  test(`unlink removes absolute and relative broken links; missing parent: ${missingParent}`, (t) => {
    const f = fixture(t)
    const absolute = join(f.installed, "absolute")
    const relativeTarget = join(f.installed, "relative")
    symlinkSync(join(f.mods, "absolute"), absolute)
    symlinkSync(relative(f.installed, join(f.mods, "relative")), relativeTarget)
    if (missingParent) rmSync(f.mods, { recursive: true })
    run(f, "unlink")
    assertMissing(absolute)
    assertMissing(relativeTarget)
  })
}

test("unlink removes matching broken links when the mods parent is a dangling symlink", (t) => {
  const f = fixture(t)
  const outside = join(f.root, "external mods")
  mkdirSync(join(outside, "absolute"), { recursive: true })
  mkdirSync(join(outside, "relative"))
  rmSync(f.mods, { recursive: true })
  symlinkSync(outside, f.mods)
  run(f, "link")
  const relativeTarget = join(f.installed, "relative")
  rmSync(relativeTarget)
  symlinkSync(relative(f.installed, join(f.mods, "relative")), relativeTarget)
  rmSync(outside, { recursive: true })
  run(f, "unlink")
  assertMissing(join(f.installed, "absolute"))
  assertMissing(relativeTarget)
  assert.ok(lstatSync(f.mods).isSymbolicLink())
})

test("conflicts stay unchanged and do not stop other mods", (t) => {
  const f = fixture(t)
  const outside = join(f.root, "outside")
  mkdirSync(outside)
  for (const name of ["file", "directory", "foreign", "broken", "z-new"]) addMod(f, name)
  writeFileSync(join(f.installed, "file"), "keep file")
  mkdirSync(join(f.installed, "directory"))
  symlinkSync(outside, join(f.installed, "foreign"))
  symlinkSync(`${outside}/missing`, join(f.installed, "broken"))
  assert.match(run(f, "link", 1).stderr, /Conflict, not changed:/)
  assert.equal(readFileSync(join(f.installed, "file"), "utf8"), "keep file")
  assert.ok(lstatSync(join(f.installed, "directory")).isDirectory())
  assert.equal(readlinkSync(join(f.installed, "foreign")), outside)
  assert.equal(readlinkSync(join(f.installed, "broken")), `${outside}/missing`)
  assert.equal(readlinkSync(join(f.installed, "z-new")), join(f.mods, "z-new"))
  run(f, "unlink")
  assert.equal(readlinkSync(join(f.installed, "foreign")), outside)
  assert.equal(readlinkSync(join(f.installed, "broken")), `${outside}/missing`)
  assertMissing(join(f.installed, "z-new"))
})

test("unlink keeps wrong-name links and relative links to another checkout", (t) => {
  const f = fixture(t)
  const source = addMod(f, "matching")
  const other = join(f.root, "other checkout/mods")
  mkdirSync(other, { recursive: true })
  symlinkSync(source, join(f.installed, "wrong-name"))
  const stored = relative(f.installed, join(other, "matching"))
  symlinkSync(stored, join(f.installed, "matching"))
  run(f, "link", 1)
  run(f, "unlink")
  assert.equal(readlinkSync(join(f.installed, "wrong-name")), source)
  assert.equal(readlinkSync(join(f.installed, "matching")), stored)
})

test("relative paths use the physical link directory when the profile is an alias", (t) => {
  const f = fixture(t)
  const source = addMod(f, "matching")
  const physical = join(f.root, "profile elsewhere/mods")
  mkdirSync(physical, { recursive: true })
  rmSync(f.installed, { recursive: true })
  symlinkSync(physical, f.installed)
  const stored = relative(physical, source)
  symlinkSync(stored, join(physical, "matching"))
  run(f, "link")
  run(f, "unlink")
  assertMissing(join(physical, "matching"))
  assert.ok(existsSync(source))
})

test("parent symlinks are resolved before dot-dot; foreign links are kept", (t) => {
  const f = fixture(t)
  addMod(f, "matching")
  const outside = join(f.root, "outside")
  mkdirSync(join(outside, "child"), { recursive: true })
  symlinkSync(join(outside, "child"), join(f.mods, "alias"))
  const stored = `${f.mods}/alias/../matching`
  const target = join(f.installed, "matching")
  symlinkSync(stored, target)
  run(f, "link", 1)
  run(f, "unlink")
  assert.equal(readlinkSync(target), stored)
})

test("source symlinks do not make external destination links belong to this checkout", (t) => {
  const f = fixture(t)
  const outside = join(f.root, "outside")
  mkdirSync(join(outside, "matching"), { recursive: true })
  symlinkSync(join(outside, "matching"), join(f.mods, "matching"))
  const target = join(f.installed, "matching")
  symlinkSync(join(outside, "matching"), target)
  run(f, "link", 1)
  run(f, "unlink")
  assert.equal(readlinkSync(target), join(outside, "matching"))
  rmSync(target)
  symlinkSync(relative(f.installed, join(f.mods, "matching")), target)
  run(f, "link")
  run(f, "unlink")
  assertMissing(target)
  assert.ok(lstatSync(join(f.mods, "matching")).isSymbolicLink())
  assert.ok(existsSync(join(outside, "matching")))
  rmSync(join(outside, "matching"), { recursive: true })
  symlinkSync(relative(f.installed, join(f.mods, "matching")), target)
  run(f, "unlink")
  assertMissing(target)
  assert.ok(lstatSync(join(f.mods, "matching")).isSymbolicLink())
})

test("unlink does not create a missing profile directory", (t) => {
  const f = fixture(t)
  rmSync(f.home, { recursive: true })
  run(f, "unlink")
  assertMissing(f.home)
})

test("README shows setup and later cleanup in separate shell blocks", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
  const section = readme.split("## Link local mods\n")[1].split("\n## ")[0]
  const commands = [...section.matchAll(/```sh\n([^`]+)```/g)].map((match) => match[1].trim())
  assert.deepEqual(commands, ["./scripts/link-mods.sh", "./scripts/unlink-mods.sh"])
})
