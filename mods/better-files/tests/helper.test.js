import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cancelRequest, requestLocation, runRequest } from "../reader/helper.mjs"

let base
let appHome
let root
let file
let path
let factory
let renderer
let request
const job = "helper-job-1234"
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "markdown-helper-")))
  appHome = join(base, "temporary profile with 空格")
  root = join(base, "workspace")
  path = join(appHome, "data/better-files/requests", `${job}.json`)
  await mkdir(join(appHome, "data/better-files/requests"), { recursive: true })
  await mkdir(root)
  file = join(root, "notes.md")
  await writeFile(file, "# Document\n")
  request = { appHome, root, file, on: null, width: 800 }
  await writeFile(path, JSON.stringify(request))
  renderer = {
    render: vi.fn(async () => ({ svg, width: 20, height: 10 })),
    close: vi.fn(async () => {}),
  }
  factory = vi.fn(() => renderer)
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})
const run = () => runRequest(path, { rendererFactory: factory })
const save = async (change) => writeFile(path, JSON.stringify({ ...request, ...change }))
const leasePath = () => join(appHome, "data/better-files/leases", `${job}.json`)

it("accepts only bounded job names in the profile request directory", () => {
  expect(requestLocation(path)).toEqual({
    job,
    directory: join(appHome, "data/better-files/requests"),
    home: appHome,
  })
  for (const invalid of [
    "relative/data/better-files/requests/abcdefgh.json",
    join(base, "abcdefgh.json"),
    join(appHome, "data/other/requests/abcdefgh.json"),
    join(appHome, "data/markdown-reader/requests/abcdefgh.json"),
    join(appHome, "data/better-files/requests/short.json"),
    join(appHome, "data/better-files/requests/UPPERCASE.json"),
    join(appHome, "data/better-files/requests", `${"a".repeat(101)}.json`),
    path.replace(/\.json$/, ".txt"),
  ])
    expect(() => requestLocation(invalid), invalid).toThrow()
})

it("rejects the old request namespace before reading request bytes or creating a renderer", async () => {
  const oldPath = join(appHome, "data/markdown-reader/requests", `${job}.json`)
  await expect(runRequest(oldPath, { rendererFactory: factory })).rejects.toThrow(
    "Reader request is outside the app cache",
  )
  expect(factory).not.toHaveBeenCalled()
  await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" })
})

