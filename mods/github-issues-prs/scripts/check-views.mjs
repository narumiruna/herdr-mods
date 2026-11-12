import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Eager native descriptions, not physical interaction or preview evidence.
// Overridden refresh uses only fixture data: no CLI, account, or network access.
const directory = mkdtempSync(join(tmpdir(), "herdr-github-views-"))
const profile = join(directory, "profile")
const cases = ["empty", "list", "many", "issue", "pr", "loading", "error", "detail-error", "tabs"]
try {
  mkdirSync(profile)
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["github.js", "github.js"],
    ["tabs.js", "tabs.js"],
    ["mod.json", "mod.json"],
  ]) {
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  }
  cpSync(new URL("../icons", import.meta.url), join(directory, "icons"), { recursive: true })
  for (const state of cases) {
    writeFileSync(
      join(directory, "main.js"),
      `import GitHub from "./view.js"
const state = ${JSON.stringify(state)}
const item = {number: 1, title: "Check repository access and keyboard navigation", url: "https://github.com/example/project/issues/1", state: "OPEN", author: {login: "example"}, updatedAt: "2026-01-01T00:00:00Z", labels: [{name: "bug"}]}
export default class extends GitHub {
  init(_props, cx) { super.init(state === "tabs" ? {tabs: true} : {}, cx) }
  refresh() {
    this.pinned = true
    this.pinnedMachine = null
    this.repository = "example/project"
    this.loadedContext = this.context()
    this.notice = ""
    this.loading = state === "loading"
    this.phase = "Loading fixture data…"
    this.errorRecovery = state === "error" ? "GitHub CLI: gh on this machine.\\nFor authentication, run: gh auth login on this machine." : ""
    this.error = state === "error" ? "Fixture authentication unavailable.\\n" + this.errorRecovery : ""
    this.items = state === "list" ? [item] : state === "many" ? Array.from({length:100}, (_,i) => ({...item,number:i+1})) : []
    this.resultKey = this.items.length ? "fixture" : null
    if (["issue", "pr", "detail-error"].includes(state)) {
      this.selected = item
      if (state === "detail-error") {
        this.detailRecovery = "GitHub CLI: gh on this machine.\\nFor authentication, run: gh auth login on this machine."
        this.detailError = "Fixture description unavailable.\\n" + this.detailRecovery
      }
      else this.detail = {...item,body:"# Fixture description\\n\\nRead-only repository context.",headRefName:"fix/keyboard",baseRefName:"main",reviewDecision:"REVIEW_REQUIRED",changedFiles:2,additions:12,deletions:3}
      if (state === "pr") this.kind = "pr"
    }
  }
}
`,
    )
    console.log(`Checking eager native description fixture: ${state}`)
    const result = spawnSync("herdr-app", ["check", directory], {
      stdio: "inherit",
      env: { ...process.env, HERDR_APP_HOME: profile },
      timeout: 300_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native fixture check failed: ${state}`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
