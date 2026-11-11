import { spawnSync } from "node:child_process"

for (const [program, args] of [
  ["herdr-app", ["check", "."]],
  [process.execPath, ["scripts/check-views.mjs"]],
]) {
  const result = spawnSync(program, args, { stdio: "inherit", timeout: 300_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native check failed: ${program} ${args.join(" ")}`)
}
