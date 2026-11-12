import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { captureGenerator, createAppOwner, offlineProgram, pngInfo } from "./native-previews.mjs"

for (const name of ["github-issues-prs", "layout-manager", "mod-manager"]) {
  test(`${name}: saves trusted fixtures without starting the native app`, async () => {
    const source = await readFile(
      new URL(`../mods/${name}/scripts/check-views.mjs`, import.meta.url),
      "utf8",
    )
    const transformed = captureGenerator(
      source,
      name,
      "/tmp/owned-fixtures",
      "/tmp/owned-generator-temp",
    )
    assert.ok(transformed.includes('import { cpSync as saveFixture } from "node:fs"'))
    assert.ok(transformed.includes('const tmpdir = () => "/tmp/owned-generator-temp"'))
    assert.ok(transformed.includes('saveFixture(directory, "/tmp/owned-fixtures"'))
    assert.ok(transformed.includes("rmSync(directory, { recursive: true, force: true })"))
    assert.ok(!transformed.includes("spawnSync"))
    assert.throws(
      () => captureGenerator(source.replaceAll("spawnSync", "changed"), name, "/tmp/x", "/tmp/y"),
      /Fixture source changed/,
    )
  })
}

test("offline shim retains the reviewed handshake and fail-closed protocol", async () => {
  const source = await readFile(
    new URL("../mods/markdown-reader/scripts/native-evidence.mjs", import.meta.url),
    "utf8",
  )
  const program = offlineProgram(source)
  for (const value of [
    'request.method !== "hello"',
    "generation: 1",
    "framed: true",
    "rpc.discover",
    "Oversized core frame",
    "Offline fixture denies this method",
    'process.stdin.on("end"',
  ])
    assert.ok(program.includes(value), value)
  assert.ok(!program.includes("function alive("))
  assert.throws(() => offlineProgram("changed source"), /offline-core source changed/)
})

test("failed spawn listens before the pid check and cannot dispatch cleanup", async (t) => {
  const child = new EventEmitter()
  Object.defineProperty(child, "pid", {
    get() {
      assert.equal(child.listenerCount("error"), 1)
      return undefined
    },
  })
  const diagnostic = t.mock.method(console, "error", () => {})
  const run = t.mock.fn(async () => {})
  t.mock.method(process, "kill", () => assert.fail("Unexpected native process access"))
  const owner = createAppOwner({
    start: () => {
      queueMicrotask(() => child.emit("error", new Error("mock spawn ENOENT")))
      return child
    },
    run,
  })
  const env = { HOME: "/mock/home", HERDR_APP_HOME: "/mock/profile" }
  assert.throws(() => owner.start("/mock/Herdr", env, 99), /App did not start/)
  // The child emits while the caller can be closing the log or writing failure data.
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(
    diagnostic.mock.calls.map((call) => call.arguments),
    [["mock spawn ENOENT"]],
  )
  assert.equal(owner.groups.size, 0)
  await owner.quit("/mock/Herdr")
  assert.equal(run.mock.callCount(), 0)
})

for (const failure of ["no pid", "throw"]) {
  test(`failed launch clears earlier active ownership: ${failure}`, async (t) => {
    const child = Object.assign(new EventEmitter(), { pid: 4321 })
    const run = t.mock.fn(async () => {})
    t.mock.method(process, "kill", () => assert.fail("Unexpected native process access"))
    let launches = 0
    const owner = createAppOwner({
      start: () => {
        if (++launches === 1) return child
        if (failure === "throw") throw new Error("mock spawn failed")
        return new EventEmitter()
      },
      run,
    })
    const env = { HOME: "/mock/home", HERDR_APP_HOME: "/mock/profile" }
    owner.start("/mock/Herdr", env, 99)
    assert.throws(() => owner.start("/mock/Herdr", env, 99), /App did not start|mock spawn failed/)
    await owner.quit("/mock/Herdr")
    assert.equal(run.mock.callCount(), 0)
    // Keep earlier owned groups available for the final group shutdown pass.
    assert.deepEqual([...owner.groups], [4321])
  })
}

