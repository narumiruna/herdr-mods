import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), "herdr-better-files-check-"))
const profile = join(temporary, "profile")
const fixture = join(profile, "mods", "better-files")
const program = process.platform === "win32" ? "herdr-app.exe" : "herdr-app"

function run(program, args) {
  const result = spawnSync(program, args, {
    stdio: "inherit",
    env: { ...process.env, HERDR_APP_HOME: profile },
    timeout: 300_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Native Better Files check failed: ${program} ${args.join(" ")}`)
}

function check(directory) {
  run(program, ["check", directory])
}

try {
  mkdirSync(fixture, { recursive: true })
  if (!process.argv.includes("--views")) check(root)
  copyFileSync(join(root, "main.js"), join(fixture, "files-view.js"))
  const reader = join(fixture, "reader")
  mkdirSync(reader)
  copyFileSync(join(root, "reader/main.js"), join(reader, "reader-view.js"))
  for (const name of ["model.js", "runtime.js", "node.js"]) {
    copyFileSync(join(root, "reader", name), join(reader, name))
  }
  writeFileSync(
    join(reader, "main.js"),
    `import Reader from "./reader-view.js"
export default class extends Reader {
  createIO() { return { renew: async () => {}, cancel: async () => {}, release: async () => {} } }
  refresh() {
    this.palette = JSON.stringify(this.renderOptions())
    this.session.manifest = {
      file: "/example/README.md", root: "/example", source: "# Example",
      blocks: [{id: "example", type: "html", html: "<h1>Example</h1>"}],
      links: {}, anchors: {}, warnings: [], assets: []
    }
    this.prepareEditors(this.session.manifest)
  }
}
`,
  )
  for (const name of [
    "markdown.js",
    "mod.json",
    "chevron-down.svg",
    "chevron-right.svg",
    "file.svg",
    "folder.svg",
  ]) {
    copyFileSync(join(root, name), join(fixture, name))
  }
  for (const state of [
    "empty",
    "tree",
    "preview",
    "error",
    "markdown",
    "markdown-remote",
    "markdown-back",
  ]) {
    writeFileSync(
      join(fixture, "main.js"),
      `import Files from "./files-view.js"
import { EditorState } from "gpui-base"
const state = ${JSON.stringify(state)}
export default class extends Files {
  init(_props, cx) {
    this.ownerCx = cx
    this.reader = null
    this.closingReaders = new Set()
    this.closed = false
    this.root = "/example"
    this.on = null
    this.context = { key: "fixture", cwd: this.root, root: this.root, on: null, space: "fixture" }
    this.saved = new Map()
    this.entries = new Map([["", state === "tree" ? [
      { name: "docs", dir: true },
      { name: "README.md", dir: false },
      { name: "source.js", dir: false }
    ] : []]])
    this.folders = new Set()
    this.pending = new Set()
    this.marks = {}
    this.file = state === "preview" ? "source.js" : null
    this.error = state === "error" ? "Fixture: folder is unavailable" : null
    this.loading = false
    this.limited = false
    this.code = state === "preview" ? EditorState.new({
      value: "const example = true",
      language: "js",
      readonly: true,
      font_size: 12
    }) : null
    if (state.startsWith("markdown")) {
      this.openFile("README.md", cx, {
        ...this.context, on: state === "markdown-remote" ? "fixture-remote" : null
      })
      if (state === "markdown-back") this.show(null, cx)
    }
  }
  refresh() {}
}
`,
    )
    console.log(`Checking Better Files native fixture: ${state}`)
    check(fixture)
  }
  run(process.execPath, [join(root, "scripts/check-reader-views.mjs")])
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
