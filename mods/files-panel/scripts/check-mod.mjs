import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const profile = mkdtempSync(join(tmpdir(), "herdr-files-panel-check-"))
try {
  const result = spawnSync("herdr-app", ["check", "."], {
    stdio: "inherit",
    env: { ...process.env, HERDR_APP_HOME: profile, HERDR_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    timeout: 300_000,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(profile, { recursive: true, force: true })
}
