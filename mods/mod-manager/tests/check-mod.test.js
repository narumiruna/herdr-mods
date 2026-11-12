import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { beforeEach, expect, test, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0 })
})

test("check:mod runs the entry check and all native view checks in order", async () => {
  await import("../scripts/check-mod.mjs")
  const [program, args, options] = spawnSync.mock.calls[0]
  expect(program).toBe("herdr-app")
  expect(args).toEqual(["check", "."])
  expect(options.stdio).toBe("inherit")
  expect(options.timeout).toBe(300_000)
  // Never compare or print inherited environment values in assertion failures.
  const home = options.env.HERDR_APP_HOME
  expect(typeof home).toBe("string")
  expect(home).not.toBe(process.env.HERDR_APP_HOME)
  expect(existsSync(home)).toBe(false)
  expect(spawnSync).toHaveBeenNthCalledWith(2, process.execPath, ["scripts/check-views.mjs"], {
    stdio: "inherit",
    timeout: 300_000,
  })
  expect(spawnSync).toHaveBeenCalledTimes(2)
})

test("an entry failure stops before the view checks", async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 })
  await expect(import("../scripts/check-mod.mjs")).rejects.toThrow(
    "Native check failed: herdr-app check .",
  )
  expect(spawnSync).toHaveBeenCalledTimes(1)
  expect(existsSync(spawnSync.mock.calls[0][2].env.HERDR_APP_HOME)).toBe(false)
})

test("a native view failure fails the combined check", async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 })
  await expect(import("../scripts/check-mod.mjs")).rejects.toThrow("scripts/check-views.mjs")
  expect(spawnSync).toHaveBeenCalledTimes(2)
  expect(existsSync(spawnSync.mock.calls[0][2].env.HERDR_APP_HOME)).toBe(false)
})

test("a launch error is reported without running another check", async () => {
  const failure = new Error("Fixture launch failure")
  vi.mocked(spawnSync).mockReturnValueOnce({ error: failure, status: null })
  await expect(import("../scripts/check-mod.mjs")).rejects.toBe(failure)
  expect(spawnSync).toHaveBeenCalledTimes(1)
  expect(existsSync(spawnSync.mock.calls[0][2].env.HERDR_APP_HOME)).toBe(false)
})
