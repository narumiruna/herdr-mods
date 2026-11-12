import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function check(program, args, env) {
  const result = spawnSync(program, args, {
    stdio: "inherit",
    timeout: 300_000,
    ...(env ? { env } : {}),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Native check failed: ${program} ${args.join(" ")}`)
  }
}

const home = mkdtempSync(join(tmpdir(), "herdr-mod-manager-entry-"))
try {
  check("herdr-app", ["check", "."], { ...process.env, HERDR_APP_HOME: home })
  check(process.execPath, ["scripts/check-views.mjs"])
} finally {
  rmSync(home, { recursive: true, force: true })
}
