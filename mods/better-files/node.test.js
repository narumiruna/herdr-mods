import { describe, expect, it, vi } from "vitest"
import { createNodeRunner } from "./reader/node.js"

const missing = () => new Error("herdr.exec: cannot run node: program not found")
const metadata = { path: "C:\\Tools\\node.exe", major: 26 }
const found = () => ({ code: 0, stdout: JSON.stringify(metadata), stderr: "" })
const rendered = { code: 0, stdout: '{"blocks":[]}', stderr: "" }

describe("Node helper launcher", () => {
  it("keeps an available Node command and its argument array unchanged", async () => {
    const exec = vi.fn().mockResolvedValue(rendered)
    const run = createNodeRunner(exec, "windows")
    const args = ["helper.mjs", "request with spaces.json"]
    const options = { timeout: 90000 }
    expect(await run(args, options)).toBe(rendered)
    expect(exec).toHaveBeenCalledExactlyOnceWith("node", args, options)
  })

  it("resolves installed Windows Node after the app reports it missing", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(found())
      .mockResolvedValue(rendered)
    const run = createNodeRunner(exec, "windows")
    const args = ["--max-old-space-size=256", "helper.mjs", "文書 'quote'.json"]
    expect(await run(args, { timeout: 90000 })).toBe(rendered)
    expect(exec.mock.calls[1][0]).toBe("powershell")
    expect(exec.mock.calls[1][1].slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"])
    const script = exec.mock.calls[1][1][3]
    expect(script).toContain("GetEnvironmentVariable('Path', 'User')")
    expect(script).toContain("GetEnvironmentVariable('FNM_DIR', 'User')")
    expect(script).toContain("exec --using=26 -- node")
    expect(script).not.toContain(args[2])
    expect(exec.mock.calls[2]).toEqual([metadata.path, args, { timeout: 90000 }])
    await run(["helper.mjs", "--cancel", "request.json"], { timeout: 2000 })
    expect(exec).toHaveBeenCalledTimes(4)
    expect(exec.mock.calls[3]).toEqual([
      metadata.path,
      ["helper.mjs", "--cancel", "request.json"],
      { timeout: 2000 },
    ])
  })

  it("shares discovery when render and cancel both encounter missing Node", async () => {
    const exec = vi.fn(async (program) => {
      if (program === "node") throw missing()
      return program === "powershell" ? found() : rendered
    })
    const run = createNodeRunner(exec, "windows")
    await Promise.all([run(["render"], {}), run(["cancel"], {})])
    expect(exec.mock.calls.filter(([program]) => program === "powershell")).toHaveLength(1)
    expect(exec.mock.calls.filter(([program]) => program === metadata.path)).toHaveLength(2)
  })

  it.each(["linux", "macos"])("does not use Windows discovery on %s", async (platform) => {
    const exec = vi.fn().mockRejectedValue(missing())
    await expect(createNodeRunner(exec, platform)([], {})).rejects.toThrow("program not found")
    expect(exec).toHaveBeenCalledOnce()
  })

  it("does not mask other launch errors or helper exit codes", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("permission denied"))
    const run = createNodeRunner(exec, "windows")
    await expect(run([], {})).rejects.toThrow("permission denied")
    const failure = { code: 1, stdout: "", stderr: "rendering failed" }
    exec.mockResolvedValue(failure)
    expect(await run([], {})).toBe(failure)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it.each([
    { path: "relative/node.exe", major: 26 },
    { path: "C:\\Tools\\other.exe", major: 26 },
    { path: metadata.path, major: 25 },
    { path: metadata.path, major: "26" },
  ])("rejects invalid Node discovery metadata: %j", async (value) => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValue({
        code: 0,
        stdout: JSON.stringify(value),
        stderr: "",
      })
    await expect(createNodeRunner(exec, "windows")([], {})).rejects.toThrow("absolute Node.js 26")
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it("reports discovery failure and retries on a later Reload", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Node is unavailable" })
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce(rendered)
    const run = createNodeRunner(exec, "windows")
    await expect(run([], {})).rejects.toThrow("Node is unavailable")
    expect(await run([], {})).toBe(rendered)
  })
})
