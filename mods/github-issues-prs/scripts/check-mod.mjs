import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const profile = mkdtempSync(join(tmpdir(), "herdr-github-base-check-"))
try {
  for (const [program, args] of [
    ["herdr-app", ["check", "."]],
    [process.execPath, ["scripts/check-views.mjs"]],
  ]) {
    const result = spawnSync(program, args, {
      stdio: "inherit",
      env: { ...process.env, HERDR_APP_HOME: profile },
      timeout: 300_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native check failed: ${program} ${args.join(" ")}`)
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
}
