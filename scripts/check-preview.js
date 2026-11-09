import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Exercise later view states without adding runtime test flags or touching mods.
const cases = [
  ["gallery", 'this.section = "gallery"'],
  ["installed", 'this.section = "installed"'],
  ["github", 'this.section = "github"'],
  ["confirmation", 'this.session.requestUninstall("focus-mode")'],
  [
    "pending",
    'this.session.start("install", "terminal-tools"); this.notice = "Simulating installation…"',
  ],
  ["error", 'this.reportError(new Error("Sample operation interrupted. Try again."))'],
  ["empty-search", 'this.queries.gallery = "no-such-sample"'],
]
const directory = mkdtempSync(join(tmpdir(), "herdr-mod-manager-check-"))

try {
  for (const [source, target] of [
    ["main.js", "manager.js"],
    ["preview.js", "preview.js"],
    ["mod.json", "mod.json"],
  ]) {
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  }
  for (const [name, setup] of cases) {
    writeFileSync(
      join(directory, "main.js"),
      `import ModManager from "./manager.js"
export default class extends ModManager {
  init() {
    super.init()
    ${setup}
  }
}
`,
    )
    console.log(`Checking preview: ${name}`)
    const result = spawnSync("herdr-app", ["check", directory], {
      stdio: "inherit",
      timeout: 300_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native check failed: ${name}`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
