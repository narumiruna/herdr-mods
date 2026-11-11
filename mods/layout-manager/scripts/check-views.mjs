import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Only fixture data is used. No current-profile discovery, network, or layout writes occur.
const directory = mkdtempSync(join(tmpdir(), "herdr-layout-manager-check-"))
const profile = join(directory, "profile")
mkdirSync(profile)
const cases = [
  "personal",
  "managed",
  "missing",
  "shipped",
  "loading",
  "error",
  "empty",
  "many-mods",
  "dock",
  "dock-recovery",
]

try {
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["model.js", "model.js"],
    ["runtime.js", "runtime.js"],
    ["mod.json", "mod.json"],
  ]) {
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  }
  for (const state of cases) {
    writeFileSync(
      join(directory, "main.js"),
      `import LayoutManager from "./view.js"
import { addPanel, managedSlots } from "./model.js"
const state = ${JSON.stringify(state)}
const original = {id: "original", type: "row", titlebar: "none", traffic_lights: [12,16], children: [
  {id:"terminal",type:"block",content:{tab:"active",pane:{header:{content:{mod:"example"}}}}},
  {id:"existing",type:"block",content:{mod:"example",props:{footer:true}}}
]}
const managed = addPanel(original, {name:"example",title:"Example Mod",props:{mode:"list"}})
const example = {name:"example",title:"Example Mod",available:true,manifest:{},shipped:false,error:""}
export default class extends LayoutManager {
  createIO() { return {currentName: () => state === "shipped" ? "main" : "fixture"} }
  currentTree() { return state === "dock-recovery" ? null : managed }
  refresh(cx) {
    this.loadedName = this.io.currentName()
    const tree = ["managed","missing"].includes(state) ? managed : original
    this.snapshot = {name:this.loadedName,path:"/fixture/layouts/fixture.json",tree,raw:JSON.stringify(tree),slots:managedSlots(tree),shipped:state === "shipped"}
    this.mods = state === "missing" ? [{...example,available:false,missing:true,error:"Not installed. Reinstall the same folder name to reuse this panel and its props."}] : [example]
    if (state === "many-mods") this.mods = Array.from({length:140},(_,i)=>({...example,name:"example-"+i,title:"Example Mod "+i}))
    this.loading = state === "loading"
    if (state === "empty") this.mods = []
    if (state === "error") { this.error = "installed.json is invalid. Layout editing is blocked."; this.snapshot = null }
    this.selectMod(this.mods[0]?.name,cx,true)
    this.cloneName.set_value("fixture-personal")
  }
  init(_props,cx) {
    super.init(state.startsWith("dock") ? {mode:"dock"} : {overlay:"fixture"},cx)
    if (state.startsWith("dock") && (this.io || this.search || this.properties)) throw new Error("Dock mode must not initialize discovery or inputs")
  }
}
`,
    )
    console.log(`Checking native fixture: ${state}`)
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
