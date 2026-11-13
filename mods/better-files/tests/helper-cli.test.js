import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"

const source = fileURLToPath(new URL("..", import.meta.url))
let temporary
let installed
let profile

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "reader-cli-junction-")))
  profile = join(temporary, "profile")
  installed = join(profile, "mods", "better-files")
  await mkdir(join(profile, "mods"), { recursive: true })
  // A directory junction works without file-symlink privileges on Windows.
  await symlink(source, installed, "junction")
})

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

function cli(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: temporary,
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  return result
}

it("executes the helper through an installed junction and returns complete JSON", async () => {
  const root = join(temporary, "workspace with spaces")
  const requests = join(profile, "data", "better-files", "requests")
  await mkdir(root)
  await mkdir(requests, { recursive: true })
  const file = join(root, "中文 guide.MD")
  const request = join(requests, "cli-junction-check.json")
  const document =
    "# Direct opening\n\n" +
    Array.from(
      { length: 200 },
      (_, i) => `Paragraph ${i}: local Markdown opens in the same pane.\n\n`,
    ).join("")
  await writeFile(file, document)
  await writeFile(request, JSON.stringify({ appHome: profile, root, file, on: null, width: 720 }))
  const result = cli(["--max-old-space-size=256", join(installed, "reader", "helper.mjs"), request])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.length).toBeGreaterThan(8192)
  const manifest = JSON.parse(result.stdout)
  expect(manifest.job).toBe("cli-junction-check")
  expect(manifest.source).toBe(document)
  expect(manifest.blocks.length).toBeGreaterThan(0)
  expect(manifest.blocks.some((block) => block.type === "error")).toBe(false)
  const cancelled = cli([join(installed, "reader", "helper.mjs"), "--cancel", request])
  expect(cancelled.status, cancelled.stderr).toBe(0)
  expect(await readFile(`${request}.cancel`, "utf8")).toBe("cancelled")
})

async function denyImports(args, specifiers) {
  const loader = join(temporary, "deny-imports.mjs")
  await writeFile(
    loader,
    `
    import { registerHooks } from "node:module"
    const blocked = ${JSON.stringify(specifiers)}
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (blocked.includes(specifier)) throw new Error("Unexpected import: " + specifier)
      return nextResolve(specifier, context)
    } })
  `,
  )
  return cli(["--import", pathToFileURL(loader).href, ...args])
}

async function fixture(source) {
  const root = join(temporary, "workspace")
  const directory = join(profile, "data", "better-files", "requests")
  await mkdir(root)
  await mkdir(directory, { recursive: true })
  const file = join(root, "document.md")
  const request = join(directory, "lazy-import-check.json")
  await writeFile(file, source)
  await writeFile(request, JSON.stringify({ appHome: profile, root, file, on: null }))
  return request
}

const rendererImports = ["./renderers/index.js", "./mermaid.js", "puppeteer"]

it("imports and cancels through a junction without loading the parser or renderers", async () => {
  const helper = join(installed, "reader", "helper.mjs")
  const request = await fixture("# Plain")
  const denied = ["./document.js", ...rendererImports]
  const imported = await denyImports(
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(helper).href)}); process.stdout.write("light")`,
    ],
    denied,
  )
  expect(imported.status, imported.stderr).toBe(0)
  expect(imported.stdout).toBe("light")
  const cancelled = await denyImports([helper, "--cancel", request], denied)
  expect(cancelled.status, cancelled.stderr).toBe(0)
  expect(await readFile(`${request}.cancel`, "utf8")).toBe("cancelled")
  const stopped = await denyImports([helper, request], denied)
  expect(stopped.status).toBe(1)
  expect(stopped.stderr).toContain("Reading cancelled")
  expect(stopped.stderr).not.toContain("Unexpected import")
})

it("loads no renderers for plain documents or all-cache documents", async () => {
  const helper = join(installed, "reader", "helper.mjs")
  const request = await fixture("# Plain\n\n```js\nconst x = 1\n```\n")
  const plain = await denyImports([helper, request], rendererImports)
  expect(plain.status, plain.stderr).toBe(0)
  expect(JSON.parse(plain.stdout).blocks.some((block) => block.type === "error")).toBe(false)
  const file = join(temporary, "workspace", "document.md")
  await writeFile(file, "$$\nx^2\n$$\n")
  // Math needs a worker, but never imports Mermaid or Puppeteer.
  const cold = await denyImports([helper, request], ["./mermaid.js", "puppeteer"])
  expect(cold.status, cold.stderr).toBe(0)
  const rendered = JSON.parse(cold.stdout)
  expect(rendered.blocks[0].type).toBe("graphic")
  const warm = await denyImports([helper, request], rendererImports)
  expect(warm.status, warm.stderr).toBe(0)
  expect(JSON.parse(warm.stdout).blocks).toEqual(rendered.blocks)
})

it("does not import Mermaid or Puppeteer for an unused renderer batch", async () => {
  const entry = pathToFileURL(join(installed, "reader", "renderers", "index.js")).href
  const result = await denyImports(
    [
      "--input-type=module",
      "-e",
      `const { Renderers } = await import(${JSON.stringify(entry)}); await new Renderers().close()`,
    ],
    ["./mermaid.js", "puppeteer"],
  )
  expect(result.status, result.stderr).toBe(0)
})

it("reports invalid CLI arguments through an installed junction instead of silently exiting", () => {
  const result = cli([join(installed, "reader", "helper.mjs")])
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Usage: node helper.mjs")
})

it("does not run the CLI when the junction module is imported", () => {
  const url = pathToFileURL(join(installed, "reader", "helper.mjs")).href
  const result = cli([
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(url)}); process.stdout.write("import-only")`,
  ])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe("import-only")
})
