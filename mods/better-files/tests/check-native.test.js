import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runRequest } from "../reader/helper.mjs"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("../reader/helper.mjs", () => ({ runRequest: vi.fn() }))

const modRoot = fileURLToPath(new URL("..", import.meta.url))
const argv = process.argv
const program = process.platform === "win32" ? "herdr-app.exe" : "herdr-app"
const filesStates = [
  "empty",
  "tree",
  "preview",
  "error",
  "markdown",
  "markdown-remote",
  "markdown-back",
]
const readerStates = [
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

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("HERDR_APP_HOME", "/live-profile-must-not-be-used")
  process.argv = [process.execPath, join(modRoot, "scripts/check-native.mjs")]
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0 })
  vi.mocked(runRequest)
    .mockReset()
    .mockImplementation(async (request) => {
      const data = JSON.parse(readFileSync(request, "utf8"))
      return {
        version: 1,
        job: "native-fixture",
        file: data.file,
        root: data.root,
        source: "# Fixture",
        signature: "fixture",
        blocks: [{ id: "text", type: "html", html: "<h1>Fixture</h1>" }],
        links: {},
        anchors: {},
        assets: [],
      }
    })
})
afterEach(() => {
  process.argv = argv
  vi.unstubAllEnvs()
})

function isolatedCalls() {
  for (const [, args, options] of vi.mocked(spawnSync).mock.calls) {
    expect(isAbsolute(args.at(-1))).toBe(true)
    expect(options).toEqual({
      stdio: "inherit",
      timeout: 300000,
      env: expect.objectContaining({ HERDR_APP_HOME: expect.any(String) }),
    })
    expect(options.env.HERDR_APP_HOME).not.toBe(process.env.HERDR_APP_HOME)
    expect(existsSync(options.env.HERDR_APP_HOME)).toBe(false)
  }
}

describe("native Files checks", () => {
  it("checks the root, seven Files states, and the embedded reader script with explicit paths", async () => {
    const states = []
    vi.mocked(spawnSync).mockImplementation((_program, args) => {
      if (args[0] === "check" && args[1] !== modRoot) {
        const source = readFileSync(join(args[1], "main.js"), "utf8")
        states.push(/const state = "([^"]+)"/.exec(source)[1])
        expect(source).toContain('import Files from "./files-view.js"')
        expect(readFileSync(join(args[1], "reader/reader-view.js"), "utf8")).toBe(
          readFileSync(join(modRoot, "reader/main.js"), "utf8"),
        )
        expect(existsSync(join(args[1], "reader/node.js"))).toBe(true)
      }
      return { status: 0 }
    })
    await import("../scripts/check-native.mjs")
    const calls = vi.mocked(spawnSync).mock.calls
    expect(calls).toHaveLength(9)
    expect(calls[0].slice(0, 2)).toEqual([program, ["check", modRoot]])
    expect(states).toEqual(filesStates)
    expect(calls.at(-1).slice(0, 2)).toEqual([
      process.execPath,
      [join(modRoot, "scripts/check-reader-views.mjs")],
    ])
    expect(new Set(calls.map(([, , options]) => options.env.HERDR_APP_HOME)).size).toBe(1)
    isolatedCalls()
  })

  it("skips only the root entry for --views", async () => {
    process.argv.push("--views")
    await import("../scripts/check-native.mjs")
    expect(spawnSync).toHaveBeenCalledTimes(8)
    expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args[1] === modRoot)).toBe(false)
    expect(vi.mocked(spawnSync).mock.calls.at(-1)[1]).toEqual([
      join(modRoot, "scripts/check-reader-views.mjs"),
    ])
    isolatedCalls()
  })

  it.each([0, 4, 8])("removes its disposable profile when check %s fails", async (index) => {
    for (let i = 0; i < index; i++) vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 })
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 })
    await expect(import("../scripts/check-native.mjs")).rejects.toThrow(
      "Native Better Files check failed",
    )
    expect(spawnSync).toHaveBeenCalledTimes(index + 1)
    isolatedCalls()
  })

  it("preserves launch errors and removes its disposable profile", async () => {
    const failure = new Error("Fixture launch error")
    vi.mocked(spawnSync).mockReturnValueOnce({ error: failure, status: null })
    await expect(import("../scripts/check-native.mjs")).rejects.toBe(failure)
    expect(spawnSync).toHaveBeenCalledOnce()
    isolatedCalls()
  })
})

