import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { checkPNG, inspectBundle } from "./check-bundles.mjs"

// This tiny image is test data only. It is never used as a mod preview.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-bundle-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mod = join(root, "example")
  await mkdir(mod)
  const scripts = Object.fromEntries(
    ["test", "check:mod", "check:views", "check:types"].map((name) => [name, "fixture-command"]),
  )
  for (const [name, text] of Object.entries({
    "main.js": 'import { View } from "gpui-kit"\nexport default class extends View {}\n',
    "mod.json": JSON.stringify({ title: "Example", place: "none" }),
    LICENSE: "Fixture license notice.\n",
    "package.json": JSON.stringify({ name: "example", private: true, scripts }),
    "RECIPE.md":
      "# Example\n![Example preview](preview.png)\n" +
      ["What you see", "How it behaves", "Built from", "Watch out", "Done when"]
        .map((heading) => `## ${heading}\nFixture brief.\n`)
        .join(""),
  }))
    await writeFile(join(mod, name), text)
  await writeFile(join(mod, "preview.png"), png)
  return { root, mod }
}

test("root scripts expose bundle checks and discover every workspace", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.ok(pkg.workspaces.includes("mods/*"))
  assert.equal(pkg.scripts["check:bundles"], "node scripts/check-bundles.mjs")
})

test("accepts a complete structural fixture", async (t) => {
  const { mod } = await fixture(t)
  assert.deepEqual((await inspectBundle(mod)).errors, [])
})

test("reports missing preview and absent workspace checks", async (t) => {
  const { mod } = await fixture(t)
  await rm(join(mod, "preview.png"))
  await writeFile(join(mod, "package.json"), '{"name":"example"}')
  const { errors } = await inspectBundle(mod)
  assert.ok(errors.some((error) => error.includes("preview.png: required file is missing")))
  for (const name of ["test", "check:mod", "check:views", "check:types"])
    assert.ok(errors.some((error) => error.includes(`missing ${name} script`)))
})

test("reports malformed JSON and corrupt previews", async (t) => {
  const { mod } = await fixture(t)
  await writeFile(join(mod, "mod.json"), "{")
  await writeFile(join(mod, "preview.png"), "not an image")
  const { errors } = await inspectBundle(mod)
  assert.ok(errors.some((error) => error.includes("mod.json: invalid JSON")))
  assert.ok(errors.some((error) => error.includes("preview.png: not a PNG")))
})

test("rejects truncated PNG data and invalid compressed image data", () => {
  checkPNG(png)
  assert.throws(() => checkPNG(png.subarray(0, 40)))
  const corrupt = Buffer.from(png)
  corrupt[42] ^= 0xff
  assert.throws(() => checkPNG(corrupt))
})

test("rejects missing and escaping runtime imports and undeclared packages", async (t) => {
  const { mod } = await fixture(t)
  await writeFile(
    join(mod, "main.js"),
    `import "./missing.js"
import "../outside.js"
import { render } from "undeclared"
import("./dynamic.js")
`,
  )
  const { errors } = await inspectBundle(mod)
  for (const text of ["missing.js", "path escapes bundle", "undeclared", "dynamic.js"])
    assert.ok(
      errors.some((error) => error.includes(text)),
      text,
    )
})

test("accepts declared runtime dependencies and ignores development files", async (t) => {
  const { mod } = await fixture(t)
  const pkg = JSON.parse(await readFile(join(mod, "package.json"), "utf8"))
  pkg.dependencies = { "@example/renderer": "1.0.0" }
  await writeFile(join(mod, "package.json"), JSON.stringify(pkg))
  await writeFile(join(mod, "main.js"), 'import { render } from "@example/renderer/native"\n')
  await writeFile(join(mod, "vitest.config.js"), 'import { config } from "dev-only"\n')
  await mkdir(join(mod, "node_modules"))
  await symlink(join(mod, "main.js"), join(mod, "node_modules", "linked"))
  assert.deepEqual((await inspectBundle(mod)).errors, [])
})

test("rejects symbolic links and packaged layouts or nested mods", async (t) => {
  const { root, mod } = await fixture(t)
  await writeFile(join(root, "outside.js"), "export default {}")
  await symlink(join(root, "outside.js"), join(mod, "linked.js"))
  await mkdir(join(mod, "layouts"))
  await mkdir(join(mod, "mods"))
  const { errors } = await inspectBundle(mod)
  assert.ok(errors.some((error) => error.includes("symbolic links")))
  assert.equal(errors.filter((error) => error.includes("nested mod roots")).length, 2)
})

test("rejects escaping recipe links and missing required headings", async (t) => {
  const { mod } = await fixture(t)
  await writeFile(join(mod, "RECIPE.md"), "# Example\n[Outside](../private.md)\n")
  const { errors } = await inspectBundle(mod)
  for (const text of ["path escapes bundle", "missing section", "missing adjacent preview"])
    assert.ok(errors.some((error) => error.includes(text)))
})
