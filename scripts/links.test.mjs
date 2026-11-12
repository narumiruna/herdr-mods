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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-links-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "checkout with spaces")
  const home = join(root, "home with spaces")
  const mods = join(repo, "mods")
  const layouts = join(repo, "layouts")
  const installed = join(home, ".config/herdr-app/mods")
  const installedLayouts = join(home, ".config/herdr-app/layouts")
  const cwd = join(root, "other working directory")
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true })
  for (const path of [mods, layouts, installed, installedLayouts, cwd]) {
    mkdirSync(path, { recursive: true })
  }
  return { root, repo, home, mods, layouts, installed, installedLayouts, cwd }
}

function run(f, command, status = 0) {
  const result = spawnSync(join(f.repo, "scripts", `${command}.sh`), [], {
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

function addLayout(f, name = "workbench") {
  const layout = join(f.layouts, `${name}.json`)
  const preview = join(f.layouts, `${name}.svg`)
  writeFileSync(layout, `${JSON.stringify({ preview: `layouts/${name}.svg` })}\n`)
  writeFileSync(preview, '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  return { layout, preview }
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
  const { layout } = addLayout(f)
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
  assert.equal(readlinkSync(join(f.installedLayouts, "workbench.json")), layout)
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

test("link discovers layouts and SVG previews without linking other files or directories", (t) => {
  const f = fixture(t)
  const mod = addMod(f, "matching")
  const { layout, preview } = addLayout(f)
  writeFileSync(join(f.layouts, "README.md"), "keep")
  mkdirSync(join(f.layouts, "directory.json"))
  mkdirSync(join(f.layouts, ".state"))
  writeFileSync(join(f.layouts, ".state/workbench.json"), "{}")
  writeFileSync(join(f.layouts, ".hidden.json"), "{}")
  run(f, "link")
  assert.equal(readlinkSync(join(f.installed, "matching")), mod)
  assert.equal(readlinkSync(join(f.installedLayouts, "workbench.json")), layout)
  assert.equal(readlinkSync(join(f.installedLayouts, "workbench.svg")), preview)
  for (const name of ["README.md", "directory.json", ".state", ".hidden.json"]) {
    assertMissing(join(f.installedLayouts, name))
  }
  const linked = JSON.parse(readFileSync(join(f.installedLayouts, "workbench.json"), "utf8"))
  assert.equal(
    readFileSync(join(dirname(f.installedLayouts), linked.preview), "utf8"),
    readFileSync(preview, "utf8"),
  )
  run(f, "link")
  const second = addLayout(f, "second layout")
  run(f, "link")
  assert.equal(readlinkSync(join(f.installedLayouts, "second layout.json")), second.layout)
  assert.equal(readlinkSync(join(f.installedLayouts, "second layout.svg")), second.preview)
  run(f, "unlink")
  run(f, "unlink")
  assertMissing(join(f.installedLayouts, "workbench.json"))
  assertMissing(join(f.installedLayouts, "workbench.svg"))
  assert.ok(existsSync(layout))
  assert.ok(existsSync(preview))
  assert.ok(existsSync(second.layout))
  assert.ok(existsSync(second.preview))
})

for (const extension of ["json", "svg"]) {
  for (const form of ["absolute", "relative", "absolute with dot"]) {
    test(`both scripts recognize a matching ${form} layout ${extension} link`, (t) => {
      const f = fixture(t)
      addLayout(f)
      const source = join(f.layouts, `workbench.${extension}`)
      const target = join(f.installedLayouts, `workbench.${extension}`)
      const stored =
        form === "relative"
          ? relative(f.installedLayouts, source)
          : form === "absolute with dot"
            ? `${f.layouts}/./workbench.${extension}`
            : source
      symlinkSync(stored, target)
      assert.match(run(f, "link").stdout, /Already linked:/)
      assert.equal(readlinkSync(target), stored)
      run(f, "unlink")
      assertMissing(target)
      assert.ok(existsSync(source))
    })
  }
}

for (const missingParent of [false, true]) {
  test(`unlink removes broken layout and preview links; missing parent: ${missingParent}`, (t) => {
    const f = fixture(t)
    const { layout, preview } = addLayout(f)
    const target = join(f.installedLayouts, "workbench.json")
    const previewTarget = join(f.installedLayouts, "workbench.svg")
    symlinkSync(layout, target)
    symlinkSync(relative(f.installedLayouts, preview), previewTarget)
    if (missingParent) {
      rmSync(f.layouts, { recursive: true })
    } else {
      rmSync(layout)
      rmSync(preview)
    }
    run(f, "unlink")
    assertMissing(target)
    assertMissing(previewTarget)
  })
}

test("layout conflicts stay unchanged while other mods, layouts, and previews are linked", (t) => {
  const f = fixture(t)
  const mod = addMod(f, "matching")
  const outside = join(f.root, "outside.json")
  writeFileSync(outside, "{}")
  for (const name of ["file", "directory", "foreign", "broken", "z-new"]) addLayout(f, name)
  writeFileSync(join(f.installedLayouts, "file.json"), "keep file")
  mkdirSync(join(f.installedLayouts, "directory.json"))
  symlinkSync(outside, join(f.installedLayouts, "foreign.json"))
  symlinkSync(`${outside}.missing`, join(f.installedLayouts, "broken.json"))
  assert.match(run(f, "link", 1).stderr, /Conflict, not changed:/)
  assert.equal(readFileSync(join(f.installedLayouts, "file.json"), "utf8"), "keep file")
  assert.ok(lstatSync(join(f.installedLayouts, "directory.json")).isDirectory())
  assert.equal(readlinkSync(join(f.installedLayouts, "foreign.json")), outside)
  assert.equal(readlinkSync(join(f.installedLayouts, "broken.json")), `${outside}.missing`)
  assert.equal(readlinkSync(join(f.installed, "matching")), mod)
  assert.equal(readlinkSync(join(f.installedLayouts, "z-new.json")), join(f.layouts, "z-new.json"))
  assert.equal(readlinkSync(join(f.installedLayouts, "file.svg")), join(f.layouts, "file.svg"))
  run(f, "unlink")
  assert.equal(readFileSync(join(f.installedLayouts, "file.json"), "utf8"), "keep file")
  assert.ok(lstatSync(join(f.installedLayouts, "directory.json")).isDirectory())
  assert.equal(readlinkSync(join(f.installedLayouts, "foreign.json")), outside)
  assert.equal(readlinkSync(join(f.installedLayouts, "broken.json")), `${outside}.missing`)
  assertMissing(join(f.installedLayouts, "z-new.json"))
  assertMissing(join(f.installedLayouts, "file.svg"))
})

test("unlink keeps wrong-name layouts, foreign layout links, and unsupported files", (t) => {
  const f = fixture(t)
  const { layout } = addLayout(f)
  const other = join(f.root, "other checkout/layouts")
  mkdirSync(other, { recursive: true })
  symlinkSync(layout, join(f.installedLayouts, "wrong-name.json"))
  const stored = relative(f.installedLayouts, join(other, "workbench.json"))
  symlinkSync(stored, join(f.installedLayouts, "workbench.json"))
  writeFileSync(join(f.layouts, "README.md"), "keep")
  symlinkSync(join(f.layouts, "README.md"), join(f.installedLayouts, "README.md"))
  run(f, "link", 1)
  run(f, "unlink")
  assert.equal(readlinkSync(join(f.installedLayouts, "wrong-name.json")), layout)
  assert.equal(readlinkSync(join(f.installedLayouts, "workbench.json")), stored)
  assert.equal(readlinkSync(join(f.installedLayouts, "README.md")), join(f.layouts, "README.md"))
})

test("layout relative links use the physical directory when the profile is an alias", (t) => {
  const f = fixture(t)
  const { layout } = addLayout(f)
  const physical = join(f.root, "profile elsewhere/layouts")
  mkdirSync(physical, { recursive: true })
  rmSync(f.installedLayouts, { recursive: true })
  symlinkSync(physical, f.installedLayouts)
  symlinkSync(relative(physical, layout), join(physical, "workbench.json"))
  run(f, "link")
  run(f, "unlink")
  assertMissing(join(physical, "workbench.json"))
  assert.ok(existsSync(layout))
})

test("unlink removes matching broken links when the layouts parent is a dangling symlink", (t) => {
  const f = fixture(t)
  const outside = join(f.root, "external layouts")
  mkdirSync(outside)
  rmSync(f.layouts, { recursive: true })
  symlinkSync(outside, f.layouts)
  addLayout(f)
  run(f, "link")
  const previewTarget = join(f.installedLayouts, "workbench.svg")
  rmSync(previewTarget)
  symlinkSync(relative(f.installedLayouts, join(f.layouts, "workbench.svg")), previewTarget)
  rmSync(outside, { recursive: true })
  run(f, "unlink")
  assertMissing(join(f.installedLayouts, "workbench.json"))
  assertMissing(previewTarget)
  assert.ok(lstatSync(f.layouts).isSymbolicLink())
})

test("scripts permit missing source directories and create only destination directories", (t) => {
  const f = fixture(t)
  rmSync(f.mods, { recursive: true })
  rmSync(f.layouts, { recursive: true })
  rmSync(f.home, { recursive: true })
  run(f, "link")
  assert.ok(lstatSync(f.installed).isDirectory())
  assert.ok(lstatSync(f.installedLayouts).isDirectory())
  assertMissing(f.mods)
  assertMissing(f.layouts)
  run(f, "unlink")
})

test("README shows setup and later cleanup in separate shell blocks", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
  const section = readme.split("## Link local mods and layouts\n")[1].split("\n## ")[0]
  const commands = [...section.matchAll(/```sh\n([^`]+)```/g)].map((match) => match[1].trim())
  assert.deepEqual(commands, ["./scripts/link.sh", "./scripts/unlink.sh"])
})
