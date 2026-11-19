import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, open, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Run only with serialized native capture access and stable source files.
// No preview is copied into a mod root automatically: inspect the PNG first.
const repository = fileURLToPath(new URL("..", import.meta.url))
const offlineCorePath = "scripts/fixtures/offline-core.cjs"
const specs = {
  "github-issues-prs": {
    files: ["main.js", "github.js", "tabs.js", "mod.json", "icons"],
    states: ["list", "error"],
    width: 680,
    height: 760,
  },
  "mod-manager": {
    files: ["main.js", "manager.js", "runtime.js", "sidebar.js", "mod.json"],
    states: ["gallery", "error"],
    width: 1100,
    height: 850,
  },
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const apps = createAppOwner()
const { groups } = apps
let output
let interrupted = false

function replaceOnce(source, oldText, newText) {
  if (!source.includes(oldText) || source.indexOf(oldText) !== source.lastIndexOf(oldText))
    throw new Error(`Fixture source changed; review this replacement: ${oldText}`)
  return source.replace(oldText, newText)
}

// Transform only a disposable copy of the reviewed eager-check generator.
// It still creates its real subclass and safe example data. Instead of running
// a check, save the selected fixture copies. Its finally deletes its own temp.
export function captureGenerator(source, name, destination, temporary) {
  const variable = name === "mod-manager" ? "name" : "state"
  let result = replaceOnce(
    source,
    'import { spawnSync } from "node:child_process"',
    'import { cpSync as saveFixture } from "node:fs"',
  )
  result = replaceOnce(
    result,
    'import { tmpdir } from "node:os"',
    `const tmpdir = () => ${JSON.stringify(temporary)}`,
  )
  const start = result.indexOf('const result = spawnSync("herdr-app", ["check", directory], {')
  const end = result.indexOf("if (result.error)", start)
  if (
    start < 0 ||
    end < 0 ||
    !/^const result = spawnSync\([\s\S]*?\n {4}\}\)\s*$/.test(result.slice(start, end))
  )
    throw new Error(`Unrecognized native check in ${name}; review the generator`)
  result = `${result.slice(0, start)}const result = { status: 0 }\n    if (${JSON.stringify(specs[name].states)}.includes(${variable}))\n      saveFixture(directory, ${JSON.stringify(destination)} + "/" + ${variable}, { recursive: true })\n    ${result.slice(end)}`
  if (result.includes("spawnSync"))
    throw new Error("A native process call remains in the fixture generator")
  return result
    .replaceAll("Checking eager native description fixture:", "Preparing trusted fixture:")
    .replaceAll("Checking native fixture:", "Preparing trusted fixture:")
}

export function pngInfo(bytes) {
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Native shot is not a PNG with an IHDR")
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) throw new Error("Empty native capture")
  return { width, height, bytes: bytes.length, sha256: sha256(bytes) }
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
async function stop(group) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!alive(group)) return
    try {
      process.kill(-group, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
    for (let attempt = 0; attempt < 30 && alive(group); attempt++) await sleep(100)
  }
  if (alive(group)) throw new Error(`Owned process group remains: ${group}`)
}

