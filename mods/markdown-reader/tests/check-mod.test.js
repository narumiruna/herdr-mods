import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { beforeEach, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0 })
})

it("checks the reader entry and views with a disposable profile, then removes it", async () => {
  await import("../scripts/check-mod.mjs")
  expect(spawnSync).toHaveBeenCalledTimes(2)
  const calls = vi.mocked(spawnSync).mock.calls
  const home = calls[0][2].env.HERDR_APP_HOME
  expect(home).toEqual(expect.any(String))
  expect(home).not.toBe(process.env.HERDR_APP_HOME)
  expect(existsSync(home)).toBe(false)
  expect(calls.map(([program, args]) => [program, args])).toEqual([
    ["herdr-app", ["check", "."]],
    [process.execPath, ["scripts/check-views.mjs"]],
  ])
  for (const [, , options] of calls) {
    const { env, ...execution } = options
    expect(execution).toEqual({ stdio: "inherit", timeout: 300000 })
    expect(env.HERDR_APP_HOME).toBe(home)
  }
})

it.each([0, 1])("removes the disposable profile after check %s fails", async (index) => {
  if (index) vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 })
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 })
  await expect(import("../scripts/check-mod.mjs")).rejects.toThrow("Native check failed")
  expect(spawnSync).toHaveBeenCalledTimes(index + 1)
  expect(existsSync(vi.mocked(spawnSync).mock.calls[0][2].env.HERDR_APP_HOME)).toBe(false)
})

it("removes the disposable profile after a launch error", async () => {
  const failure = new Error("Fixture launch error")
  vi.mocked(spawnSync).mockReturnValueOnce({ error: failure, status: null })
  await expect(import("../scripts/check-mod.mjs")).rejects.toBe(failure)
  expect(spawnSync).toHaveBeenCalledTimes(1)
  expect(existsSync(vi.mocked(spawnSync).mock.calls[0][2].env.HERDR_APP_HOME)).toBe(false)
})
