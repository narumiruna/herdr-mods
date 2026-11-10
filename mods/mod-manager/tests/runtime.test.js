import { describe, expect, test, vi } from "vitest"

vi.mock("herdr", () => ({
  appHome: () => "/unused",
  exec: vi.fn(),
  layout: vi.fn(),
  panes: vi.fn(),
  readTextFile: vi.fn(),
}))

import { createIO } from "../runtime.js"

function fixture(overrides = {}) {
  const requests = []
  const programs = []
  const host = {
    root: () => "/fixture/app",
    layout: () => ({ type: "row", children: [{ hidden: true, content: { mod: "hidden-mod" } }] }),
    panes: () => [{ mod: "pane-mod" }],
    exec: vi.fn(async (program, args, options) => {
      programs.push({ program, args, options })
      if (program === "herdr-app") {
        return {
          code: 0,
          stdout: JSON.stringify({ errors: [], overlays: ["mod-dialog", "toast"] }),
          stderr: "",
        }
      }
      const request = JSON.parse(args.at(-1))
      requests.push(request)
      if (request.action === "prepare-update")
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            stageToken: "a".repeat(32),
            commit: request.targetCommit,
          }),
          stderr: "",
        }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          mods: [],
          warnings: [],
          ids: ["sample"],
          notice: "Verified files",
        }),
        stderr: "",
      }
    }),
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"schemaVersion":1,"mods":[]}',
    })),
    list: vi.fn(async () => []),
    read: vi.fn(async () => "{}"),
    exists: vi.fn(async () => false),
    ...overrides,
  }
  return { host, io: createIO(host), requests, programs }
}

