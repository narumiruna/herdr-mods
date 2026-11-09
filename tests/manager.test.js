import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { devNull, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createManager } from "../manager.js"
import { createRuntime } from "../runtime.js"

const TIMEOUT = 30_000
const FILES = {
  "mod.json": JSON.stringify({
    title: "Fixture Mod",
    description: "A local fixture",
    version: "1",
  }),
  "main.js": "export const version = 1\n",
  ".gitignore": "gpui-kit.d.ts\n",
}

function execute(command, args, { cwd, timeout = 120_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, timeout, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text
    })
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}: ${stderr}`))
      else resolve({ code, stdout, stderr })
    })
  })
}

async function read(path) {
  try {
    return await fs.readFile(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function put(root, files) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, text)
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let sandbox
let home
let host
let io
let manager
let routes
let gitCalls
let hostEnvironment

async function git(cwd, ...args) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  const result = await execute(
    "git",
    [
      "--no-optional-locks",
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      env: {
        ...environment,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file",
        LC_ALL: "C",
      },
    },
  )
  if (result.code !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function commit(path, message = "fixture change") {
  await git(path, "add", "--all")
  await git(path, "commit", "--no-verify", "-m", message)
  return git(path, "rev-parse", "HEAD")
}

async function repository(name = "fixture", files = FILES) {
  const path = join(sandbox, "repositories", name)
  await fs.mkdir(path, { recursive: true })
  await git(path, "init", "--initial-branch=main", "--template=")
  await put(path, files)
  await commit(path, "initial fixture")
  const url = `https://github.com/test/${name}.git`
  routes.set(url, path)
  return { path, url, destination: join(io.mods, name) }
}

async function installed(name = "fixture") {
  const fixture = await repository(name)
  await manager.install(fixture.url)
  return { ...fixture, before: await git(fixture.destination, "rev-parse", "HEAD") }
}

async function expectReleased() {
  expect(await fs.readdir(io.work)).toEqual([])
}

async function occupy(path, kind) {
  if (kind === "directory") await fs.mkdir(path)
  else if (kind === "file") await fs.writeFile(path, "keep this file")
  else await fs.symlink(join(sandbox, "missing target"), path)
}

async function expectOccupied(path, kind) {
  expect(await io.kind(path)).toBe(kind)
  if (kind === "directory") expect(await fs.readdir(path)).toEqual([])
  else if (kind === "file") expect(await read(path)).toBe("keep this file")
  else expect(await fs.readlink(path)).toBe(join(sandbox, "missing target"))
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(join(tmpdir(), "herdr manager tests "))
  home = join(sandbox, "app home")
  await fs.mkdir(home)
  routes = new Map()
  gitCalls = []
  hostEnvironment = { ...process.env, UV_CACHE_DIR: join(sandbox, "uv cache"), LC_ALL: "C" }

  // All host requests must stay inside this test's app home. No user mods are accessed.
  const exec = (command, args, options) => {
    if (command !== "uv" || JSON.parse(args.at(-1)).root !== home) {
      throw new Error("Unexpected host command or app home")
    }
    return execute(command, args, { ...options, env: hostEnvironment })
  }
  host = { home, exec, read, write: (path, text) => fs.writeFile(path, text) }
  const filesystem = createRuntime(host)
  const localGit = createRuntime({
    ...host,
    exec: (command, args, options) => {
      const request = JSON.parse(args.at(-1))
      if (request.action !== "git") throw new Error("The Git adapter cannot run filesystem actions")
      const [cwd, gitArgs] = request.args
      gitCalls.push({ cwd, args: [...gitArgs] })
      const rewrites = []
      for (const value of gitArgs) {
        if (!/^https?:\/\//.test(value)) continue
        const path = routes.get(value)
        if (!path) throw new Error(`Network access is forbidden in tests: ${value}`)
        // Command-scoped URL rewriting keeps the stored origin canonical after cloning.
        rewrites.push("-c", `url.${path}.insteadOf=${value}`)
      }
      request.args[1] = [...rewrites, ...gitArgs]
      const runnerArgs = [...args]
      const helperIndex = runnerArgs.indexOf("-c") + 1
      const helper = runnerArgs[helperIndex]
      if (
        !helper.includes('GIT_ALLOW_PROTOCOL="https"') ||
        !helper.includes('"protocol.https.allow=always"')
      ) {
        throw new Error("Production Git transport settings changed; review the fixture adapter")
      }
      // Only this runner allows local transport. HTTPS remains disabled, even on adapter errors.
      runnerArgs[helperIndex] = helper
        .replace('GIT_ALLOW_PROTOCOL="https"', 'GIT_ALLOW_PROTOCOL="file"')
        .replace('"protocol.https.allow=always"', '"protocol.file.allow=always"')
      runnerArgs[runnerArgs.length - 1] = JSON.stringify(request)
      return exec(command, runnerArgs, options)
    },
  })
  io = { ...filesystem, git: localGit.git }
  manager = createManager(io)
}, TIMEOUT)

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
}, TIMEOUT)

