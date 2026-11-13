import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runRequest } from "../reader/helper.mjs"
import { validateManifest } from "../reader/model.js"

const modRoot = fileURLToPath(new URL("..", import.meta.url))
const cases = [
  "missing-entry",
  "loading",
  "error",
  "ready",
  "raw",
  "source",
  "refresh-error",
  "remote",
  "unsafe-manifest",
]

export async function checkReaderViews() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-better-files-reader-check-"))
  const profile = join(directory, "profile")
  const fixture = join(profile, "mods", "reader-fixture")
  try {
    const requests = join(profile, "data/better-files/requests")
    await mkdir(requests, { recursive: true })
    await mkdir(join(fixture, "reader"), { recursive: true })
    const request = join(requests, "native-fixture.json")
    await writeFile(
      request,
      JSON.stringify({
        appHome: profile,
        file: join(modRoot, "fixtures/reader.md"),
        root: join(modRoot, "fixtures"),
        on: null,
        width: 720,
      }),
    )
    const manifest = validateManifest(await runRequest(request))
    const inspect = (block) => {
      if (block.type === "error") throw new Error(`Native fixture renderer failed: ${block.error}`)
      for (const child of block.children || []) inspect(child)
    }
    manifest.blocks.forEach(inspect)
    await writeFile(
      join(fixture, "fixture.js"),
      `export const manifest = ${JSON.stringify(manifest)}\n`,
    )
    for (const name of ["main.js", "runtime.js", "model.js", "node.js"])
      await copyFile(join(modRoot, "reader", name), join(fixture, "reader", name))
    await writeFile(join(fixture, "mod.json"), JSON.stringify({ place: "none", focusable: true }))
    for (const state of cases) {
      await writeFile(
        join(fixture, "main.js"),
        `import Reader from "./reader/main.js"
import { manifest } from "./fixture.js"
import { div, View } from "gpui-kit"
import { validateManifest } from "./reader/model.js"
const state = ${JSON.stringify(state)}
class FixtureReader extends Reader {
  createIO() { return {renew: async()=>{},cancel:async()=>{},release:async()=>{}} }
  watch() {}
  schedule() { this.palette = JSON.stringify(this.renderOptions()) }
  init(_props,cx) {
    super.init(state === "missing-entry" ? {} : {file:manifest.file,root:manifest.root,on:state === "remote" ? "test-machine" : null},cx)
    if (state === "missing-entry" && (this.session || !this.error)) throw new Error("Missing entry must fail without an Open form")
    this.raw = state === "raw"
    if (state === "source") for (const block of manifest.blocks) this.sources.add(block.id)
    if (this.session?.manifest) {
      this.prepareEditors(this.session.manifest)
      this.prepareBlocks(this.session.manifest, cx)
    }
  }
  refresh() {
    this.palette = JSON.stringify(this.renderOptions())
    if (state === "loading") this.session.busy = true
    else if (state === "error") this.session.error = "A bounded fixture read failed"
    else if (state === "unsafe-manifest") {
      try { validateManifest({...manifest,assets:["../unsafe.svg"]}) }
      catch (error) { this.session.error = error.message }
      if (!this.session.error) throw new Error("Unsafe manifest accepted")
    } else {
      this.session.manifest = manifest
      if (state === "refresh-error") this.session.error = "Refresh failed; last good document remains visible"
    }
  }
}
export default class extends View {
  init(_props,cx) {
    const owner = this
    class EmbeddedReader extends FixtureReader {
      init(props, childCx) { owner.readerView = this; super.init(props, childCx) }
    }
    this.reader = cx.new(EmbeddedReader, {})
  }
  async close() {
    try { await this.readerView?.close() }
    finally { this.reader.release() }
  }
  render() { return div().size_full().child(this.reader) }
}
`,
      )
      console.log(`Checking embedded reader native fixture: ${state}`)
      const result = spawnSync(
        process.platform === "win32" ? "herdr-app.exe" : "herdr-app",
        ["check", fixture],
        {
          stdio: "inherit",
          env: { ...process.env, HERDR_APP_HOME: profile },
          timeout: 300000,
        },
      )
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`Native reader fixture failed: ${state}`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkReaderViews()
