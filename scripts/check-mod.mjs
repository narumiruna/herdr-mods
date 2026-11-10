import { spawnSync } from "node:child_process"

function check(program, args) {
  const result = spawnSync(program, args, { stdio: "inherit", timeout: 300_000 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Native check failed: ${program} ${args.join(" ")}`)
  }
}

check("herdr-app", ["check", "."])
check(process.execPath, ["scripts/check-views.mjs"])
