import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const states = [
  "empty",
  "mixed",
  "idle",
  "blocked",
  "done",
  "missing-icon",
  "overflow",
  "narrow",
  "overflow-narrow",
  "rail",
  "worktree",
  "worktree-narrow",
  "machines",
]

// Only disposable fixture copies override data. Production row builders and
// activity grouping remain unchanged. No real Git, machine, or agent command runs.
export function prepareFixture(directory, state) {
  if (!states.includes(state)) throw new Error(`Unknown fixture state: ${state}`)
  mkdirSync(directory, { recursive: true })
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["activity.js", "activity.js"],
    ["mod.json", "mod.json"],
  ])
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  cpSync(new URL("../icons", import.meta.url), join(directory, "icons"), { recursive: true })
  writeFileSync(
    join(directory, "main.js"),
    `import Spaces from "./view.js"
import { groupAgents } from "./activity.js"
const state = ${JSON.stringify(state)}
const space = (id, name, active = false, machine = null) => ({id, name, active, machine, folder: "", tabs: [], status: null})
const list = state === "empty" ? [] : [
  space("s1", "herdr-mods", true),
  space("s2", "obsidian-ai"),
  space("s3", "pi-extensions"),
  space("s4", "work-log"),
]
if (state.includes("narrow") || state === "overflow") list[0].name = "a-very-long-space-name-that-must-not-cover-the-count"
if (state === "machines") list.push(space("remote/s1", "herdr-mods", false, "remote"))
const pi = {key:"pi",name:"Pi",icon:"icons/pi.svg",tint:true,agent:true}
const claude = {key:"claude",name:"Claude Code",icon:"icons/claude.svg",tint:false,agent:true}
const codex = {key:"codex",name:"Codex",icon:"icons/codex.svg",tint:false,agent:true}
const agent = (address, space, status, program = pi) => ({address, space, status, program})
let agents = [
  agent("t1", "s1", "working"),
  agent("t2", "s1", "working", claude),
  agent("t3", "s1", "idle", codex),
  agent("t4", "s2", "idle"),
  agent("t5", "s3", "working"),
  agent("t6", "s3", "idle"),
]
if (state === "idle") agents = agents.map(a => ({...a,status:"idle"}))
if (state === "blocked" || state === "done") agents = agents.map(a => ({...a,status:state}))
if (state === "missing-icon") agents = agents.map(a => ({...a,program:{...a.program,icon:null}}))
if (state.startsWith("overflow")) agents.push(...Array.from({length:9},(_,i)=>agent("extra"+i,"s1",i%2?"idle":"working")))
if (state === "machines") agents.push(agent("remote/t1","remote/s1","idle",claude))
export default class extends Spaces {
  refreshMachines() { this.machines = state === "machines" ? [{name:"remote",state:"connected"}] : [] }
  checkNew() {}
  activities() { return groupAgents(agents) }
  ordered() {
    return list.map((w,i) => ({
      w, i,
      tree: state.startsWith("worktree") && i === 1 ? "└─" : null,
      g: state.startsWith("worktree") ? {name:"herdr-mods",branch:i===1?"feature/sidebar":"main",ahead:2,behind:1} : null,
    }))
  }
  grouped(t, collapsed) {
    return super.grouped(t, collapsed || state === "rail")
  }
  render() {
    return super.render().w(state.includes("narrow") ? 160 : state === "rail" ? 44 : 268).h(330)
  }
}
`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const temporary = mkdtempSync(join(tmpdir(), "herdr-spaces-agent-status-views-"))
  try {
    const profile = join(temporary, "profile")
    mkdirSync(profile)
    for (const state of states) {
      const directory = join(temporary, state)
      prepareFixture(directory, state)
      console.log(`Checking eager native description fixture: ${state}`)
      const result = spawnSync("herdr-app", ["check", directory], {
        stdio: "inherit",
        env: { ...process.env, HERDR_APP_HOME: profile, HERDR_TELEMETRY: "0", DO_NOT_TRACK: "1" },
        timeout: 300_000,
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`Native fixture check failed: ${state}`)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
