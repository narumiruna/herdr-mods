import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "puppeteer"
import { runRequest } from "../helper.mjs"
import { validateManifest } from "../model.js"
import { Renderers } from "../renderers/index.js"

const modRoot = fileURLToPath(new URL("..", import.meta.url))
const modes = [
  "light",
  "dark",
  "narrow",
  "raw",
  "error",
  "loading",
  "prose",
  "graphics",
  "footnotes",
  "graphics-dark",
]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const groups = new Set()
const timing = []
let output
let activeApp
let activeEnv

// Generation-1 method names from hc 0.1.20's OpenRPC schema. Advertising the
// complete list prevents Herdr 0.1.15 from trying to install/update a real core.
function offlineCore() {
  const fs = require("node:fs")
  const path = require("node:path")
  const log = (value) =>
    fs.appendFileSync(
      path.join(__dirname, "offline-core.jsonl"),
      `${JSON.stringify({ pid: process.pid, ...value })}\n`,
    )
  log({ args: process.argv.slice(2) })
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log("hc 0.1.20")
    return
  }
  if (!process.argv.includes("connect")) {
    process.exitCode = 1
    return
  }
  const core = { id: "isolated-markdown-evidence", name: "offline-fixture" }
  const methods =
    "hello server.status server.stop server.restart terminal.run templates.list terminal.list terminal.get terminal.kill terminal.rm terminal.keep terminal.label terminal.read terminal.attach terminal.send terminal.wait terminal.keys terminal.interrupt terminal.put machine.exec file.read file.write file.edit doc.get doc.set events.subscribe machine.add machine.list machine.connect machine.rename machine.rm rpc.discover".split(
      " ",
    )
  let pending = Buffer.alloc(0)
  let hello = false
  const framed = (message) => {
    const body = Buffer.from(JSON.stringify(message))
    const header = Buffer.alloc(9)
    header.writeUInt32LE(body.length, 5)
    process.stdout.write(Buffer.concat([header, body]))
  }
  const reply = (request) => {
    log({ request })
    let result
    switch (request.method) {
      case "server.status":
        result = {
          core,
          version: "0.1.20",
          pid: process.pid,
          uptime_ms: 0,
          holders: [],
          live: 0,
          finished: 0,
          installed_by: "offline-fixture",
        }
        break
      case "events.subscribe":
        result = { channel: 1, seq: 0, terminals: [] }
        break
      case "terminal.list":
        result = { terminals: [], hidden_finished: 0, machines: [] }
        break
      case "machine.list":
        result = { machines: [] }
        break
      case "doc.get":
        result = { value: null, version: 0 }
        break
      default:
        framed({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "Offline fixture denies this method",
            data: { kind: "fixture_denied" },
          },
        })
        return
    }
    framed({ jsonrpc: "2.0", id: request.id, result })
  }
  process.stdin.on("data", (data) => {
    pending = Buffer.concat([pending, data])
    if (pending.length > 2 * 1048576) throw new Error("Oversized core input")
    if (!hello) {
      const end = pending.indexOf(10)
      if (end < 0) return
      const request = JSON.parse(pending.subarray(0, end).toString())
      if (request.method !== "hello") throw new Error("Expected core hello")
      pending = pending.subarray(end + 1)
      hello = true
      log({ hello: request })
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "0.1.20", core, framed: true, methods, features: [] } })}\n`,
      )
    }
    while (pending.length >= 9) {
      const length = pending.readUInt32LE(5)
      if (length > 1048576) throw new Error("Oversized core frame")
      if (pending.length < 9 + length) return
      const kind = pending[0]
      const body = pending.subarray(9, 9 + length)
      pending = pending.subarray(9 + length)
      if (kind === 0) reply(JSON.parse(body.toString()))
    }
  })
  process.stdin.on("end", () => process.exit(0))
}

function alive(group) {
  try {
    process.kill(-group, 0)
    return true
  } catch (error) {
    if (error.code !== "ESRCH") throw error
    return false
  }
}
async function stopGroup(group) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!alive(group)) break
    try {
      process.kill(-group, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
    for (let attempt = 0; attempt < 30 && alive(group); attempt++) await sleep(100)
  }
  if (alive(group)) throw new Error(`Owned process group remains: ${group}`)
}
function processTable() {
  const result = spawnSync("/bin/ps", ["-axo", "pid,ppid,pgid,command"], {
    encoding: "utf8",
    timeout: 5000,
  })
  if (result.status !== 0) throw new Error("Cannot inspect owned processes")
  return result.stdout
    .split("\n")
    .filter((line) => groups.has(Number(line.trim().split(/\s+/)[2])))
    .join("\n")
}
// A successful exit can precede the last pipe data. Only close completes output.
export async function command(program, args, env, timeout = 15000) {
  const child = spawn(program, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  if (child.pid) groups.add(child.pid)
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (data) => {
    stdout += data
  })
  child.stderr.on("data", (data) => {
    stderr += data
  })
  let timer
  let timedOut = false
  try {
    const { code, signal } = await new Promise((done, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => done({ code, signal }))
      timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if (error.code !== "ESRCH") return reject(error)
        }
        // Bound pipe waiting too, but let close reap the child before cleanup.
        child.stdout.destroy()
        child.stderr.destroy()
      }, timeout)
    })
    if (timedOut)
      throw Object.assign(
        new Error(`${program} ${args.join(" ")}: timed out after ${timeout} ms`),
        { code: "ETIMEDOUT", stdout, stderr },
      )
    if (code !== 0)
      throw Object.assign(
        new Error(`${program} ${args.join(" ")}: ${stderr || stdout || `exit ${code}`}`),
        { exitCode: code, signal, stdout, stderr },
      )
    return { stdout, stderr }
  } finally {
    clearTimeout(timer)
    if (child.pid) await stopGroup(child.pid)
  }
}
// Verified with Herdr 0.1.15 status against missing and stale macOS sockets.
// Do not retry permission errors, protocol failures, other sockets, or timeouts.
function statusConnectionError(error, env) {
  const prefix = `herdr-app: no Herdr window at ${join(env.HERDR_APP_HOME, "herdr-app.sock")}: `
  return (
    error.exitCode === 2 &&
    error.signal === null &&
    error.code == null &&
    error.stdout === "" &&
    ["No such file or directory (os error 2)", "Connection refused (os error 61)"].some(
      (reason) => error.stderr?.trimEnd() === prefix + reason,
    )
  )
}

// Bound status commands and retry sleeps by one startup deadline. Check the
// owned leader too: its group can outlive it if an app child remains running.
export async function waitForStatus(
  app,
  env,
  child,
  mode,
  { timeout = 15000, run = command } = {},
) {
  const deadline = Date.now() + timeout
  const checkApp = () => {
    if (child.exitCode !== null || child.signalCode !== null || !alive(child.pid))
      throw new Error(`App exited in mode ${mode}`)
  }
  let lastError
  const expired = () =>
    new Error(`App status startup deadline exceeded in mode ${mode}`, { cause: lastError })
  while (true) {
    checkApp()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw expired()
    let result
    try {
      result = await run(app, ["status"], env, remaining)
    } catch (error) {
      checkApp()
      lastError = error
      if (Date.now() >= deadline) throw expired()
      if (!statusConnectionError(error, env)) throw error
      await sleep(Math.min(100, deadline - Date.now()))
      continue
    }
    checkApp()
    if (Date.now() >= deadline) throw expired()
    const status = JSON.parse(result.stdout)
    if (!Array.isArray(status?.errors) || status.errors.length)
      throw new Error(`Native runtime errors in ${mode}: ${JSON.stringify(status?.errors)}`)
    return status
  }
}
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`

