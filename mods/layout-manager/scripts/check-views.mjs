import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Eager module/description checks only; these do not test the host layout parser,
// layout geometry, paint, or physical event dispatch. Only fixture data is used.
const directory = mkdtempSync(join(tmpdir(), "herdr-layout-manager-check-"))
const profile = join(directory, "profile")
const cases = [
  "personal",
  "managed",
  "managed-left",
  "managed-top",
  "managed-bottom",
  "drag-mod",
  "drag-dock",
  "drag-reorder",
  "drag-remove",
  "missing",
  "shipped",
  "loading",
  "error",
  "empty",
  "many-mods",
  "props-draft",
  "close-drafts",
  "undo-ready",
  "ordinary-deep",
  "ordinary-small",
  "ordinary-hidden",
  "ordinary-container-selected",
  "ordinary-drag-left",
  "ordinary-drag-right",
  "ordinary-drag-top",
  "ordinary-drag-bottom",
  "ordinary-drag-container",
  "ordinary-drag-new",
  "ordinary-stack-inactive",
  "ordinary-root-wrapped",
  "ordinary-legacy-coexistence",
  "ordinary-empty-containers",
  "ordinary-keyboard-placement",
  "ordinary-keyboard-new-view",
  "dock",
  "dock-recovery",
]

try {
  mkdirSync(profile)
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["model.js", "model.js"],
    ["tree.js", "tree.js"],
    ["runtime.js", "runtime.js"],
    ["mod.json", "mod.json"],
  ]) {
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  }
  for (const state of cases) {
    writeFileSync(
      join(directory, "main.js"),
      `import LayoutManager from "./view.js"
import { addPanel, managedSlots, moveDock } from "./model.js"
import { placeNode } from "./tree.js"
const state = ${JSON.stringify(state)}
const original = {id: "original", type: "row", titlebar: "none", traffic_lights: [12,16], children: [
  {id:"terminal",type:"block",content:{tab:"active",pane:{header:{content:{mod:"example"}}}}},
  {id:"existing",type:"block",content:{mod:"example",props:{footer:true}}}
]}
let deep = {id:"deep-leaf",type:"block",content:{mod:"unavailable",props:{opaque:{keep:true}}}}
for (let depth = 0; depth < 7; depth++) deep = {id:"deep-"+depth,type:depth % 2 ? "row" : "column",children:[deep]}
const detailed = {...original,children:[...original.children,
  {id:"group",type:"column",size:{px:240},min:80,max:480,resizable:false,children:[
    {id:"small",type:"block",size:{px:8},content:{mod:"example",props:{small:true}}},
    {id:"hidden",type:"block",hidden:true,content:{mod:"unavailable"}},
    deep
  ]},
  {id:"tabs",type:"stack",active:"stack-active",header:{content:{mod:"example"}},children:[
    {id:"stack-active",type:"block",content:{mod:"example"}},
    {id:"stack-inactive",type:"block",content:{mod:"unavailable",props:{inactive:true}}}
  ]}
]}
const managed = addPanel(addPanel(original, {name:"example",title:"Example Mod",props:{mode:"list"}}), {name:"saved",title:"Saved Mod",props:{keep:true}})
const example = {name:"example",title:"Example Mod",available:true,manifest:{},shipped:false,error:""}
export default class extends LayoutManager {
  createIO() { return {currentName: () => state === "shipped" ? "main" : "fixture"} }
  currentTree() { return state === "dock-recovery" ? null : managed }
  refresh(cx) {
    this.loadedName = this.io.currentName()
    let tree = state.startsWith("managed") || state.startsWith("drag") || state === "missing" ? managed : original
    if (state.startsWith("managed-")) tree = moveDock(tree,state.slice("managed-".length))
    if (state === "undo-ready") tree = placeNode(original,{kind:"new",name:"example"},"existing","bottom")
    if (state.startsWith("ordinary-")) tree = detailed
    if (state === "ordinary-root-wrapped") tree = placeNode(original,{kind:"new",name:"example",props:{root:true}},"original","top")
    if (state === "ordinary-legacy-coexistence") tree = placeNode(managed,{kind:"new",name:"example",props:{ordinary:true}},"existing","bottom")
    if (state === "ordinary-empty-containers") tree = {...detailed,children:[...detailed.children,
      {id:"empty-row",type:"row",children:[]},
      {id:"empty-column",type:"column",children:[]},
      {id:"empty-stack",type:"stack",children:[]}
    ]}
    this.snapshot = {name:this.loadedName,path:"/fixture/layouts/fixture.json",tree,raw:JSON.stringify(tree),slots:managedSlots(tree),shipped:state === "shipped"}
    if (state === "undo-ready") this.undo = {before:{...this.snapshot,tree:original,raw:JSON.stringify(original),slots:[]},after:this.snapshot}
    this.mods = state === "missing" ? [{...example,available:false,missing:true,error:"Not installed. Reinstall the same folder name to reuse this panel and its props."}] : [example]
    if (state === "many-mods") this.mods = Array.from({length:140},(_,i)=>({...example,name:"example-"+i,title:"Example Mod "+i}))
    this.loading = state === "loading"
    if (state === "empty") this.mods = []
    if (state === "error") { this.error = "installed.json is invalid. Layout editing is blocked."; this.snapshot = null }
    this.layoutDrafts.set(this.loadedName,this.drafts)
    this.selectMod(this.mods[0]?.name,cx,true)
    if (state === "props-draft" || state === "close-drafts") {
      this.properties.set_value('{"unsaved":"example"}')
      this.keepDraft()
      this.confirmClose = state === "close-drafts"
    }
    this.reconcileNodes?.()
    if (state === "ordinary-deep") this.selectNodeSource("deep-leaf",cx)
    if (state === "ordinary-small") this.selectNodeSource("small",cx)
    if (state === "ordinary-hidden") this.selectNodeSource("hidden",cx)
    if (state === "ordinary-container-selected") this.selectNodeSource("group",cx)
    if (state === "ordinary-stack-inactive") {
      this.selectNodeSource("stack-inactive",cx)
      this.selectNodeTarget("stack-active",cx)
    }
    if (state.startsWith("ordinary-drag-")) {
      const side = ["left","right","top","bottom"].includes(state.slice("ordinary-drag-".length)) ? state.slice("ordinary-drag-".length) : "bottom"
      const source = state === "ordinary-drag-new" ? {kind:"new",name:"example"} : {kind:"node",id:state === "ordinary-drag-container" ? "group" : "existing"}
      if (source.kind === "new") this.selectNewView(source.name,cx)
      else this.selectNodeSource(source.id,cx)
      this.selectNodeTarget("terminal",cx)
      this.drag = {...source,origin:{x:0,y:0},active:true}
      this.dropTarget = "node-"+JSON.stringify(["terminal",side])
      this.dropPlacement = {id:"terminal",side}
    }
    if (state === "ordinary-keyboard-placement") {
      this.selectNodeSource("existing",cx)
      this.selectNodeTarget("terminal",cx)
    }
    if (state === "ordinary-keyboard-new-view") {
      this.selectNewView("example",cx)
      this.properties.set_value('{"fixture":"new-view"}')
      this.selectNodeTarget("stack-inactive",cx)
    }
    if (state === "ordinary-root-wrapped" || state === "ordinary-legacy-coexistence") {
      this.selectNodeSource("existing",cx)
      this.selectNodeTarget("terminal",cx)
    }
    if (state.startsWith("drag")) {
      this.drag = {kind:state === "drag-dock" ? "dock" : "mod",name:"example",origin:{x:0,y:0},active:true}
      this.dropTarget = state === "drag-reorder" ? "tab-saved" : state === "drag-remove" ? "remove" : "edge-left"
    }
    this.cloneName.set_value("fixture-personal")
  }
  init(_props,cx) {
    super.init(state.startsWith("dock") ? {mode:"dock"} : {overlay:"fixture"},cx)
    if (state.startsWith("dock") && (this.io || this.search || this.properties)) throw new Error("Dock mode must not initialize discovery or inputs")
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