test("cleanup without an owned pid or isolated environment cannot send app.quit", async (t) => {
  const start = t.mock.fn(() => Object.assign(new EventEmitter(), { pid: 4321 }))
  const run = t.mock.fn(async () => {})
  t.mock.method(process, "kill", () => assert.fail("Unexpected native process access"))
  const owner = createAppOwner({ start, run })
  await owner.quit("/mock/Herdr")
  for (const env of [undefined, {}, { HOME: "/mock/home" }, { HERDR_APP_HOME: "/mock/profile" }]) {
    assert.throws(() => owner.start("/mock/Herdr", env, 99), /requires an isolated environment/)
    await owner.quit("/mock/Herdr")
  }
  assert.equal(start.mock.callCount(), 0)
  assert.equal(run.mock.callCount(), 0)
  for (const key of ["HOME", "HERDR_APP_HOME"]) {
    const env = { HOME: "/mock/home", HERDR_APP_HOME: "/mock/profile" }
    owner.start("/mock/Herdr", env, 99)
    delete env[key]
    await owner.quit("/mock/Herdr")
  }
  assert.equal(run.mock.callCount(), 0)
})

for (const quitFails of [false, true]) {
  test(`owned app shutdown stops its process group when app.quit ${quitFails ? "fails" : "succeeds"}`, async (t) => {
    const pid = 4321
    const child = Object.assign(new EventEmitter(), { pid })
    const env = { HOME: "/mock/home", HERDR_APP_HOME: "/mock/profile" }
    const start = t.mock.fn(() => child)
    const run = t.mock.fn(async () => {
      if (quitFails) throw new Error("mock quit failure")
    })
    let running = true
    const kill = t.mock.method(process, "kill", (target, signal) => {
      assert.equal(target, -pid)
      if (!running) throw Object.assign(new Error("mock ESRCH"), { code: "ESRCH" })
      if (signal === "SIGTERM") running = false
      else assert.equal(signal, 0)
      return true
    })
    t.mock.method(globalThis, "setTimeout", (done) => {
      queueMicrotask(done)
      return 0
    })
    const owner = createAppOwner({ start, run })
    assert.equal(owner.start("/mock/Herdr", env, 99), child)
    assert.deepEqual(start.mock.calls[0].arguments, [
      "/mock/Herdr",
      [],
      { env, detached: true, stdio: ["ignore", 99, 99] },
    ])
    await owner.quit("/mock/Herdr")
    assert.deepEqual(
      run.mock.calls.map((call) => call.arguments),
      [["/mock/Herdr", ["do", "app.quit"], env, 3000]],
    )
    assert.ok(kill.mock.calls.some((call) => call.arguments[1] === "SIGTERM"))
    assert.equal(running, false)
    assert.deepEqual([...owner.groups], [pid])
    const probes = kill.mock.callCount()
    await owner.quit("/mock/Herdr")
    assert.equal(run.mock.callCount(), 1)
    assert.equal(kill.mock.callCount(), probes)
  })
}

test("rejects invalid and zero-sized native PNG headers", () => {
  assert.throws(() => pngInfo(Buffer.from("not an image")), /not a PNG/)
  // Binary header only, never a preview image or appearance evidence.
  const header = Buffer.alloc(33)
  Buffer.from("89504e470d0a1a0a", "hex").copy(header)
  header.write("IHDR", 12)
  assert.throws(() => pngInfo(header), /Empty native capture/)
  header.writeUInt32BE(1200, 16)
  header.writeUInt32BE(950, 20)
  assert.deepEqual(
    Object.fromEntries(Object.entries(pngInfo(header)).filter(([key]) => key !== "sha256")),
    { width: 1200, height: 950, bytes: 33 },
  )
})