describe("native runtime adapter", () => {
  test("does not call the host during construction", () => {
    const { host } = fixture()
    expect(host.exec).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  test("uses an offline optional helper with argument arrays and fresh dependencies", async () => {
    const { io, requests, programs } = fixture()
    const result = await io.operate({
      action: "update",
      id: "sample",
      targetCommit: "b".repeat(40),
      runtimeKnown: false,
      dependencies: [],
    })
    expect(result.message).toBe("Verified files")
    expect(requests[0]).toMatchObject({
      action: "prepare-update",
      id: "sample",
      runtimeKnown: true,
    })
    expect(requests[1]).toMatchObject({
      action: "update",
      id: "sample",
      stageToken: "a".repeat(32),
      targetCommit: "b".repeat(40),
      runtimeKnown: true,
    })
    expect(requests[0].dependencies).toEqual(["hidden-mod", "pane-mod", "mod-dialog", "toast"])
    expect(programs[1].program).toBe("uv")
    expect(programs[1].args.slice(0, 9)).toEqual([
      "run",
      "--no-project",
      "--offline",
      "--no-python-downloads",
      "python",
      "-I",
      "-S",
      "/fixture/app/mods/mod-manager/operations.py",
      "/fixture/app",
    ])
    expect(programs[1].options.timeout).toBeLessThanOrEqual(300_000)
  })

  test.each([
    { errors: ["broken mod"], overlays: [] },
    { errors: [], overlays: ["layout"] },
    { errors: [], overlays: [null] },
    { overlays: [] },
  ])("does not trust an incomplete runtime snapshot: %j", async (status) => {
    const { host, io, requests } = fixture()
    const original = host.exec.getMockImplementation()
    host.exec.mockImplementation((program, args, options) =>
      program === "herdr-app"
        ? Promise.resolve({ code: 0, stdout: JSON.stringify(status), stderr: "" })
        : original(program, args, options),
    )
    await io.operate({ action: "uninstall", runtimeKnown: true })
    expect(requests[0].runtimeKnown).toBe(false)
  })

  test("refreshes host dependencies after update staging, not before download only", async () => {
    const { host, io, requests } = fixture()
    let staged = false
    host.layout = () => ({ type: "block", content: { mod: staged ? "sample" : "other" } })
    const original = host.exec.getMockImplementation()
    host.exec.mockImplementation(async (program, args, options) => {
      const response = await original(program, args, options)
      if (program === "uv" && JSON.parse(args.at(-1)).action === "prepare-update") staged = true
      return response
    })
    await io.operate({ action: "update", id: "sample", targetCommit: "b".repeat(40) })
    expect(requests[0].dependencies).not.toContain("sample")
    expect(requests[1].dependencies).toContain("sample")
    expect(host.exec.mock.calls.filter(([program]) => program === "herdr-app")).toHaveLength(2)
  })

  test("reports helper and malformed-output failures without successful fallback for mutation", async () => {
    const { io, host } = fixture()
    host.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "offline Python unavailable" })
    await expect(io.operate({ action: "install" })).rejects.toThrow("offline Python unavailable")
    host.exec.mockResolvedValue({ code: 0, stdout: "not json", stderr: "" })
    await expect(io.operate({ action: "install" })).rejects.toThrow("invalid data")
    host.exec.mockResolvedValue({
      code: 0,
      stdout: '{"ok":false,"error":"Destination exists"}',
      stderr: "",
    })
    await expect(io.operate({ action: "install" })).rejects.toThrow("Destination exists")
  })

  test("keeps actual read-only inventory visible when optional tools are unavailable", async () => {
    const { io } = fixture({
      exec: vi.fn().mockRejectedValue(new Error("uv unavailable")),
      list: async () => [
        { name: "files", isDirectory: () => true },
        { name: "custom", isDirectory: () => true },
        { name: "mod-manager", isDirectory: () => false },
        { name: ".hidden", isDirectory: () => true },
      ],
      exists: async () => true,
      read: async (path) =>
        path.endsWith("installed.json")
          ? '{"files":{}}'
          : '{"title":"Actual local manifest","version":"1.0"}',
    })
    const result = await io.discover()
    expect(result.mods.map((mod) => mod.source)).toEqual(["shipped", "local", "development"])
    expect(result.mods.every((mod) => !mod.managed && mod.protectedReason)).toBe(true)
    expect(result.mods[0].name).toBe("Actual local manifest")
    expect(result.warnings.join(" ")).toContain("No tools are installed automatically")
  })

  test("does not turn a failed directory read into an empty successful list", async () => {
    const { io } = fixture({
      exec: vi.fn().mockRejectedValue(new Error()),
      list: async () => {
        throw new Error("Permission denied")
      },
    })
    await expect(io.discover()).rejects.toThrow("Permission denied")
  })

  test("rejects HTTP, malformed JSON and oversized Gallery responses", async () => {
    const { io, host } = fixture()
    expect(await io.fetchGallery()).toEqual({ schemaVersion: 1, mods: [] })
    expect(host.fetch).toHaveBeenCalledWith("https://assets.herdr.dev/mods/index.json")
    host.fetch.mockResolvedValue({ ok: false, status: 503 })
    await expect(io.fetchGallery()).rejects.toThrow("HTTP 503")
    host.fetch.mockResolvedValue({ ok: true, text: async () => "<html>not JSON</html>" })
    await expect(io.fetchGallery()).rejects.toThrow()
    host.fetch.mockResolvedValue({ ok: true, text: async () => "x".repeat(2_000_001) })
    await expect(io.fetchGallery()).rejects.toThrow("supported size")
  })

  test("does not dispatch unsupported operations", async () => {
    const { io, host } = fixture()
    await expect(io.operate({ action: "disable" })).rejects.toThrow("Unsupported")
    expect(host.exec).not.toHaveBeenCalled()
  })

  test("preserves migration summaries and dispatches only explicit migration", async () => {
    const { host, io, requests } = fixture()
    const original = host.exec.getMockImplementation()
    const migration = {
      required: true,
      blocked: false,
      token: "summary-1",
      targets: [
        {
          id: "sample",
          path: "/fixture/app/mods/sample",
          repository: "example/sample",
          kind: "git",
        },
      ],
    }
    host.exec.mockImplementation(async (program, args, options) => {
      const result = await original(program, args, options)
      if (program === "uv")
        result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), migration })
      return result
    })
    expect((await io.discover()).migration).toEqual(migration)
    expect(requests.map((request) => request.action)).toEqual(["discover"])
    await io.operate({ action: "migrate", migrationToken: "summary-1" })
    expect(requests.at(-1)).toMatchObject({ action: "migrate", migrationToken: "summary-1" })
  })

  test("uses the injected native wait and does not require browser timeout globals", async () => {
    const wait = vi.fn(async () => {})
    const { host } = fixture()
    const io = createIO(host, wait)
    await io.wait(15_000)
    expect(wait).toHaveBeenCalledWith(15_000)
    expect(host.exec).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  test("display theme text is not a mod dependency", async () => {
    const { io, requests } = fixture({
      layout: () => ({
        theme: { accent: "sample", name: "focus" },
        content: { mod: "actual-mod" },
      }),
      panes: () => [{ title: "sample", description: "focus" }],
    })
    await io.operate({ action: "uninstall", id: "sample" })
    expect(requests[0].dependencies).toContain("actual-mod")
    expect(requests[0].dependencies).not.toContain("sample")
    expect(requests[0].dependencies).not.toContain("focus")
  })

  test("missing uv reports no downloads and mutation never falls back to native writes", async () => {
    const { io, host } = fixture({ exec: vi.fn().mockRejectedValue(new Error("uv not found")) })
    await expect(io.operate({ action: "install", repository: "example/repo" })).rejects.toThrow(
      /No tools are installed automatically/,
    )
    expect(host.list).not.toHaveBeenCalled()
    const [, args] = host.exec.mock.calls.find(([command]) => command === "uv")
    expect(args).toEqual(
      expect.arrayContaining(["--no-project", "--offline", "--no-python-downloads", "-I", "-S"]),
    )
    expect(args).not.toContain("-c")
  })
})
