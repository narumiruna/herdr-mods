import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, test } from "vitest"
import { ManagerSession } from "../manager.js"

const run = promisify(execFile)
const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-lifecycle-")))
  roots.push(root)
  const home = join(root, "app")
  const repo = join(root, "repository")
  await mkdir(join(home, "mods"), { recursive: true })
  await mkdir(repo)
  await writeFile(join(home, "installed.json"), "{}")
  const env = {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  }
  const git = async (...args) =>
    (
      await run(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: repo, env, timeout: 30_000 },
      )
    ).stdout.trim()
  await git("init", "--template=", "-b", "main")
  const commit = async (version) => {
    await writeFile(
      join(repo, "mod.json"),
      JSON.stringify({ title: "Fixture mod", version, place: "none" }),
    )
    await writeFile(join(repo, "main.js"), `export default {}; // version ${version}\n`)
    await git("add", "--", "mod.json", "main.js")
    await git("commit", "-m", `fixture ${version}`)
    return git("rev-parse", "HEAD")
  }
  const initial = await commit("1")
  const request = async (value) => {
    const { stdout } = await run(
      "uv",
      [
        "run",
        "--offline",
        "--no-project",
        "python",
        resolve("tests/backend_fixture.py"),
        home,
        repo,
        JSON.stringify(value),
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    )
    const response = JSON.parse(stdout)
    if (!response.ok) throw new Error(response.error)
    return response
  }
  const index = {
    schemaVersion: 1,
    generatedAt: "2026-11-09T12:00:00Z",
    modCount: 1,
    repositoryCount: 1,
    source: {
      provider: "github",
      query: "topic:herdr-mod is:public",
      truncated: false,
      totalCount: 1,
      collectedCount: 1,
      blacklistedCount: 0,
      skippedCount: 0,
    },
    mods: [
      {
        owner: "Example",
        repo: "Fixture",
        fullName: "Example/Fixture",
        url: "https://github.com/Example/Fixture",
        defaultBranch: "main",
        headCommit: initial,
        path: "",
        name: "Fixture mod",
        blurb: "Temporary repository",
        modNames: ["fixture"],
      },
    ],
  }
  const io = {
    discover: () => request({ action: "discover" }),
    fetchGallery: async () => index,
    operate: request,
  }
  const session = new ManagerSession(io)
  await session.load()
  expect(session.galleryError).toBe("")
  expect(session.discoveryError).toBe("")
  return { home, repo, commit, io, session, index, request }
}

// This bridges the real JS model and real Python filesystem backend. Only Git's
// transport is replaced, with local temporary fixture repositories, never GitHub.
describe.skipIf(process.platform === "win32")("real local lifecycle integration", () => {
  test("Gallery install → update → confirmed uninstall survives manager reopen", async () => {
    const { session, home, commit, io } = await fixture()
    const id = session.list("gallery")[0].id
    const first = session.perform("install", id)
    await expect(session.perform("install", id)).rejects.toThrow("progress")
    await first
    expect(session.mod(id).state).toBe("installed")
    expect(session.list("installed")).toHaveLength(1)
    expect(JSON.parse(await readFile(join(home, "mods/fixture/mod.json"), "utf8")).version).toBe(
      "1",
    )
    const next = await commit("2")
    await session.checkUpdates()
    expect(session.mod(id).updateCommit).toBe(next)
    await session.perform("update", id)
    expect(session.mod(id).commit).toBe(next)
    const reopened = new ManagerSession(io)
    await reopened.load()
    expect(reopened.mod(id).commit).toBe(next)
    reopened.requestUninstall(id)
    reopened.cancelUninstall()
    expect(reopened.mod(id).state).toBe("installed")
    const confirmation = reopened.requestUninstall(id)
    expect(confirmation.path).toBe(join(home, "mods/fixture"))
    expect(confirmation.identityToken).toMatch(/^[a-f0-9]{32}$/)
    await reopened.confirmUninstall()
    expect(reopened.mod(id).state).toBe("available")
    expect(reopened.list("installed")).toEqual([])
    const registry = JSON.parse(
      await readFile(join(home, "data/mod-manager/registry.json"), "utf8"),
    )
    expect(registry.history[0].repository).toBe("example/fixture")
    await expect(readFile(join(home, "data/mod-manager/transaction.json"))).rejects.toThrow()
  }, 60_000)

  test("a remote advance after checking updates is rejected before changing files", async () => {
    const { session, home, commit } = await fixture()
    const id = session.list("gallery")[0].id
    await session.perform("install", id)
    const original = session.mod(id).commit
    const checked = await commit("2")
    await session.checkUpdates()
    expect(session.mod(id).updateCommit).toBe(checked)
    const latest = await commit("3")
    await expect(session.perform("update", id)).rejects.toThrow("targetCommit")
    expect(session.mod(id).commit).toBe(original)
    expect(JSON.parse(await readFile(join(home, "mods/fixture/mod.json"), "utf8")).version).toBe(
      "1",
    )
    await session.checkUpdates()
    await session.perform("update", id)
    expect(session.mod(id).commit).toBe(latest)
  }, 60_000)

  test("real discovery keeps unusual unmanaged folders and long metadata visible", async () => {
    const { session, home } = await fixture()
    const path = join(home, "mods/bad name")
    await mkdir(path)
    await writeFile(
      join(path, "mod.json"),
      JSON.stringify({ title: "Existing user mod", description: "d".repeat(4097), place: "none" }),
    )
    await writeFile(join(path, "main.js"), "export default {};")
    await session.refresh()
    expect(session.discoveryStatus).toBe("ready")
    const local = session.list("installed")[0]
    expect(local.modName).toBe("bad name")
    expect(local.description.length).toBeLessThanOrEqual(4096)
    expect(local.protectedReason).toBeTruthy()
    expect(() => session.requestUninstall(local.id)).toThrow()
  }, 60_000)

  test("GitHub installation matches Gallery and local edits prevent removal", async () => {
    const { session, home, io } = await fixture()
    await session.installRepository("https://github.com/Example/Fixture.git")
    const mod = session.list("installed")[0]
    expect(mod.gallery).toBe(true)
    await expect(session.installRepository("https://github.com/example/fixture")).rejects.toThrow(
      "already installed",
    )
    const path = join(home, "mods/fixture/main.js")
    await writeFile(path, "// local user edit\n")
    const reopened = new ManagerSession(io)
    await reopened.load()
    expect(reopened.mod(mod.id).protectedReason).toMatch(/local changes/i)
    expect(() => reopened.requestUninstall(mod.id)).toThrow(/local changes/i)
    expect(await readFile(path, "utf8")).toBe("// local user edit\n")
  }, 60_000)
})
