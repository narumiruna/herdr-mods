import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { ManagerSession } from "../manager.js"
import { fixture, legacyCheckout, legacyPackage } from "./lifecycle-fixture.js"

const timeout = 60_000

async function migrate(session) {
  expect(session.migration.required).toBe(true)
  expect(session.migration.blocked).toBe(false)
  session.requestMigration()
  await session.confirmMigration()
  expect(session.migration.required).toBe(false)
  expect(session.migration.blocked).toBe(false)
}

describe.skipIf(process.platform === "win32")("cross-version model/backend lifecycle", () => {
  test(
    "PR #5 ownership is explicit, migration preserves the lock inode, and package lifecycle remains usable",
    async () => {
      const f = await fixture()
      const legacy = await legacyPackage(f)
      const state = join(f.home, "data/mod-manager")
      const before = await readFile(join(state, "registry.json"), "utf8")
      await f.session.refresh()
      expect(await readFile(join(state, "registry.json"), "utf8")).toBe(before)
      expect((await stat(join(state, "lock"))).ino).toBe(legacy.lockInode)
      await expect(f.session.perform("install", f.session.list("gallery")[0].id)).rejects.toThrow(
        /migration/i,
      )
      f.session.requestMigration()
      f.session.cancelMigration()
      expect(await readFile(join(state, "registry.json"), "utf8")).toBe(before)
      await migrate(f.session)
      const registry = JSON.parse(await readFile(join(state, "registry.json"), "utf8"))
      expect(registry.version).toBe(2)
      expect(registry.mods.fixture.identityToken).toBe(legacy.record.identityToken)
      expect((await stat(join(state, "lock"))).ino).toBe(legacy.lockInode)
      expect(JSON.parse(await readFile(join(state, "lock"), "utf8")).version).toBe(2)
      const installed = f.session.list("installed")[0]
      expect(installed.managed).toBe(true)
      expect(installed.gallery).toBe(true)
      const target = await f.commit("2")
      await f.session.checkUpdates()
      await f.session.perform("update", installed.id)
      expect(f.session.mod(installed.id).commit).toBe(target)
      f.session.requestUninstall(installed.id)
      await f.session.confirmUninstall()
      expect(f.session.list("installed")).toEqual([])
    },
    timeout,
  )

  test.each(["main", "release/stable"])(
    "main checkout migration preserves Git data and supports checked update and archived uninstall: %s",
    async (branch) => {
      const f = await fixture({ branch, tag: true })
      const checkout = await legacyCheckout(f)
      await checkout.git("branch", "retained-local", "HEAD")
      const initial = await checkout.git("rev-parse", "HEAD")
      const gitInode = (await stat(join(checkout.target, ".git"))).ino
      const marker = await readFile(join(checkout.target, ".git/herdr-mod-manager.json"), "utf8")
      await f.session.refresh()
      expect(f.session.migration.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fixture",
            path: checkout.target,
            repository: "example/fixture",
            kind: "git",
          }),
        ]),
      )
      await migrate(f.session)
      expect((await stat(join(checkout.target, ".git"))).ino).toBe(gitInode)
      expect(await readFile(join(checkout.target, ".git/herdr-mod-manager.json"), "utf8")).toBe(
        marker,
      )
      expect(await checkout.git("rev-parse", "refs/heads/retained-local")).toBe(initial)
      const installed = f.session.list("installed")[0]
      expect(installed.kind).toBe("git")
      expect(installed.managed).toBe(true)
      const target = await f.commit("2")
      await f.session.checkUpdates()
      await f.session.perform("update", installed.id)
      expect(await checkout.git("rev-parse", "HEAD")).toBe(target)
      expect(await checkout.git("status", "--porcelain")).toBe("")
      expect(await checkout.git("rev-parse", "refs/heads/retained-local")).toBe(initial)
      expect((await stat(join(checkout.target, ".git"))).ino).toBe(gitInode)
      const reopened = new ManagerSession(f.io)
      await reopened.load()
      const confirmation = reopened.requestUninstall(installed.id)
      expect(confirmation.archivePath).toBeTruthy()
      reopened.cancelUninstall()
      expect(await checkout.git("rev-parse", "HEAD")).toBe(target)
      const final = reopened.requestUninstall(installed.id)
      await reopened.confirmUninstall()
      await expect(lstat(checkout.target)).rejects.toThrow()
      expect(await f.git("-C", final.archivePath, "rev-parse", "HEAD")).toBe(target)
      expect(await f.git("-C", final.archivePath, "rev-parse", "refs/heads/retained-local")).toBe(
        initial,
      )
      expect((await stat(join(final.archivePath, ".git"))).ino).toBe(gitInode)
      expect(reopened.list("installed")).toEqual([])
    },
    timeout,
  )

  test(
    "a valid disjoint package/Git mixed profile migrates without changing source identities",
    async () => {
      const f = await fixture()
      await legacyPackage(f)
      const checkout = await legacyCheckout(f, "git-fixture", "example/git-fixture")
      const commit = await checkout.git("rev-parse", "HEAD")
      await f.session.refresh()
      expect(f.session.migration.targets.map((target) => target.id).sort()).toEqual([
        "fixture",
        "git-fixture",
      ])
      await migrate(f.session)
      const installed = f.session.list("installed")
      expect(installed).toHaveLength(2)
      expect(installed.every((mod) => mod.managed)).toBe(true)
      expect(installed.map((mod) => mod.repository).sort()).toEqual([
        "example/fixture",
        "example/git-fixture",
      ])
      expect(await checkout.git("rev-parse", "HEAD")).toBe(commit)
      const result = await f.request({ action: "discover" })
      expect(result.migration.required).toBe(false)
    },
    timeout,
  )

  test(
    "an ambiguous legacy directory lock remains read-only and is not removed",
    async () => {
      const f = await fixture()
      const checkout = await legacyCheckout(f)
      const state = join(f.home, "data/mod-manager")
      await mkdir(join(state, "lock"), { recursive: true })
      const inode = (await stat(join(state, "lock"))).ino
      const before = await checkout.git("rev-parse", "HEAD")
      await f.session.refresh()
      expect(f.session.migration.blocked).toBe(true)
      expect(() => f.session.requestMigration()).toThrow()
      expect((await stat(join(state, "lock"))).ino).toBe(inode)
      expect(await checkout.git("rev-parse", "HEAD")).toBe(before)
      expect(await readdir(join(state, "lock"))).toEqual([])
    },
    timeout,
  )

  test(
    "unknown generated files and linked Git metadata cannot be adopted by migration",
    async () => {
      const f = await fixture()
      const checkout = await legacyCheckout(f)
      await writeFile(join(checkout.target, "gpui-kit.d.ts"), "// unknown user/generated data\n")
      await f.session.refresh()
      expect(f.session.migration.blocked).toBe(true)
      expect(() => f.session.requestMigration()).toThrow()
      expect(await readFile(join(checkout.target, "gpui-kit.d.ts"), "utf8")).toContain("unknown")
      await rm(join(checkout.target, "gpui-kit.d.ts"))
      const objects = join(checkout.target, ".git/objects")
      // A linked object store is an intentional local change, not a remote attack fixture.
      const { rename } = await import("node:fs/promises")
      const outside = join(f.root, "outside-objects")
      await rename(objects, outside)
      await symlink(outside, objects)
      const outsideBefore = await readdir(outside)
      await f.session.refresh()
      expect(f.session.migration.blocked).toBe(true)
      expect(() => f.session.requestMigration()).toThrow()
      expect(await readdir(outside)).toEqual(outsideBefore)
    },
    timeout,
  )

  test(
    "checkout updates retain private index and branch-ref permissions",
    async () => {
      const f = await fixture()
      const checkout = await legacyCheckout(f)
      const index = join(checkout.target, ".git/index")
      const ref = join(checkout.target, ".git/refs/heads/main")
      await chmod(index, 0o600)
      await chmod(ref, 0o600)
      await f.session.refresh()
      await migrate(f.session)
      const mod = f.session.list("installed")[0]
      await f.commit("2")
      await f.session.checkUpdates()
      await f.session.perform("update", mod.id)
      expect((await stat(index)).mode & 0o777).toBe(0o600)
      expect((await stat(ref)).mode & 0o777).toBe(0o600)
      expect(await checkout.git("status", "--porcelain")).toBe("")
    },
    timeout,
  )

  test(
    "the reproduced Git ref-lock failure cannot leave old HEAD with new live files",
    async () => {
      const f = await fixture()
      const checkout = await legacyCheckout(f)
      await f.session.refresh()
      await migrate(f.session)
      const mod = f.session.list("installed")[0]
      const before = await checkout.git("rev-parse", "HEAD")
      const content = await readFile(join(checkout.target, "main.js"), "utf8")
      await f.commit("2")
      await f.session.checkUpdates()
      const lock = join(
        checkout.target,
        ".git",
        `refs/heads/${await checkout.git("branch", "--show-current")}.lock`,
      )
      await writeFile(lock, "another Git writer\n")
      await expect(f.session.perform("update", mod.id)).rejects.toThrow()
      expect(await checkout.git("rev-parse", "HEAD")).toBe(before)
      expect(await readFile(join(checkout.target, "main.js"), "utf8")).toBe(content)
      expect(await checkout.git("status", "--porcelain")).toBe("")
      expect(await readFile(lock, "utf8")).toBe("another Git writer\n")
    },
    timeout,
  )
})
