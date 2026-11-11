import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runRequest } from "../helper.mjs"

const directory = await mkdtemp(join(tmpdir(), "herdr-markdown-reader-check-"))
const profile = join(directory, "profile")
const fixture = join(directory, "fixture")
const cases = [
  "empty",
  "loading",
  "error",
  "ready",
  "raw",
  "source",
  "refresh-error",
  "remote",
  "unsafe-manifest",
]
try {
  await mkdir(join(profile, "data/markdown-reader/requests"), { recursive: true })
  await mkdir(fixture)
  const request = join(profile, "data/markdown-reader/requests/native-fixture.json")
  await writeFile(
    request,
    JSON.stringify({
      appHome: profile,
      file: resolve("fixtures/reader.md"),
      root: resolve("fixtures"),
      on: null,
      width: 720,
    }),
  )
  const manifest = await runRequest(request)
  if (manifest.blocks.some((block) => block.type === "error"))
    throw new Error("Native fixture renderer failed")
  await writeFile(
    join(fixture, "fixture.js"),
    `export const manifest = ${JSON.stringify(manifest)}\n`,
  )
  for (const [source, target] of [
    ["main.js", "view.js"],
    ["runtime.js", "runtime.js"],
    ["model.js", "model.js"],
    ["mod.json", "mod.json"],
  ])
    await copyFile(new URL(`../${source}`, import.meta.url), join(fixture, target))
  for (const state of cases) {
    await writeFile(
      join(fixture, "main.js"),
      `import Reader from "./view.js"
import { manifest } from "./fixture.js"
const state = ${JSON.stringify(state)}
export default class extends Reader {
  createIO() { return {renew: async()=>{},cancel:async()=>{},release:async()=>{}} }
  init(_props,cx) {
    super.init(state === "empty" ? {} : {file:manifest.file,root:manifest.root,on:state === "remote" ? "test-machine" : null},cx)
    this.raw = state === "raw"
    if (state === "source") for (const block of manifest.blocks) this.sources.add(block.id)
    if (this.session?.manifest) this.prepareEditors(this.session.manifest)
  }
  refresh() {
    this.palette = JSON.stringify(this.renderOptions())
    if (state === "loading") this.session.busy = true
    else if (state === "error") this.session.error = "A bounded fixture read failed"
    else {
      this.session.manifest = manifest
      if (state === "refresh-error") this.session.error = "Refresh failed; last good document remains visible"
      if (state === "unsafe-manifest") this.error = "Unsafe asset path rejected by manifest validation"
    }
  }
}
`,
    )
    console.log(`Checking native reader fixture: ${state}`)
    const result = spawnSync("herdr-app", ["check", fixture], {
      stdio: "inherit",
      env: { ...process.env, HERDR_APP_HOME: profile },
      timeout: 300000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native fixture failed: ${state}`)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
