import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function check(path) {
  const result = spawnSync("herdr-app", ["check", path], { stdio: "inherit", timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native check failed: ${path}`)
}

check(".")
const temporary = mkdtempSync(join(tmpdir(), "herdr-manager-views-"))
try {
  for (const name of ["manager.js", "runtime.js", "mod.json"]) {
    copyFileSync(name, join(temporary, name))
  }
  copyFileSync("main.js", join(temporary, "manager-ui.js"))
  for (const section of ["installed", "github", "gallery"]) {
    // Fixture data belongs only to this temporary native-render test, never to the live manager.
    writeFileSync(
      join(temporary, "main.js"),
      `import ModManager from "./manager-ui.js"
export default class CheckedView extends ModManager {
  section = ${JSON.stringify(section)}
  init(props, cx) {
    super.init(props, cx)
    this.mods = [
      {id: "native-check", name: "Native check", description: "Render fixture", repository: "test/native-check", version: "1.0", source: "github", icon: "package", managed: true, problem: ""},
      {id: "development-check", name: "Development check", description: "Read-only render fixture", repository: "Development link", version: "", source: "development", icon: "terminal", managed: false, problem: "Read-only check"}
    ]
    this.loading = false
    this.notice = "Native render check"
  }
}
`,
    )
    check(temporary)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