describe("embedded reader native fixtures", () => {
  it("renders all reader states in a separate profile without relying on cwd", async () => {
    const states = []
    vi.mocked(spawnSync).mockImplementation((actualProgram, args) => {
      expect(actualProgram).toBe(program)
      const source = readFileSync(join(args[1], "main.js"), "utf8")
      states.push(/const state = "([^"]+)"/.exec(source)[1])
      expect(source).toContain('import Reader from "./reader/main.js"')
      expect(source).toContain("cx.new(EmbeddedReader, {})")
      expect(source).toContain("await this.readerView?.close()")
      expect(source).toContain("finally { this.reader.release() }")
      expect(source).toContain("Missing entry must fail without an Open form")
      expect(source).toContain('validateManifest({...manifest,assets:["../unsafe.svg"]})')
      for (const name of ["main.js", "runtime.js", "model.js", "node.js"])
        expect(readFileSync(join(args[1], "reader", name), "utf8")).toBe(
          readFileSync(join(modRoot, "reader", name), "utf8"),
        )
      return { status: 0 }
    })
    const { checkReaderViews } = await import("../scripts/check-reader-views.mjs")
    expect(spawnSync).not.toHaveBeenCalled()
    await checkReaderViews()
    expect(states).toEqual(readerStates)
    const request = vi.mocked(runRequest).mock.calls[0][0]
    expect(request).toContain(join("data", "better-files", "requests", "native-fixture.json"))
    expect(existsSync(request)).toBe(false)
    const data = await vi.mocked(runRequest).mock.results[0].value
    expect(data.file).toBe(join(modRoot, "fixtures/reader.md"))
    expect(data.root).toBe(join(modRoot, "fixtures"))
    isolatedCalls()
  })

  it.each(["status", "launch"])("cleans up when a reader check fails: %s", async (kind) => {
    const failure = new Error("Launch failed")
    vi.mocked(spawnSync).mockReturnValueOnce(
      kind === "launch" ? { error: failure, status: null } : { status: 1 },
    )
    const { checkReaderViews } = await import("../scripts/check-reader-views.mjs")
    await expect(checkReaderViews()).rejects.toThrow(
      kind === "launch" ? "Launch failed" : "Native reader fixture failed: missing-entry",
    )
    expect(spawnSync).toHaveBeenCalledOnce()
    isolatedCalls()
  })

  it.each(["helper", "nested renderer", "unsafe asset"])(
    "cleans up before checking a failed manifest: %s",
    async (kind) => {
      let request
      const normal = vi.mocked(runRequest).getMockImplementation()
      vi.mocked(runRequest).mockImplementationOnce(async (path) => {
        request = path
        if (kind === "helper") throw new Error("Helper failed")
        const manifest = await normal(path)
        if (kind === "unsafe asset") manifest.assets = ["../unsafe.svg"]
        else
          manifest.blocks = [
            {
              id: "quote",
              type: "container",
              children: [
                { id: "error", type: "error", source: "broken", error: "Renderer failed" },
              ],
            },
          ]
        return manifest
      })
      const { checkReaderViews } = await import("../scripts/check-reader-views.mjs")
      await expect(checkReaderViews()).rejects.toThrow(
        kind === "helper"
          ? "Helper failed"
          : kind === "unsafe asset"
            ? "unsafe asset path"
            : "Native fixture renderer failed",
      )
      expect(spawnSync).not.toHaveBeenCalled()
      expect(existsSync(request)).toBe(false)
    },
  )
})