describe("installation through the production runtime", () => {
  test(
    "validates a private stage, atomically publishes it, and discovers manager ownership",
    async () => {
      const fixture = await repository()
      let published = false
      const installer = createManager({
        ...io,
        publish: async (stage, destination) => {
          expect(dirname(stage)).toBe(io.work)
          expect(destination).toBe(fixture.destination)
          expect(await io.kind(destination)).toBe("missing")
          expect(await read(join(stage, "main.js"))).toBe(FILES["main.js"])
          expect(JSON.parse(await read(join(stage, ".git/herdr-mod-manager.json")))).toEqual({
            version: 1,
            url: fixture.url,
            branch: "main",
          })
          const result = await io.publish(stage, destination)
          expect(await io.kind(stage)).toBe("missing")
          published = true
          return result
        },
      })
      await expect(installer.install(fixture.url)).resolves.toMatch(/^Installed test\/fixture\./)
      expect(published).toBe(true)
      expect(await git(fixture.destination, "config", "--get", "remote.origin.url")).toBe(
        fixture.url,
      )
      expect(await git(fixture.destination, "status", "--porcelain")).toBe("")
      expect(await manager.list()).toEqual([
        expect.objectContaining({
          id: "fixture",
          name: "Fixture Mod",
          description: "A local fixture",
          version: "1",
          repository: "test/fixture",
          source: "github",
          managed: true,
          problem: "",
        }),
      ])
      expect(gitCalls.find((call) => call.args[0] === "clone").args).toContain("--no-checkout")
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["directory", "file", "link"])(
    "does not overwrite a pre-existing %s, including a dangling link",
    async (kind) => {
      const fixture = await repository()
      await fs.mkdir(io.mods)
      await occupy(fixture.destination, kind)
      await expect(manager.install(fixture.url)).rejects.toThrow("Destination already exists")
      expect(gitCalls).toEqual([])
      await expectOccupied(fixture.destination, kind)
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["directory", "file", "link"])(
    "the actual no-clobber publish preserves a %s created after the preflight check",
    async (kind) => {
      const fixture = await repository()
      const installer = createManager({
        ...io,
        publish: async (stage, destination) => {
          await occupy(destination, kind)
          return io.publish(stage, destination)
        },
      })
      await expect(installer.install(fixture.url)).rejects.toThrow("Destination already exists")
      await expectOccupied(fixture.destination, kind)
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each([
    ["missing manifest", { "main.js": FILES["main.js"] }, /root mod.json and main.js/],
    ["invalid JSON", { ...FILES, "mod.json": "{" }, /JSON|property|position/i],
    ["array manifest", { ...FILES, "mod.json": "[]" }, /JSON object/],
    ["invalid title", { ...FILES, "mod.json": '{"title":" "}' }, /title/],
    ["invalid place", { ...FILES, "mod.json": '{"place":"outside"}' }, /invalid place/],
    ["invalid size", { ...FILES, "mod.json": '{"size":0}' }, /positive number/],
    ["missing entry", { "mod.json": FILES["mod.json"] }, /root mod.json and main.js/],
    ["empty entry", { ...FILES, "main.js": " \n\t" }, /nonempty root main.js/],
  ])(
    "rejects %s before publication and removes its stage and lock",
    async (_label, files, message) => {
      const fixture = await repository("invalid", files)
      await expect(manager.install(fixture.url)).rejects.toThrow(message)
      expect(await io.kind(fixture.destination)).toBe("missing")
      expect(gitCalls.some((call) => call.args[0] === "reset")).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["symbolic link", "submodule"])(
    "rejects a committed %s tree without checking it out",
    async (kind) => {
      const fixture = await repository()
      if (kind === "symbolic link") {
        await fs.symlink("main.js", join(fixture.path, "linked.js"))
        await commit(fixture.path)
      } else {
        const head = await git(fixture.path, "rev-parse", "HEAD")
        await fs.writeFile(
          join(fixture.path, ".gitmodules"),
          '[submodule "dependency"]\n\tpath = dependency\n\turl = https://example.invalid/never.git\n',
        )
        await git(fixture.path, "update-index", "--add", "--cacheinfo", `160000,${head},dependency`)
        await git(fixture.path, "add", ".gitmodules")
        await git(fixture.path, "commit", "-m", "gitlink fixture")
      }
      await expect(manager.install(fixture.url)).rejects.toThrow("symbolic links or submodules")
      expect(await io.kind(fixture.destination)).toBe("missing")
      expect(gitCalls.some((call) => call.args[0] === "reset")).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "does not execute entry files, package scripts, inherited hooks, or checkout hooks",
    async () => {
      const sentinel = join(sandbox, "must not execute")
      const hookDirectory = join(sandbox, "hooks")
      await fs.mkdir(hookDirectory)
      for (const name of ["post-checkout", "post-merge", "pre-merge-commit"]) {
        const path = join(hookDirectory, name)
        await fs.writeFile(path, `#!/bin/sh\nprintf executed > "${sentinel}"\n`, { mode: 0o755 })
      }
      const globalConfig = join(sandbox, "global config")
      await fs.writeFile(globalConfig, `[core]\n\thooksPath = ${hookDirectory}\n`)
      hostEnvironment.GIT_CONFIG_GLOBAL = globalConfig
      hostEnvironment.GIT_DIR = join(sandbox, "invalid inherited git directory")
      const script = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`)}`
      const fixture = await repository("scripts", {
        ...FILES,
        "main.js": `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed')\n`,
        "package.json": JSON.stringify({
          scripts: Object.fromEntries(
            ["preinstall", "install", "postinstall", "prepare"].map((name) => [name, script]),
          ),
        }),
      })
      await manager.install(fixture.url)
      await git(fixture.destination, "config", "core.hooksPath", hookDirectory)
      await fs.writeFile(join(fixture.path, "version.txt"), "new version\n")
      await commit(fixture.path)
      await expect(manager.update("scripts")).resolves.toMatch(/^Updated test\/scripts\./)
      expect(await read(sentinel)).toBeNull()
      expect(await io.kind(join(fixture.destination, "node_modules"))).toBe("missing")
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "cleans a failed clone and releases the lock so installation can be retried",
    async () => {
      const url = "https://github.com/test/offline.git"
      routes.set(url, join(sandbox, "missing remote repository"))
      await expect(manager.install(url)).rejects.toThrow(/does not exist|does not appear/)
      expect(await io.kind(join(io.mods, "offline"))).toBe("missing")
      await expectReleased()
      const fixture = await repository("offline")
      await expect(manager.install(fixture.url)).resolves.toMatch(/^Installed/)
      await expectReleased()
    },
    TIMEOUT,
  )
})

describe("updates through real Git", () => {
  test.each(["main", "release/stable"])(
    "records the exact default branch despite a tag with the same name: %s",
    async (branch) => {
      const fixture = await repository()
      if (branch !== "main") await git(fixture.path, "branch", "-m", branch)
      await git(fixture.path, "tag", branch)
      await manager.install(fixture.url)
      const marker = JSON.parse(
        await read(join(fixture.destination, ".git/herdr-mod-manager.json")),
      )
      expect(marker.branch).toBe(branch)
      await fs.writeFile(join(fixture.path, "upstream.txt"), "new content\n")
      const target = await commit(fixture.path)
      await expect(manager.update("fixture")).resolves.toMatch(/^Updated/)
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(target)
      expect((await manager.list())[0].managed).toBe(true)
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "fast-forwards a validated update without reset and preserves its canonical origin",
    async () => {
      const fixture = await installed()
      await put(fixture.path, {
        "main.js": "export const version = 2\n",
        "mod.json": JSON.stringify({ title: "Updated Mod", version: "2" }),
      })
      const target = await commit(fixture.path)
      gitCalls.length = 0
      await expect(manager.update("fixture")).resolves.toMatch(/^Updated test\/fixture\./)
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(target)
      expect(await read(join(fixture.destination, "main.js"))).toBe("export const version = 2\n")
      expect(await git(fixture.destination, "status", "--porcelain")).toBe("")
      expect(gitCalls.some((call) => call.args[0] === "reset")).toBe(false)
      expect(gitCalls.find((call) => call.args[0] === "fetch").args).toEqual([
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        fixture.url,
        "refs/heads/main",
      ])
      expect((await manager.list())[0]).toMatchObject({ name: "Updated Mod", managed: true })
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "a no-op update fetches and validates but does not merge or reset",
    async () => {
      const fixture = await installed()
      gitCalls.length = 0
      await expect(manager.update("fixture")).resolves.toBe("test/fixture is already up to date.")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(gitCalls.some((call) => call.args[0] === "fetch")).toBe(true)
      expect(gitCalls.some((call) => ["merge", "reset"].includes(call.args[0]))).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["main.js", "late-note.txt", "gpui-kit.d.ts"])(
    "rechecks local changes created during fetch: %s",
    async (name) => {
      const fixture = await installed()
      await fs.writeFile(join(fixture.path, "upstream.txt"), "new upstream content\n")
      await commit(fixture.path)
      const updater = createManager({
        ...io,
        git: async (path, args) => {
          const result = await io.git(path, args)
          if (args[0] === "fetch") await fs.writeFile(join(path, name), "late local work\n")
          return result
        },
      })
      gitCalls.length = 0
      await expect(updater.update("fixture")).rejects.toThrow("Local changes")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(await read(join(fixture.destination, name))).toBe("late local work\n")
      expect(gitCalls.some((call) => call.args[0] === "merge")).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "fast-forwards file-to-directory and directory-to-file changes",
    async () => {
      const fixture = await repository("shapes", {
        ...FILES,
        payload: "old file\n",
        "folder/child.txt": "old directory\n",
      })
      await manager.install(fixture.url)
      await fs.unlink(join(fixture.path, "payload"))
      await fs.rm(join(fixture.path, "folder"), { recursive: true })
      await put(fixture.path, { "payload/child.txt": "new directory\n", folder: "new file\n" })
      const target = await commit(fixture.path)
      await manager.update("shapes")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(target)
      expect(await read(join(fixture.destination, "payload/child.txt"))).toBe("new directory\n")
      expect(await read(join(fixture.destination, "folder"))).toBe("new file\n")
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["filter.hazard.clean", "include.path", "core.worktree"])(
    "refuses unsafe local configuration before status or fetch: %s",
    async (key) => {
      const fixture = await installed()
      await git(fixture.destination, "config", key, join(sandbox, "never execute or follow"))
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow("unsupported local Git configuration")
      expect(gitCalls.some((call) => ["status", "fetch", "merge"].includes(call.args[0]))).toBe(
        false,
      )
      await expectReleased()
    },
    TIMEOUT,
  )

  // Ignored SDK declarations generated by Herdr intentionally block updates too.
  test.each(["tracked", "staged", "untracked", "ignored SDK"])(
    "rejects %s local changes before fetching and preserves every change",
    async (kind) => {
      const fixture = await installed()
      const name =
        kind === "untracked" ? "notes.txt" : kind === "ignored SDK" ? "gpui-kit.d.ts" : "main.js"
      await fs.writeFile(join(fixture.destination, name), "local work must remain\n")
      if (kind === "staged") await git(fixture.destination, "add", "main.js")
      const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]
      const status = await git(fixture.destination, ...statusArgs)
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow(
        "Local changes, untracked files, or ignored files",
      )
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(await git(fixture.destination, ...statusArgs)).toBe(status)
      expect(await read(join(fixture.destination, name))).toBe("local work must remain\n")
      expect(gitCalls.some((call) => call.args[0] === "fetch")).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects hidden index flag %s even when status reports a clean worktree",
    async (flag) => {
      const fixture = await installed()
      await git(fixture.destination, "update-index", flag, "main.js")
      await fs.writeFile(join(fixture.destination, "main.js"), "hidden local work\n")
      expect(await git(fixture.destination, "status", "--porcelain")).toBe("")
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow("hidden index flags")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(await read(join(fixture.destination, "main.js"))).toBe("hidden local work\n")
      expect(gitCalls.some((call) => call.args[0] === "fetch")).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "preserves local commits when upstream has diverged",
    async () => {
      const fixture = await installed()
      await fs.writeFile(join(fixture.destination, "local.txt"), "local commit\n")
      const localHead = await commit(fixture.destination)
      await fs.writeFile(join(fixture.path, "upstream.txt"), "upstream commit\n")
      await commit(fixture.path)
      await expect(manager.update("fixture")).rejects.toThrow("not a fast-forward")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(localHead)
      expect(await read(join(fixture.destination, "local.txt"))).toBe("local commit\n")
      expect(await read(join(fixture.destination, "upstream.txt"))).toBeNull()
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["origin", "branch", "detached HEAD"])(
    "rejects a changed %s before contacting the source",
    async (kind) => {
      const fixture = await installed()
      if (kind === "origin") {
        await git(
          fixture.destination,
          "config",
          "remote.origin.url",
          "https://github.com/test/other.git",
        )
      } else if (kind === "branch") {
        await git(fixture.destination, "switch", "-c", "local-branch")
      } else {
        await git(fixture.destination, "checkout", "--detach")
      }
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow(
        /origin has changed|branch|symbolic ref/,
      )
      expect(gitCalls.some((call) => call.args[0] === "fetch")).toBe(false)
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect((await manager.list())[0]).toMatchObject({
        managed: false,
        problem: expect.stringMatching(/origin has changed|branch|symbolic ref/),
      })
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["invalid manifest", "missing entry", "symbolic link"])(
    "fetches but does not apply an update with a changed candidate containing %s",
    async (kind) => {
      const fixture = await installed()
      if (kind === "invalid manifest") {
        await fs.writeFile(join(fixture.path, "mod.json"), '{"title":false}')
      } else if (kind === "missing entry") {
        await fs.unlink(join(fixture.path, "main.js"))
      } else {
        await fs.symlink("main.js", join(fixture.path, "linked.js"))
      }
      await commit(fixture.path)
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow(/title|root mod.json|symbolic links/)
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(await read(join(fixture.destination, "main.js"))).toBe(FILES["main.js"])
      expect(await read(join(fixture.destination, "mod.json"))).toBe(FILES["mod.json"])
      expect(await git(fixture.destination, "status", "--porcelain")).toBe("")
      expect(gitCalls.some((call) => call.args[0] === "fetch")).toBe(true)
      expect(gitCalls.some((call) => ["merge", "reset"].includes(call.args[0]))).toBe(false)
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "cleans up after a failed fetch without changing the installed checkout",
    async () => {
      const fixture = await installed()
      routes.set(fixture.url, join(sandbox, "unavailable remote"))
      await expect(manager.update("fixture")).rejects.toThrow(/does not appear|does not exist/)
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(await read(join(fixture.destination, "main.js"))).toBe(FILES["main.js"])
      await expectReleased()
      routes.set(fixture.url, fixture.path)
      await expect(manager.update("fixture")).resolves.toContain("already up to date")
    },
    TIMEOUT,
  )
})

describe("discovery, ownership, and filesystem safety", () => {
  test(
    "lists local manifests, malformed manifests, and development links without executing code",
    async () => {
      await fs.mkdir(io.mods)
      await put(io.mods, {
        "local/mod.json": JSON.stringify({
          title: "Alpha Local",
          description: "Local",
          version: "3",
        }),
        "local/main.js": "throw new Error('must not execute')\n",
        "broken/mod.json": "not JSON",
        "ordinary-file": "not a mod",
      })
      const source = join(sandbox, "development source")
      await put(source, { "mod.json": JSON.stringify({ title: "Development" }) })
      await fs.symlink(source, join(io.mods, "development"))
      await fs.symlink(join(sandbox, "absent"), join(io.mods, "dangling"))
      const mods = await manager.list()
      expect(mods.map((mod) => mod.name)).toEqual([
        "Alpha Local",
        "broken",
        "dangling",
        "Development",
      ])
      expect(mods.find((mod) => mod.id === "local")).toMatchObject({
        description: "Local",
        version: "3",
        source: "local",
        managed: false,
      })
      expect(mods.find((mod) => mod.id === "broken").problem).not.toBe("")
      for (const id of ["development", "dangling"]) {
        expect(mods.find((mod) => mod.id === id)).toMatchObject({
          source: "development",
          managed: false,
          repository: "Development symbolic link · never updated",
        })
      }
      expect(gitCalls).toEqual([])
    },
    TIMEOUT,
  )

  test(
    "never updates a development symbolic link, even with valid manager metadata in its target",
    async () => {
      const fixture = await installed()
      const target = join(sandbox, "development checkout")
      await fs.rename(fixture.destination, target)
      await fs.symlink(target, fixture.destination)
      gitCalls.length = 0
      await expect(manager.update("fixture")).rejects.toThrow("real checkout")
      expect(await git(target, "rev-parse", "HEAD")).toBe(fixture.before)
      expect(gitCalls).toEqual([])
      expect((await manager.list())[0]).toMatchObject({ source: "development", managed: false })
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "shows an unmanaged GitHub checkout but refuses to update it",
    async () => {
      const fixture = await repository()
      await fs.mkdir(io.mods)
      await git(home, "clone", "--no-hardlinks", "--", fixture.path, fixture.destination)
      await git(fixture.destination, "config", "remote.origin.url", fixture.url)
      const before = await git(fixture.destination, "rev-parse", "HEAD")
      await expect(manager.update("fixture")).rejects.toThrow("not installed by Mod Manager")
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(before)
      expect((await manager.list())[0]).toMatchObject({
        source: "github",
        repository: "test/fixture",
        managed: false,
        problem: "",
      })
      await expectReleased()
    },
    TIMEOUT,
  )

  test.each(["mods", "data", "data/mod-manager"])(
    "the real filesystem helper rejects a symbolic link at %s",
    async (relative) => {
      const outside = join(sandbox, "outside directory")
      await put(outside, { "keep.txt": "untouched" })
      const path = join(home, relative)
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.symlink(outside, path)
      await expect(io.acquire()).rejects.toThrow("Unsafe directory")
      expect(await fs.readdir(outside)).toEqual(["keep.txt"])
      expect(await read(join(outside, "keep.txt"))).toBe("untouched")
    },
    TIMEOUT,
  )

  test(
    "refuses cleanup outside its private staging directory",
    async () => {
      await io.acquire()
      const outside = join(sandbox, "unrelated directory")
      await put(outside, { "keep.txt": "untouched" })
      await expect(io.cleanup(outside)).rejects.toThrow("Unexpected staging path")
      await expect(io.cleanup(io.mods)).rejects.toThrow("Unexpected staging path")
      expect(await read(join(outside, "keep.txt"))).toBe("untouched")
      await io.release()
      await expectReleased()
    },
    TIMEOUT,
  )

  test(
    "preserves the stage and lock after a publication exception for manual recovery",
    async () => {
      const fixture = await repository()
      const installer = createManager({
        ...io,
        publish: (stage) => io.publish(stage, join(sandbox, "invalid destination")),
      })
      await expect(installer.install(fixture.url)).rejects.toThrow("Unexpected destination")
      expect(await io.kind(fixture.destination)).toBe("missing")
      const contents = await fs.readdir(io.work)
      expect(contents).toContain("lock")
      const stages = contents.filter((name) => name.startsWith("install."))
      expect(stages).toHaveLength(1)
      expect(await read(join(io.work, stages[0], "main.js"))).toBe(FILES["main.js"])
      await expect(manager.install(fixture.url)).rejects.toThrow("Mod Manager is locked")
    },
    TIMEOUT,
  )

  test(
    "serializes concurrent manager calls with the on-disk lock and permits a later retry",
    async () => {
      const fixture = await installed("existing")
      const next = await repository("next")
      await fs.writeFile(join(fixture.path, "new.txt"), "new upstream file\n")
      const target = await commit(fixture.path)
      const entered = deferred()
      const resume = deferred()
      const updater = createManager({
        ...io,
        git: async (path, args) => {
          if (args[0] === "fetch") {
            entered.resolve()
            await resume.promise
          }
          return io.git(path, args)
        },
      })
      const otherManager = createManager({ ...createRuntime(host), git: io.git })
      const pending = updater.update("existing")
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("The update did not reach the fetch barrier")
        }),
      ])
      try {
        await expect(otherManager.install(next.url)).rejects.toThrow("Mod Manager is locked")
        await expect(otherManager.update("existing")).rejects.toThrow("Mod Manager is locked")
        expect(await io.kind(io.lock)).toBe("directory")
        expect(await io.kind(next.destination)).toBe("missing")
        expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(fixture.before)
      } finally {
        resume.resolve()
        await pending
      }
      expect(await git(fixture.destination, "rev-parse", "HEAD")).toBe(target)
      await expectReleased()
      await expect(otherManager.install(next.url)).resolves.toMatch(/^Installed test\/next\./)
      await expectReleased()
    },
    TIMEOUT,
  )
})
