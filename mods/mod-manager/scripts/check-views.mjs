import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Native checks execute trusted code in a temporary copy. The runtime adapter
// fails closed, and the injected session cannot fetch or mutate user files.
const cases = [
  ["gallery", 'this.section = "gallery"'],
  ["installed", 'this.section = "installed"'],
  ["github", 'this.section = "github"'],
  [
    "github-subdirectory",
    'this.section = "github"; this.repository.set_value("https://github.com/example/collection"); this.directory.set_value("mods/focus-mode")',
  ],
  [
    "loading",
    'this.session.mods = []; this.session.galleryStatus = "loading"; this.session.discoveryStatus = "loading"',
  ],
  [
    "error",
    'this.session.mods = []; this.session.galleryStatus = "error"; this.session.galleryError = "Fixture Gallery unavailable. Refresh to retry."',
  ],
  [
    "discovery-error",
    'this.session.discoveryStatus = "error"; this.session.discoveryError = "Fixture inventory unavailable. File operations are blocked."',
  ],
  ["empty-search", 'this.queries.gallery = "no-such-fixture"'],
  ["confirmation", 'this.session.requestUninstall("mods:example/focus-mode//focus-mode")'],
  [
    "pending",
    'this.session.pending = {id: "mods:example/terminal-tools//terminal-tools", action: "install"}',
  ],
  ["protected", 'this.section = "installed"; this.sources.installed = "development"'],
  ["migration", "this.session.migration = migration"],
  ["migration-confirmation", "this.session.migration = migration; this.session.requestMigration()"],
  [
    "migration-blocked",
    'this.session.migration = {...migration, blocked: true, reason: "Fixture recovery evidence: /fixture/recovery. No changes are allowed."}',
  ],
  [
    "git-confirmation",
    'this.session.mods = this.session.mods.map(mod => mod.modName === "focus-mode" ? {...mod, kind: "git", archivePath: "/fixture/herdr/data/mod-manager/archives/focus-mode"} : mod); this.session.requestUninstall("mods:example/focus-mode//focus-mode")',
  ],
  ["update", 'this.queries.gallery = "Focus Mode"'],
  [
    "update-error",
    'this.session.updateErrors["mods:example/focus-mode//focus-mode"] = "Fixture update lookup failed."',
  ],
  ...[268, 76].flatMap((width) =>
    [false, true].map((ready) => [
      `footer-${width}-${ready ? "update" : "current"}`,
      'if (this.session || this.searches || this.repository || this.directory || this.loadStarted) throw new Error("Footer initialized manager state")',
      { width, ready },
    ]),
  ),
]

const fixture = `import { ManagerSession } from "./manager.js"
export const migration = { required: true, blocked: false, token: "a".repeat(64), targets: [{id: "focus-mode", path: "/fixture/herdr/mods/focus-mode", repository: "example/focus-mode", kind: "package"}] }
const commit = "a".repeat(40)
const installed = {
  id: "mods:example/focus-mode//focus-mode", name: "Focus Mode",
  description: "Keep the current workspace in focus.", version: "1.0.0",
  repository: "example/focus-mode", recipePath: "", modName: "focus-mode",
  source: "github", icon: "focus", managed: true,
  path: "/fixture/herdr/mods/focus-mode", commit, identityToken: "fixture-verified-target",
  state: "installed", gallery: true, updateCommit: "b".repeat(40),
}
const available = {
  ...installed, id: "mods:example/terminal-tools//terminal-tools", name: "Terminal Tools",
  description: "Community terminal commands.", version: "", repository: "example/terminal-tools",
  modName: "terminal-tools", icon: "terminal", managed: false, path: "", state: "available",
  identityToken: undefined, updateCommit: undefined,
}
const protectedMod = {
  ...installed, id: "local:mod-manager", name: "Mod Manager", description: "The running manager.",
  repository: "", modName: "mod-manager", source: "development", managed: false,
  path: "/fixture/herdr/mods/mod-manager", gallery: false, updateCommit: undefined,
  protectedReason: "Running manager: protected development link.",
}
export function fixtureSession() {
  const session = new ManagerSession({
    fetchGallery: async () => { throw new Error("Native fixture must not fetch metadata") },
    discover: async () => { throw new Error("Native fixture must not discover user files") },
    operate: async () => { throw new Error("Native fixture must not mutate files") },
  })
  // Seed a trusted snapshot so check's first synchronous render covers this state.
  // Handler tests separately exercise parsing and lifecycle readback through I/O.
  session.mods = Object.freeze([installed, available, protectedMod].map(Object.freeze))
  session.galleryStatus = "ready"
  session.discoveryStatus = "ready"
  session.load = async () => {}
  return session
}
`
const directory = mkdtempSync(join(tmpdir(), "herdr-mod-manager-check-"))
const profile = join(directory, "profile")
mkdirSync(profile)
try {
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["manager.js", "manager.js"],
    ["mod.json", "mod.json"],
  ]) {
    copyFileSync(new URL(`../${source}`, import.meta.url), join(directory, target))
  }
  writeFileSync(
    join(directory, "runtime.js"),
    'export function createIO() { throw new Error("Live runtime is forbidden in native fixture checks") }\n',
  )
  writeFileSync(join(directory, "fixture.js"), fixture)
  // Stub only live layout/update snapshots in the temporary source copy.
  // Theme, commands, elements, and the entry lifecycle still use the real SDK.
  const sidebar = readFileSync(new URL("../sidebar.js", import.meta.url), "utf8")
  const stubbedSidebar = sidebar.replace('from "herdr"', 'from "./sidebar-host.js"')
  if (stubbedSidebar === sidebar) throw new Error("Sidebar host import was not replaced")
  writeFileSync(join(directory, "sidebar.js"), stubbedSidebar)
  for (const [name, setup, footer] of cases) {
    writeFileSync(
      join(directory, "sidebar-host.js"),
      `export { run, theme } from "herdr"
export function layout() { return {children: [{id: "sidebar", size: {px: ${footer?.width ?? 268}}}]} }
export function updates() { return {app: {ready: ${footer?.ready ? '"0.1.15"' : "null"}}} }
`,
    )
    writeFileSync(
      join(directory, "main.js"),
      `import ModManager from "./view.js"
import { fixtureSession, migration } from "./fixture.js"
export default class extends ModManager {
  createSession() { ${footer ? 'throw new Error("Footer must not create a session")' : "return fixtureSession()"} }
  init(props, cx) {
    super.init(${footer ? "{footer: true}" : "props"}, cx)
    ${setup}
  }
}
`,
    )
    console.log(`Checking native fixture: ${name}`)
    const result = spawnSync("herdr-app", ["check", directory], {
      stdio: "inherit",
      env: { ...process.env, HERDR_APP_HOME: profile },
      timeout: 300_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native fixture check failed: ${name}`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
