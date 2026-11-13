// biome-ignore lint/style/useNodejsImportProtocol: Match the Herdr host module used by the adapter.
import * as fs from "fs/promises"
import { exec } from "herdr"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createIO } from "./reader/runtime.js"

vi.mock("crypto", () => ({ randomUUID: () => "reader-job-0001" }))
vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}))
vi.mock("herdr", () => ({
  appHome: () => "/test profile",
  exec: vi.fn(),
  window: () => ({ platform: "linux" }),
}))

const base = "/test profile/data/better-files"
const helper = "/test profile/mods/better-files/reader/helper.mjs"
const request = { job: "reader-job-0001", path: `${base}/requests/reader-job-0001.json` }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(exec).mockResolvedValue({ code: 0, stdout: "{}", stderr: "" })
})

describe("bundled reader host I/O", () => {
  it("writes requests only in the Better Files namespace", async () => {
    const entry = { file: "/workspace/中文 guide.md", root: "/workspace", on: null }
    const options = { width: 720, dark: true }
    expect(await createIO().request(entry, options)).toEqual(request)
    expect(fs.mkdir).toHaveBeenCalledTimes(2)
    expect(fs.mkdir).toHaveBeenCalledWith(`${base}/requests`, { recursive: true })
    expect(fs.mkdir).toHaveBeenCalledWith(`${base}/leases`, { recursive: true })
    expect(fs.writeFile).toHaveBeenCalledExactlyOnceWith(
      request.path,
      JSON.stringify({ ...entry, ...options, appHome: "/test profile" }),
    )
  })

  it("renders with the helper in this mod root and keeps its resource budgets", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '{"version":1}', stderr: "" })
    expect(await createIO().render(request)).toEqual({ version: 1 })
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "node",
      ["--max-old-space-size=256", helper, request.path],
      { timeout: 90000 },
    )
  })

  it("cancels through the same bundled helper", async () => {
    await createIO().cancel(request)
    expect(exec).toHaveBeenCalledExactlyOnceWith("node", [helper, "--cancel", request.path], {
      timeout: 2000,
    })
  })

  it("renews and releases only this reader's new-namespace lease and request files", async () => {
    const io = createIO()
    const asset = `data/better-files/assets/${"a".repeat(64)}.svg`
    const now = vi.spyOn(Date, "now").mockReturnValue(1000)
    try {
      await io.renew(request, [asset])
      expect(fs.writeFile).toHaveBeenCalledExactlyOnceWith(
        `${base}/leases/${request.job}.json`,
        JSON.stringify({ expires: 61000, assets: [asset.split("/").pop()] }),
      )
      await io.release(request)
      expect(vi.mocked(fs.unlink).mock.calls.map(([path]) => path)).toEqual([
        request.path,
        `${request.path}.cancel`,
        `${base}/leases/${request.job}.json`,
      ])
    } finally {
      now.mockRestore()
    }
  })

  it("continues cleanup if a temporary file is already missing", async () => {
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("Already removed"))
    await expect(createIO().release(request)).resolves.toBeUndefined()
    expect(fs.unlink).toHaveBeenCalledTimes(3)
  })

  it("reports helper failure without falling back to a companion", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 1, stdout: "", stderr: " Render failed\n" })
    await expect(createIO().render(request)).rejects.toThrow("Render failed")
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("reports cancellation failure", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 1, stdout: "", stderr: "" })
    await expect(createIO().cancel(request)).rejects.toThrow("Could not cancel")
  })

  it.each([
    "javascript:alert(1)",
    "file:///tmp/doc",
    "https://example.test/\nunsafe",
    'https://example.test/"',
  ])("does not launch an unsafe external URL: %s", async (url) => {
    await expect(createIO().openExternal(url)).rejects.toThrow("Unsafe external URL")
    expect(exec).not.toHaveBeenCalled()
  })

  it("opens a safe external URL only on explicit request", async () => {
    await createIO().openExternal("https://example.test/guide")
    expect(exec).toHaveBeenCalledExactlyOnceWith("xdg-open", ["https://example.test/guide"])
  })
})
