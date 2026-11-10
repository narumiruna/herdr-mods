import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect } from "vitest"
import { ManagerSession } from "../manager.js"

const run = promisify(execFile)
const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

export async function fixture({ branch = "main", tag = false } = {}) {
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
  await git("init", "--template=", "-b", branch)
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
  if (tag) await git("tag", branch)
  const request = async (value) => {
    const { stdout } = await run(
      "uv",
      [
        "run",
        "--offline",
        "--no-project",
        "--no-python-downloads",
        "python",
        "-I",
        "-S",
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
  return { root, home, repo, commit, git, io, session, index, request }
}

/** Build the exact package ownership format used by PR #5, without adopting user data. */
export async function legacyPackage(fixture, id = "fixture", repository = "example/fixture") {
  const target = join(fixture.home, "mods", id)
  await mkdir(target)
  const files = {}
  for (const name of ["mod.json", "main.js"]) {
    await copyFile(join(fixture.repo, name), join(target, name))
    const data = await readFile(join(target, name))
    const info = await stat(join(target, name))
    files[name] = {
      sha256: createHash("sha256").update(data).digest("hex"),
      mode: info.mode & 0o777,
      size: info.size,
      inode: [info.dev, info.ino],
    }
  }
  const info = await stat(target)
  const record = {
    id,
    repository,
    recipePath: "",
    modFolder: "",
    path: target,
    commit: fixture.index.mods[0].headCommit,
    files,
    directories: {},
    inode: [info.dev, info.ino],
    identityToken: "a".repeat(32),
  }
  const state = join(fixture.home, "data/mod-manager")
  await mkdir(state, { recursive: true })
  await writeFile(
    join(state, "registry.json"),
    JSON.stringify({ version: 1, mods: { [id]: record }, history: [] }),
  )
  await writeFile(join(state, "initialized"), "1\n")
  await writeFile(join(state, "lock"), JSON.stringify({ version: 1 }))
  return { target, record, lockInode: (await stat(join(state, "lock"))).ino }
}

/** Build a clean PR #6 checkout, keeping its actual Git objects, refs, index and marker. */
export async function legacyCheckout(fixture, id = "fixture", repository = "example/fixture") {
  const target = join(fixture.home, "mods", id)
  await fixture.git("clone", "--no-hardlinks", "--template=", "--", fixture.repo, target)
  await fixture.git(
    "-C",
    target,
    "config",
    "remote.origin.url",
    `https://github.com/${repository}.git`,
  )
  const branch = (await fixture.git("-C", target, "symbolic-ref", "HEAD")).slice(
    "refs/heads/".length,
  )
  await writeFile(
    join(target, ".git/herdr-mod-manager.json"),
    JSON.stringify({ version: 1, url: `https://github.com/${repository}.git`, branch }),
  )
  return { target, git: (...args) => fixture.git("-C", target, ...args) }
}
