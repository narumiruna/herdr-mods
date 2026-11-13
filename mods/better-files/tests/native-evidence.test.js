import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", async (original) => ({ ...(await original()), spawn }))

let command
let waitForStatus
let realSpawn
let importListeners
let kill
let owned
const env = { HERDR_APP_HOME: "/tmp/better-files-native-test/profile" }
const socket = `${env.HERDR_APP_HOME}/herdr-app.sock`
const ready = { stdout: '{"errors":[],"layout":"better-files-evidence-light"}', stderr: "" }
const connectionError = (reason = "No such file or directory (os error 2)") =>
  Object.assign(new Error("status connection failure"), {
    exitCode: 2,
    signal: null,
    stdout: "",
    stderr: `herdr-app: no Herdr window at ${socket}: ${reason}\n`,
  })
const childProcess = (pid = 123456) =>
  Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })

beforeAll(async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  ;({ command, waitForStatus } = await import("../scripts/native-evidence.mjs"))
  importListeners = {
    before,
    after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    spawns: spawn.mock.calls.length,
  }
  realSpawn = (await vi.importActual("node:child_process")).spawn
})
beforeEach(() => {
  vi.useFakeTimers()
  spawn.mockReset()
  owned = new Set()
  kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (!owned.has(-pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" })
    if (signal !== 0) owned.delete(-pid)
    return true
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("imports without starting processes or registering signal cleanup", () => {
  expect(importListeners.after).toEqual(importListeners.before)
  expect(importListeners.spawns).toBe(0)
  expect(kill).not.toHaveBeenCalled()
})

describe("command completion and owned process cleanup", () => {
  it("waits for close and captures both streams after exit", async () => {
    const child = childProcess()
    spawn.mockReturnValue(child)
    owned.add(child.pid)
    let settled = false
    const work = command("fixture", ["status"], env).then((result) => {
      settled = true
      return result
    })
    child.stdout.emit("data", '{"errors":')
    child.emit("exit", 0, null)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    child.stdout.emit("data", "[]}")
    child.stderr.emit("data", "late diagnostic\n")
    child.emit("close", 0, null)
    await expect(work).resolves.toEqual({ stdout: '{"errors":[]}', stderr: "late diagnostic\n" })
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM")
    expect(owned.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(spawn).toHaveBeenCalledWith("fixture", ["status"], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  })

  it("includes late stderr and exit details in nonzero command errors", async () => {
    const child = childProcess()
    spawn.mockReturnValue(child)
    const work = command("fixture", ["status"], env)
    const rejected = expect(work).rejects.toMatchObject({
      exitCode: 2,
      signal: null,
      stdout: "",
      stderr: "late failure\n",
      message: "fixture status: late failure\n",
    })
    child.emit("exit", 2, null)
    await Promise.resolve()
    child.stderr.emit("data", "late failure\n")
    child.emit("close", 2, null)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves spawn errors and clears the command timer", async () => {
    const child = childProcess(undefined)
    child.pid = undefined
    spawn.mockReturnValue(child)
    const error = Object.assign(new Error("spawn fixture ENOENT"), { code: "ENOENT" })
    const work = command("fixture", [], env, 100)
    const rejected = expect(work).rejects.toBe(error)
    child.emit("error", error)
    child.emit("close", -2, null)
    await rejected
    await vi.advanceTimersByTimeAsync(200)
    expect(kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("times out even if exit preceded close, and kills only its owned group", async () => {
    const child = childProcess()
    spawn.mockReturnValue(child)
    owned.add(child.pid)
    const work = command("fixture", [], env, 100)
    const rejected = expect(work).rejects.toMatchObject({ code: "ETIMEDOUT" })
    child.emit("exit", 0, null)
    await vi.advanceTimersByTimeAsync(100)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    child.emit("close", 0, null)
    await rejected
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL")
    expect(kill.mock.calls.every(([pid]) => pid === -child.pid)).toBe(true)
    expect(owned.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds waiting for close even if the group has already exited", async () => {
    const child = childProcess()
    spawn.mockReturnValue(child)
    const work = command("fixture", [], env, 100)
    const rejected = expect(work).rejects.toMatchObject({ code: "ETIMEDOUT" })
    child.emit("exit", 0, null)
    await vi.advanceTimersByTimeAsync(100)
    child.emit("close", 0, null)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it("drains a real Node command and preserves real spawn errors", async () => {
    vi.useRealTimers()
    kill.mockRestore()
    spawn.mockImplementation(realSpawn)
    await expect(
      command(
        process.execPath,
        ["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
        {},
      ),
    ).resolves.toEqual({ stdout: "out", stderr: "err" })
    await expect(
      command("/__better_files_native_evidence_missing__", [], {}),
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("kills a real timed-out Node process group", async () => {
    vi.useRealTimers()
    kill.mockRestore()
    let pid
    spawn.mockImplementation((...args) => {
      const child = realSpawn(...args)
      pid = child.pid
      return child
    })
    await expect(
      command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, 200),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
  })
})

describe("bounded startup status", () => {
  let child
  let run
  const wait = (timeout = 1000) => waitForStatus("fixture", env, child, "light", { timeout, run })
  beforeEach(() => {
    child = childProcess()
    owned.add(child.pid)
    run = vi.fn().mockResolvedValue(ready)
  })

  it("uses the first ready response without a fixed startup delay", async () => {
    await expect(wait()).resolves.toEqual(JSON.parse(ready.stdout))
    expect(run).toHaveBeenCalledExactlyOnceWith("fixture", ["status"], env, 1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retries only the verified missing and refused owned-socket errors", async () => {
    run
      .mockRejectedValueOnce(connectionError())
      .mockRejectedValueOnce(connectionError("Connection refused (os error 61)"))
    const work = wait()
    await vi.advanceTimersByTimeAsync(200)
    await expect(work).resolves.toEqual(JSON.parse(ready.stdout))
    expect(run.mock.calls.map((args) => args[3])).toEqual([1000, 900, 800])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [
      "permission",
      { stderr: `herdr-app: no Herdr window at ${socket}: Permission denied (os error 13)\n` },
    ],
    [
      "other socket",
      {
        stderr:
          "herdr-app: no Herdr window at /tmp/other/herdr-app.sock: No such file or directory (os error 2)\n",
      },
    ],
    ["extra stderr", { stderr: `${connectionError().stderr}unexpected failure\n` }],
    ["stdout", { stdout: "invalid status" }],
    ["other exit code", { exitCode: 1 }],
    ["signal", { signal: "SIGTERM" }],
    ["timeout", { code: "ETIMEDOUT" }],
    ["spawn failure", { code: "ENOENT", exitCode: undefined }],
  ])("does not retry a %s failure", async (_name, change) => {
    const error = Object.assign(connectionError(), change)
    run.mockRejectedValue(error)
    await expect(wait()).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not retry a generic connection-looking error without command details", async () => {
    const error = new Error(connectionError().stderr)
    run.mockRejectedValue(error)
    await expect(wait()).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("fails immediately on malformed JSON", async () => {
    run.mockResolvedValue({ stdout: "{", stderr: "" })
    await expect(wait()).rejects.toBeInstanceOf(SyntaxError)
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([null, {}, { errors: "not an array" }, { errors: ["runtime failure"] }])(
    "fails immediately on malformed or failed status %j",
    async (status) => {
      run.mockResolvedValue({ stdout: JSON.stringify(status), stderr: "" })
      await expect(wait()).rejects.toThrow("Native runtime errors in light")
      expect(run).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(["exitCode", "signalCode", "missing group"])("detects app exit: %s", async (kind) => {
    if (kind === "missing group") owned.delete(child.pid)
    else child[kind] = kind === "exitCode" ? 0 : "SIGTERM"
    await expect(wait()).rejects.toThrow("App exited in mode light")
    expect(run).not.toHaveBeenCalled()
  })

  it("detects a leader exit during a request even if its group remains alive", async () => {
    run.mockImplementation(async () => {
      child.exitCode = 1
      throw connectionError()
    })
    await expect(wait()).rejects.toThrow("App exited in mode light")
    expect(run).toHaveBeenCalledOnce()
    expect(owned.has(child.pid)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("detects app exit between connection retries", async () => {
    run.mockRejectedValue(connectionError())
    const work = wait()
    const rejected = expect(work).rejects.toThrow("App exited in mode light")
    await vi.advanceTimersByTimeAsync(50)
    child.signalCode = "SIGTERM"
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects a status response if the owned app exited during the request", async () => {
    run.mockImplementation(async () => {
      child.exitCode = 0
      return ready
    })
    await expect(wait()).rejects.toThrow("App exited in mode light")
    expect(run).toHaveBeenCalledOnce()
  })

  it("stops at the deadline with shrinking command budgets and the last failure", async () => {
    const error = connectionError()
    run.mockRejectedValue(error)
    const work = wait(250)
    const rejected = expect(work).rejects.toMatchObject({
      message: "App status startup deadline exceeded in mode light",
      cause: error,
    })
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(run.mock.calls.map((args) => args[3])).toEqual([250, 150, 50])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not accept a response that arrives after the deadline", async () => {
    run.mockImplementation(() => new Promise((done) => setTimeout(() => done(ready), 250)))
    const work = wait(250)
    const rejected = expect(work).rejects.toThrow("startup deadline exceeded")
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
