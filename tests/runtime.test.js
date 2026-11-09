import { expect, test, vi } from "vitest"
import { createRuntime } from "../runtime.js"

function runtime(exec) {
  return createRuntime({ home: "/unused-test-home", exec, read: vi.fn(), write: vi.fn() })
}

test("reports missing tools without installing or downloading them", async () => {
  const exec = vi.fn().mockRejectedValue(new Error("uv not found"))
  await expect(runtime(exec).list()).rejects.toThrow("requires Git, uv, and Python 3")
  expect(exec).toHaveBeenCalledTimes(1)
  const [command, args] = exec.mock.calls[0]
  expect(command).toBe("uv")
  expect(args).toEqual(
    expect.arrayContaining(["--no-project", "--offline", "--no-python-downloads", "-I", "-S"]),
  )
})

test("reports interpreter startup failures", async () => {
  const exec = vi.fn().mockResolvedValue({ code: 2, stdout: "", stderr: "Python is not installed" })
  await expect(runtime(exec).list()).rejects.toThrow("Python is not installed")
})

test("preserves helper failures and does not use an unsafe fallback", async () => {
  const exec = vi.fn().mockResolvedValue({
    code: 1,
    stdout: JSON.stringify({ ok: false, error: "Atomic no-clobber rename is unavailable" }),
    stderr: "",
  })
  await expect(runtime(exec).publish("stage", "destination")).rejects.toThrow("Atomic no-clobber")
  expect(exec).toHaveBeenCalledTimes(1)
})

test("passes paths and Git arguments as JSON data, not executable source", async () => {
  const value = { code: 128, stdout: "", stderr: "Network unavailable" }
  const exec = vi
    .fn()
    .mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, value }), stderr: "" })
  const args = ["show", 'a path with quotes"; $(do-not-run)']
  expect(await runtime(exec).git("/path with spaces", args)).toEqual(value)
  const request = JSON.parse(exec.mock.calls[0][1].at(-1))
  expect(request).toEqual({
    root: "/unused-test-home",
    action: "git",
    args: ["/path with spaces", args],
  })
  expect(exec.mock.calls[0][1].at(-2)).not.toContain(args[1])
})
