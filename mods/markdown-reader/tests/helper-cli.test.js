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
  installed = join(profile, "mods", "markdown-reader")
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
  const requests = join(profile, "data", "markdown-reader", "requests")
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
  const result = cli(["--max-old-space-size=256", join(installed, "helper.mjs"), request])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.length).toBeGreaterThan(8192)
  const manifest = JSON.parse(result.stdout)
  expect(manifest.job).toBe("cli-junction-check")
  expect(manifest.source).toBe(document)
  expect(manifest.blocks.length).toBeGreaterThan(0)
  expect(manifest.blocks.some((block) => block.type === "error")).toBe(false)
  const cancelled = cli([join(installed, "helper.mjs"), "--cancel", request])
  expect(cancelled.status, cancelled.stderr).toBe(0)
  expect(await readFile(`${request}.cancel`, "utf8")).toBe("cancelled")
})

it("reports invalid CLI arguments through an installed junction instead of silently exiting", () => {
  const result = cli([join(installed, "helper.mjs")])
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Usage: node helper.mjs")
})

it("does not run the CLI when the junction module is imported", () => {
  const url = pathToFileURL(join(installed, "helper.mjs")).href
  const result = cli([
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(url)}); process.stdout.write("import-only")`,
  ])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe("import-only")
})