// A successful exit can precede the last pipe data. Only close completes output.
export async function command(program, args, env, timeout = 15000) {
  const child = spawn(program, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
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
    if (child.pid) await stop(child.pid)
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

export function createAppOwner({ start = spawn, run = command } = {}) {
  const groups = new Set()
  let active = null
  return {
    groups,
    start(app, env, fd) {
      active = null
      if (!env?.HOME || !env.HERDR_APP_HOME)
        throw new Error("App launch requires an isolated environment")
      const child = start(app, [], { env, detached: true, stdio: ["ignore", fd, fd] })
      // A failed spawn can emit an error while the caller closes the log.
      child.on("error", (error) => console.error(error.message))
      if (!child.pid) throw new Error("App did not start")
      active = { pid: child.pid, env }
      groups.add(child.pid)
      return child
    },
    async quit(app) {
      const owned = active
      if (!owned?.pid || !groups.has(owned.pid) || !owned.env?.HOME || !owned.env.HERDR_APP_HOME)
        return
      await run(app, ["do", "app.quit"], owned.env, 3000).catch(() => {})
      for (let attempt = 0; attempt < 30 && alive(owned.pid); attempt++) await sleep(100)
      await stop(owned.pid)
      active = null
    },
  }
}
async function isolation(root, core) {
  for (const path of [
    "bin",
    "home/.local/bin",
    "profile/layouts",
    "profile/mods",
    "state",
    "config",
    "runtime",
  ])
    await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, "offline-core.cjs"), core)
  const wrapper = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "offline-core.cjs"))} "$@"\n`
  for (const path of [
    "bin/hc",
    "bin/herdr-core",
    "home/.local/bin/hc",
    "home/.local/bin/herdr-core",
  ])
    await writeFile(join(root, path), wrapper, { mode: 0o700 })
  for (const program of ["curl", "gh", "git", "ssh", "uv"])
    await writeFile(
      join(root, "bin", program),
      `#!/bin/sh\nprintf 'denied ${program}\\n' >> ${quote(join(root, "denied-commands.log"))}\nexit 1\n`,
      { mode: 0o700 },
    )
  return {
    HOME: join(root, "home"),
    HERDR_APP_HOME: join(root, "profile"),
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
async function files(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are forbidden in evidence input: ${path}/${entry.name}`)
    if (entry.isDirectory())
      result.push(...(await files(join(path, entry.name))).map((child) => `${entry.name}/${child}`))
    else if (entry.isFile()) result.push(entry.name)
    else throw new Error(`Unsupported evidence input: ${path}/${entry.name}`)
  }
  return result.sort()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== "--output"))
    throw new Error("Usage: node scripts/native-previews.mjs [--output NEW_DIRECTORY]")
  if (process.platform !== "darwin")
    throw new Error("Native capture requires the installed macOS Herdr app")
  const app = await realpath("/Applications/Herdr.app/Contents/MacOS/Herdr")
  const directory = args.length ? resolve(args[1]) : await mkdtemp("/tmp/herdr-previews-")
  const candidate = join(await realpath(dirname(directory)), basename(directory))
  if (candidate === resolve(repository) || candidate.startsWith(`${resolve(repository)}/`))
    throw new Error("Evidence output must be outside the repository")
  if (Buffer.byteLength(join(candidate, "github-issues-prs-error/profile/herdr-app.sock")) >= 104)
    throw new Error("Output path is too long for the macOS socket; use a short /tmp path")
  if (args.length) await mkdir(candidate, { mode: 0o700 }) // Refuse an existing directory.
  output = await realpath(candidate)
  console.log(`Native evidence: ${output}`)
  const summary = {
    app,
    sourceHashes: {},
    captures: [],
    limitations: [
      "Trusted check-views subclasses inject example state; live I/O is replaced or denied.",
      "Native captures show the current viewport, not all scrollable content.",
      "No pointer, keyboard, clipboard, browser, account, network, install, update or uninstall interactions were exercised.",
      "Restricted environment and denied command wrappers are not an OS network sandbox.",
      "Inspect PNGs before manually copying selected captures to preview.png.",
    ],
  }
  const core = await readFile(join(repository, offlineCorePath))
  summary.sourceHashes[offlineCorePath] = sha256(core)
  summary.sourceHashes["scripts/native-previews.mjs"] = sha256(
    await readFile(fileURLToPath(import.meta.url)),
  )
  const versionEnv = await isolation(join(output, "version"), core)
  summary.version = (await command(app, ["--version"], versionEnv)).stdout.trim()
  const version = /\d+\.\d+\.\d+/.exec(summary.version)?.[0]
  if (!version) throw new Error(`Unrecognized app version: ${summary.version}`)
  await mkdir(join(output, "captures"))
  // Snapshot all inputs before creating any fixture, then check for concurrent edits.
  for (const [name, spec] of Object.entries(specs)) {
    const source = join(repository, "mods", name)
    const snapshot = join(output, "sources", name)
    for (const path of [...spec.files, "scripts/check-views.mjs"]) {
      await mkdir(dirname(join(snapshot, path)), { recursive: true })
      await cp(join(source, path), join(snapshot, path), { recursive: true, dereference: false })
    }
    for (const path of await files(snapshot)) {
      const original = await readFile(join(source, path))
      if (!original.equals(await readFile(join(snapshot, path))))
        throw new Error(`Input changed during snapshot: ${name}/${path}`)
      summary.sourceHashes[`mods/${name}/${path}`] = sha256(original)
    }
  }
  await json(join(output, "sources.json"), summary.sourceHashes)
  for (const [name, spec] of Object.entries(specs)) {
    const fixtures = join(output, "fixtures", name)
    const temporary = join(output, "generator-temp", name)
    const generator = join(output, "sources", name, "scripts/check-views.mjs")
    await mkdir(fixtures, { recursive: true })
    await mkdir(temporary, { recursive: true })
    const generatorSource = await readFile(generator, "utf8")
    await writeFile(`${generator}.original`, generatorSource)
    await writeFile(generator, captureGenerator(generatorSource, name, fixtures, temporary))
    await json(
      join(output, `${name}-generator.json`),
      await command(process.execPath, [generator], versionEnv, 30000),
    )
    for (const state of spec.states) {
      if (interrupted) throw new Error("Evidence capture interrupted")
      const mode = `${name}-${state}`
      const root = join(output, mode)
      const env = await isolation(root, core)
      const profile = env.HERDR_APP_HOME
      const fixture = join(profile, "mods", name)
      await cp(join(fixtures, state), fixture, { recursive: true })
      await json(
        join(root, "fixture-hashes.json"),
        Object.fromEntries(
          await Promise.all(
            (await files(fixture)).map(async (path) => [
              path,
              sha256(await readFile(join(fixture, path))),
            ]),
          ),
        ),
      )
      await json(join(profile, "layouts/evidence.json"), {
        id: "root",
        type: "block",
        theme: "graphite",
        ui_font: "Geist",
        font: "JetBrains Mono",
        font_size: 15,
        content: { mod: name },
      })
      await json(join(profile, "settings.json"), {
        zoom: 1,
        appearance: "dark",
        theme: "graphite",
        telemetry: false,
        clipboard_write: false,
        core: join(root, "bin/herdr-core"),
        sounds: { enabled: false },
      })
      await json(join(profile, "shared.json"), { layout: "evidence", "frame.welcomed": "finished" })
      await json(join(profile, "window.json"), {
        state: "windowed",
        bounds: [60, 60, spec.width, spec.height],
      })
      await json(join(profile, "update-notes.json"), { last_run: version, presented: [] })
      await json(join(root, "check.json"), await command(app, ["check", fixture], env, 30000))
      const log = await open(join(root, "app.log"), "w")
      let child
      try {
        child = apps.start(app, env, log.fd)
      } finally {
        await log.close()
      }
      await json(join(root, "owned-app.json"), { pid: child.pid, group: child.pid })
      const status = await waitForStatus(app, env, child, mode)
      await json(join(root, "status.json"), status)
      if (status.layout !== "evidence") throw new Error(`Wrong layout: ${mode}`)
      const processes = spawnSync("/bin/ps", ["-axo", "pid,ppid,pgid,command"], {
        encoding: "utf8",
        timeout: 5000,
      })
      if (processes.status !== 0) throw new Error("Cannot inspect owned app processes")
      await writeFile(
        join(root, "processes.txt"),
        processes.stdout
          .split("\n")
          .filter((line) => Number(line.trim().split(/\s+/)[2]) === child.pid)
          .join("\n"),
      )
      const path = join(output, "captures", `${mode}.png`)
      await command(app, ["shot", path], env)
      const after = JSON.parse((await command(app, ["status"], env)).stdout)
      await json(join(root, "status-after-shot.json"), after)
      if (after.layout !== "evidence" || !Array.isArray(after.errors) || after.errors.length)
        throw new Error(
          `Native runtime errors after shot: ${mode}: ${JSON.stringify(after.errors)}`,
        )
      await apps.quit(app)
      const coreLog = (await readFile(join(root, "offline-core.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      if (!coreLog.some((entry) => entry.hello))
        throw new Error(`Offline core handshake missing: ${mode}`)
      const corePids = [...new Set(coreLog.map((entry) => entry.pid))]
      for (const pid of corePids) {
        try {
          process.kill(pid, 0)
          throw new Error(`Owned offline core remains after app shutdown: ${pid}`)
        } catch (error) {
          if (error.code !== "ESRCH") throw error
        }
      }
      const appLog = await readFile(join(root, "app.log"), "utf8")
      const diagnostics = appLog.split("\n").filter((line) => /error|warn|panic|failed/i.test(line))
      summary.captures.push({
        mod: name,
        state,
        path,
        ...pngInfo(await readFile(path)),
        errors: after.errors,
        coreCleanup: { verified: true, pids: corePids, remaining: [] },
        diagnostics,
      })
      await json(join(output, "captures.json"), summary)
      console.log(`Captured ${mode}: ${path}`)
    }
  }
  for (const [path, expected] of Object.entries(summary.sourceHashes))
    if (sha256(await readFile(join(repository, path))) !== expected)
      throw new Error(`Source changed during evidence run: ${path}`)
  summary.sourcesUnchanged = true
  summary.cleanup = {
    verified: [...groups].every((group) => !alive(group)),
    ownedGroups: [...groups],
    remaining: [...groups].filter(alive),
  }
  if (!summary.cleanup.verified) throw new Error("Owned process group leaked")
  await json(join(output, "captures.json"), summary)
  console.log(`PASS: ${summary.captures.length} native captures; owned app process groups stopped`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = true
      for (const group of groups) if (alive(group)) process.kill(-group, "SIGTERM")
    })
  try {
    await main()
  } catch (error) {
    console.error(error.stack || error)
    process.exitCode = 1
    if (output) await json(join(output, "failure.json"), { error: String(error.stack || error) })
  } finally {
    await apps.quit("/Applications/Herdr.app/Contents/MacOS/Herdr").catch(() => {})
    const errors = []
    for (const group of groups) await stop(group).catch((error) => errors.push(error.message))
    if (output)
      await json(join(output, "cleanup.json"), {
        ownedGroups: [...groups],
        remaining: [...groups].filter(alive),
        errors,
        commandGroups: "command() waits for close and stops each owned CLI group before returning.",
      })
    if (errors.length) {
      console.error(errors.join("\n"))
      process.exitCode = 1
    }
  }
}
