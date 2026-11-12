import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "herdr-markdown-reader-entry-"))
try {
  for (const [program, args] of [
    ["herdr-app", ["check", "."]],
    [process.execPath, ["scripts/check-views.mjs"]],
  ]) {
    const result = spawnSync(program, args, {
      stdio: "inherit",
      timeout: 300000,
      env: { ...process.env, HERDR_APP_HOME: home },
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native check failed: ${program} ${args.join(" ")}`)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