it("returns source, dependencies, job and a deterministic signature and closes its renderer", async () => {
  const sigterm = process.listenerCount("SIGTERM")
  const sigint = process.listenerCount("SIGINT")
  const first = await run()
  expect(first).toMatchObject({
    version: 1,
    job,
    file,
    root,
    source: "# Document\n",
    dependencies: [file],
    assets: [],
    signature: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  const next = await run()
  expect(next.signature).toBe(first.signature)
  await writeFile(file, "# Changed\n")
  expect((await run()).signature).not.toBe(first.signature)
  expect(renderer.render).not.toHaveBeenCalled()
  expect(renderer.close).toHaveBeenCalledTimes(3)
  expect(process.listenerCount("SIGTERM")).toBe(sigterm)
  expect(process.listenerCount("SIGINT")).toBe(sigint)
  const lease = JSON.parse(await readFile(leasePath(), "utf8"))
  expect(lease.assets).toEqual([])
  expect(lease.expires).toBeGreaterThan(Date.now())
})

it("normalizes renderer options instead of passing document-controlled configuration", async () => {
  await save({
    width: 801.4,
    dark: true,
    foreground: "#aabbccff",
    background: "url(file:///secret)",
    accent: "#123456",
    fontFamily: "malicious-font",
    securityLevel: "loose",
  })
  await run()
  expect(factory).toHaveBeenCalledExactlyOnceWith({
    width: 801,
    dark: true,
    foreground: "#aabbcc",
    background: "#202026",
    accent: "#123456",
    fontFamily: "sans-serif",
    signal: expect.any(AbortSignal),
  })
})

it("batches special blocks through one renderer and leaves ordinary code alone", async () => {
  await writeFile(
    file,
    "```js\nconst x = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n$$\nx^2\n$$\n",
  )
  const result = await run()
  expect(factory).toHaveBeenCalledOnce()
  expect(renderer.render).toHaveBeenCalledTimes(2)
  expect(renderer.close).toHaveBeenCalledOnce()
  expect(result.blocks.some((block) => block.type === "code")).toBe(true)
  const lease = JSON.parse(await readFile(leasePath(), "utf8"))
  expect(lease.assets).toHaveLength(result.assets.length)
})

it("retains a block's source and error and closes after a render failure", async () => {
  await writeFile(file, "```mermaid\nbroken\n```")
  renderer.render.mockRejectedValueOnce(new Error("syntax failure"))
  const result = await run()
  expect(result.blocks[0]).toMatchObject({
    type: "error",
    source: "broken",
    error: "syntax failure",
  })
  expect(renderer.close).toHaveBeenCalledOnce()
})

it("closes the renderer and removes signal listeners after a document-level failure", async () => {
  await writeFile(file, `${"> ".repeat(45)}deep`)
  const count = process.listenerCount("SIGTERM")
  await expect(run()).rejects.toThrow("nesting")
  expect(renderer.close).toHaveBeenCalledOnce()
  expect(process.listenerCount("SIGTERM")).toBe(count)
})

it("removes partial asset leases when a document exceeds its native block budget", async () => {
  await writeFile(file, `\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n${"paragraph\n\n".repeat(600)}`)
  await expect(run()).rejects.toThrow("native block limit")
  expect(renderer.render).toHaveBeenCalledOnce()
  expect(renderer.close).toHaveBeenCalledOnce()
  await expect(lstat(leasePath())).rejects.toMatchObject({ code: "ENOENT" })
})

it("removes leases even when renderer cleanup fails", async () => {
  await writeFile(file, "```mermaid\ngraph TD; A-->B\n```")
  renderer.close.mockRejectedValueOnce(new Error("cleanup failed"))
  await expect(run()).rejects.toThrow("cleanup failed")
  await expect(lstat(leasePath())).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not start a renderer for a missing document", async () => {
  await rm(file)
  await expect(run()).rejects.toMatchObject({ code: "ENOENT" })
  expect(factory).not.toHaveBeenCalled()
})

describe("request validation before document work", () => {
  it("rejects remote requests even if the local document root does not exist", async () => {
    await save({
      on: "remote-machine",
      root: join(base, "missing"),
      file: join(base, "missing.md"),
    })
    await expect(run()).rejects.toThrow("Remote Markdown")
    expect(factory).not.toHaveBeenCalled()
  })

  it("requires appHome to match the request directory", async () => {
    await save({ appHome: join(base, "different-profile") })
    await expect(run()).rejects.toThrow("does not match")
    expect(factory).not.toHaveBeenCalled()
    await expect(lstat(join(base, "different-profile"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([0, 159, 2401, "not-a-number"])("rejects invalid width %j", async (width) => {
    await save({ width })
    await expect(run()).rejects.toThrow("width")
    expect(factory).not.toHaveBeenCalled()
  })

  it("bounds request bytes and refuses request symlinks", async () => {
    await writeFile(path, " ".repeat(32769))
    await expect(run()).rejects.toThrow("byte limit")
    await rm(path)
    const outside = join(base, "outside-request.json")
    await writeFile(outside, JSON.stringify(request))
    await symlink(outside, path)
    await expect(run()).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
  })
})

describe("cancellation and resource cleanup", () => {
  it("removes the current lease when cancellation is requested", async () => {
    await run()
    await cancelRequest(path)
    expect(await readFile(`${path}.cancel`, "utf8")).toBe("cancelled")
    await expect(lstat(leasePath())).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("handles cancellation before startup without reading the document or creating a renderer", async () => {
    await writeFile(`${path}.cancel`, "cancelled")
    await rm(file)
    await expect(run()).rejects.toThrow("cancelled")
    expect(factory).not.toHaveBeenCalled()
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(`${path}.cancel`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("aborts an active render, closes resources, and removes request and lease files", async () => {
    await writeFile(file, "```mermaid\ngraph TD; A-->B\n```")
    factory.mockImplementation(({ signal }) => {
      renderer.render.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("worker cancelled")), {
              once: true,
            })
          }),
      )
      return renderer
    })
    const running = run()
    // Attach the rejection handler before the cancellation poll can reject the render.
    const outcome = expect(running).rejects.toThrow(/cancelled/)
    await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledOnce())
    await cancelRequest(path)
    await outcome
    expect(factory.mock.calls[0][0].signal.aborted).toBe(true)
    expect(renderer.close).toHaveBeenCalled()
    for (const removed of [path, `${path}.cancel`, leasePath()]) {
      await expect(lstat(removed)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })
})