async function prepareIsolation(root) {
  const profile = join(root, "profile")
  const home = join(root, "home")
  for (const directory of [
    "bin",
    "state",
    "config",
    "runtime",
    "home/.local/bin",
    "profile/layouts",
    "profile/mods/markdown-evidence",
    "profile/data/markdown-reader/requests",
  ])
    await mkdir(join(root, directory), { recursive: true })
  await writeFile(join(root, "offline-core.cjs"), `(${offlineCore.toString()})();\n`)
  const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "offline-core.cjs"))} "$@"\n`
  for (const path of [
    "bin/herdr-core",
    "bin/hc",
    "home/.local/bin/herdr-core",
    "home/.local/bin/hc",
  ])
    await writeFile(join(root, path), wrapper, { mode: 0o700 })
  await writeFile(
    join(root, "bin/curl"),
    `#!/bin/sh\nprintf 'denied curl\\n' >> ${shellQuote(join(root, "denied-network.log"))}\nexit 1\n`,
    { mode: 0o700 },
  )
  return {
    HOME: home,
    HERDR_APP_HOME: profile,
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    TMPDIR: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    HC_SOCKET: join(root, "no-core.sock"),
    HERDR_RELEASES_URL: "http://127.0.0.1:9",
    HERDR_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== "--output"))
    throw new Error("Usage: node scripts/native-evidence.mjs [--output NEW_DIRECTORY]")
  if (process.platform !== "darwin")
    throw new Error("This fixture requires the installed macOS Herdr app")
  const app = await realpath("/Applications/Herdr.app/Contents/MacOS/Herdr")
  const executablePath = await puppeteer.executablePath()
  await access(executablePath) // Check the installed browser; never download one.
  const directory = args.length ? resolve(args[1]) : await mkdtemp("/tmp/herdr-md-native-")
  const candidate = join(await realpath(dirname(directory)), basename(directory))
  const repository = resolve(modRoot, "../..")
  if (candidate === repository || candidate.startsWith(`${repository}/`))
    throw new Error("Evidence output must be outside the source repository")
  if (args.length) await mkdir(candidate, { mode: 0o700 }) // Refuse existing paths without writing into them.
  output = await realpath(candidate)
  console.log(`Native evidence: ${output}`)
  if (Buffer.byteLength(join(output, "graphics-dark/profile/herdr-app.sock")) >= 104)
    throw new Error("Output path is too long for the macOS app socket; use a short path under /tmp")
  await mkdir(join(output, "captures"))
  const started = Date.now()
  const summary = {
    app,
    modes,
    fixture: join(modRoot, "fixtures/reader.md"),
    captures: [],
    limitations: [
      "No inline formula support claim",
      "No selection/copy or pointer/key tests",
      "No live Files integration, watch, or refresh test",
      "Error/loading modes are injected states",
    ],
  }
  summary.dependencies = JSON.parse(
    await readFile(join(modRoot, "package.json"), "utf8"),
  ).dependencies
  summary.browserExecutable = executablePath
  const browsers = []
  const version = (
    await command(app, ["--version"], await prepareIsolation(join(output, "version")))
  ).stdout.trim()
  summary.version = version
  const manifests = new Map()
  for (const mode of modes) {
    if (interrupted) throw new Error("Evidence run interrupted")
    const begin = Date.now()
    const root = join(output, mode)
    const env = await prepareIsolation(root)
    activeEnv = env
    const profile = env.HERDR_APP_HOME
    const fixture = join(profile, "mods/markdown-evidence")
    const dark = mode === "dark" || mode === "graphics-dark"
    const width = mode === "narrow" ? 400 : 800
    const key = `${dark}-${width}`
    const request = join(profile, "data/markdown-reader/requests/native-evidence.json")
    await json(request, {
      appHome: profile,
      file: summary.fixture,
      root: join(modRoot, "fixtures"),
      on: null,
      width,
      dark,
    })
    const renderStart = Date.now()
    const cached = manifests.get(key)
    let manifest
    if (!cached) {
      manifest = validateManifest(
        await runRequest(request, {
          rendererFactory(options) {
            const renderer = new Renderers(options)
            const launch = renderer.mermaid.launch
            renderer.mermaid.launch = async (options) => {
              const launchStart = Date.now()
              const browser = await launch({
                ...options,
                executablePath,
                userDataDir: join(root, "chromium"),
                env,
              })
              const pid = browser.process()?.pid
              if (!pid) throw new Error("Browser ownership unavailable")
              groups.add(pid)
              browsers.push({ mode, pid, startupMs: Date.now() - launchStart })
              return browser
            }
            return renderer
          },
        }),
      )
      const inspect = (block) => {
        if (block.type === "error") throw new Error(`Fixture block failed: ${block.error}`)
        for (const child of block.children || []) inspect(child)
      }
      manifest.blocks.forEach(inspect)
      const kinds = manifest.blocks
        .filter((block) => block.type === "graphic")
        .map((block) => block.kind)
      for (const kind of ["math", "mermaid", "vega-lite"])
        if (!kinds.includes(kind)) throw new Error(`Missing real SVG fixture: ${kind}`)
      manifests.set(key, { manifest, profile })
    } else {
      manifest = cached.manifest
      for (const asset of manifest.assets) {
        await mkdir(dirname(join(profile, asset)), { recursive: true })
        await copyFile(join(cached.profile, asset), join(profile, asset))
      }
    }
    const renderMs = Date.now() - renderStart
    for (const browser of browsers)
      if (alive(browser.pid)) throw new Error(`Browser did not close: ${browser.pid}`)
    await json(join(root, "manifest.json"), manifest)
    await writeFile(
      join(fixture, "fixture.js"),
      `export const manifest = ${JSON.stringify(manifest)}\n`,
    )
    for (const [source, target] of [
      ["main.js", "view.js"],
      ["model.js", "model.js"],
      ["runtime.js", "runtime.js"],
    ])
      await copyFile(join(modRoot, source), join(fixture, target))
    await json(join(fixture, "mod.json"), { place: "none", focusable: true })
    await writeFile(
      join(fixture, "main.js"),
      `import Reader from "./view.js"
import { manifest } from "./fixture.js"
import { v_flex } from "gpui-base"
import { div } from "gpui-kit"
const mode = ${JSON.stringify(mode)}
const prose = blocks => blocks.filter(block=>!["graphic", "code"].includes(block.type))
  .map(block=>block.children ? {...block, children:prose(block.children)} : block)
export default class extends Reader {
  createIO() { return { renew: async()=>{}, cancel: async()=>{}, release: async()=>{} } }
  watch() {}
  schedule() { this.palette = JSON.stringify(this.renderOptions()) }
  refresh() {
    this.palette = JSON.stringify(this.renderOptions())
    if (mode === "loading") this.session.busy = true
    else if (mode === "error") this.session.error = "Intentional fixture read error; no document was opened"
    else {
      this.session.manifest = mode.startsWith("graphics") ? { ...manifest, blocks: manifest.blocks.filter(block=>block.type === "graphic") }
        : mode === "prose" ? { ...manifest, blocks: prose(manifest.blocks) }
        : mode === "footnotes" ? { ...manifest, blocks: manifest.blocks.filter(block=>block.html?.includes("data-footnote")) } : manifest
    }
  }
  init(_props, cx) {
    super.init({ file:manifest.file, root:manifest.root, on:null }, cx)
    this.raw = mode === "raw"
    if (this.session.manifest) this.prepareEditors(this.session.manifest)
  }
  render(cx) {
    const label = mode.startsWith("graphics") ? mode + " (filtered graphic blocks)" : mode === "prose" ? mode + " (filtered prose blocks)" : mode === "footnotes" ? mode + " (filtered footnote blocks)" : mode
    return v_flex().size_full().child(div().h(26).px(12).flex_none().text_size(12).child("Native reader evidence / " + label))
      .child(super.render(cx).flex_1().min_h(0))
  }
}
`,
    )
    const layout = `markdown-evidence-${mode}`
    await json(join(profile, "layouts", `${layout}.json`), {
      id: "root",
      type: "block",
      theme: dark ? "graphite" : "paper",
      ui_font: "Geist",
      font: "JetBrains Mono",
      font_size: 15,
      content: { mod: "markdown-evidence" },
    })
    await json(join(profile, "settings.json"), {
      zoom: 1,
      appearance: dark ? "dark" : "light",
      theme: dark ? "graphite" : "paper",
      telemetry: false,
      clipboard_write: false,
      core: join(root, "bin/herdr-core"),
      sounds: { enabled: false },
    })
    await json(join(profile, "shared.json"), { layout, "frame.welcomed": "finished" })
    await json(join(profile, "window.json"), {
      state: "windowed",
      bounds: [60, 60, mode === "narrow" ? 480 : 1100, 1000],
    })
    const versionNumber = /\d+\.\d+\.\d+/.exec(version)?.[0]
    if (!versionNumber) throw new Error(`Unknown app version: ${version}`)
    await json(join(profile, "update-notes.json"), { last_run: versionNumber, presented: [] })
    const checkStart = Date.now()
    const check = await command(app, ["check", fixture], env, 30000)
    const checkMs = Date.now() - checkStart
    await json(join(root, "check.json"), check)
    const log = await open(join(root, "app.log"), "w")
    const launchStart = Date.now()
    activeApp = spawn(app, [], { env, detached: true, stdio: ["ignore", log.fd, log.fd] })
    await log.close()
    if (!activeApp.pid) throw new Error("App did not start")
    groups.add(activeApp.pid)
    activeApp.on("error", (error) => {
      console.error(error.message)
    })
    await json(join(root, "owned-app.json"), { pid: activeApp.pid, group: activeApp.pid })
    const status = await waitForStatus(app, env, activeApp, mode)
    if (mode === "light")
      summary.sdkHashes = Object.fromEntries(
        await Promise.all(
          ["AGENTS.md", "gpui-kit.d.ts", "herdr.d.ts"].map(async (path) => [
            path,
            hash(await readFile(join(profile, path))),
          ]),
        ),
      )
    await json(join(root, "status.json"), status)
    if (status.layout !== layout) throw new Error(`Unexpected layout in ${mode}: ${status.layout}`)
    const processes = processTable()
    await writeFile(join(root, "processes.txt"), `${processes}\n`)
    const capture = join(output, "captures", `${mode}.png`)
    await command(app, ["shot", capture], env)
    const finalStatus = JSON.parse((await command(app, ["status"], env)).stdout)
    await json(join(root, "status-after-shot.json"), finalStatus)
    if (!Array.isArray(finalStatus.errors) || finalStatus.errors.length)
      throw new Error(`Native errors after capture: ${mode}`)
    await command(app, ["do", "app.quit"], env).catch(() => {})
    for (let attempt = 0; attempt < 30 && alive(activeApp.pid); attempt++) await sleep(100)
    await stopGroup(activeApp.pid)
    activeApp = null
    const coreLog = (await readFile(join(root, "offline-core.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    if (!coreLog.some((entry) => entry.hello))
      throw new Error("Offline core handshake was not observed")
    const bytes = await readFile(capture)
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new Error("Capture is not a PNG")
    const result = {
      mode,
      path: capture,
      sha256: hash(bytes),
      bytes: bytes.length,
      manifestBlockIds: manifest.blocks.map((block) => block.id),
    }
    summary.captures.push(result)
    timing.push({
      mode,
      reusedManifest: Boolean(cached),
      renderMs,
      checkMs,
      launchCaptureAndQuitMs: Date.now() - launchStart,
      totalMs: Date.now() - begin,
    })
    console.log(`Captured ${mode}: ${capture}`)
  }
  summary.browsers = browsers
  for (const browser of browsers) {
    if (alive(browser.pid))
      throw new Error(`Browser group leaked after helper close: ${browser.pid}`)
  }
  for (const group of groups)
    if (alive(group)) throw new Error(`Owned process group leaked: ${group}`)
  summary.elapsedMs = Date.now() - started
  summary.cleanup = { verified: true, ownedGroups: [...groups], remaining: [] }
  summary.sourceHashes = Object.fromEntries(
    await Promise.all(
      ["main.js", "model.js", "runtime.js", "helper.mjs", "fixtures/reader.md"].map(
        async (path) => [path, hash(await readFile(join(modRoot, path)))],
      ),
    ),
  )
  await json(join(output, "captures.json"), summary)
  await json(join(output, "timing.json"), timing)
  console.log(`PASS: ${modes.length} native captures; owned process groups stopped`)
}

let interrupted = false
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = true
      for (const group of groups) if (alive(group)) process.kill(-group, "SIGTERM")
    })
  try {
    await main()
    if (interrupted) throw new Error("Evidence run interrupted")
  } catch (error) {
    console.error(error.stack || error.message)
    process.exitCode = 1
    if (output)
      await json(join(output, "failure.json"), { error: String(error.stack || error), timing })
  } finally {
    if (activeApp && activeEnv) {
      await command(
        "/Applications/Herdr.app/Contents/MacOS/Herdr",
        ["do", "app.quit"],
        activeEnv,
      ).catch(() => {})
    }
    const cleanupErrors = []
    for (const group of groups)
      await stopGroup(group).catch((error) => cleanupErrors.push(error.message))
    if (output)
      await json(join(output, "cleanup.json"), {
        ownedGroups: [...groups],
        remaining: [...groups].filter(alive),
        errors: cleanupErrors,
      })
    if (cleanupErrors.length) {
      console.error(cleanupErrors.join("\n"))
      process.exitCode = 1
    }
  }
}
