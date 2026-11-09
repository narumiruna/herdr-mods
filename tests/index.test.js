import { describe, expect, test } from "vitest"
import {
  actionsFor,
  filterMods,
  GALLERY_URL,
  normalizeRepository,
  PREVIEW_MODS,
  PreviewSession,
} from "../preview.js"

const ids = (mods) => mods.map((mod) => mod.id)
const views = (session) =>
  structuredClone({ gallery: session.list("gallery"), installed: session.list("installed") })

describe("preview fixtures and filters", () => {
  test("uses distinct sample IDs and the mods Gallery URL", () => {
    expect(new Set(ids(PREVIEW_MODS)).size).toBe(PREVIEW_MODS.length)
    expect(GALLERY_URL).toBe("https://herdr.dev/gallery/?type=mods")
  })

  test("returns all supplied samples without changing them", () => {
    const before = structuredClone(PREVIEW_MODS)
    expect(filterMods(PREVIEW_MODS, "", "all")).toEqual(PREVIEW_MODS)
    expect(filterMods(PREVIEW_MODS, "   ", "all")).toEqual(PREVIEW_MODS)
    expect(filterMods([PREVIEW_MODS[1]], "", "all")).toEqual([PREVIEW_MODS[1]])
    expect(filterMods([], "", "all")).toEqual([])
    expect(PREVIEW_MODS).toEqual(before)
  })

  test.each([
    ["  FOCUS  ", "all", ["focus-mode"]],
    ["CONTEXT", "all", ["workspace-notes"]],
    ["EXAMPLE/TERMINAL", "all", ["terminal-tools"]],
    ["", "github", ["focus-mode", "workspace-notes", "terminal-tools"]],
    ["", "development", ["mod-manager"]],
    ["checkout", "development", ["mod-manager"]],
    ["focus", "development", []],
    ["not-a-mod", "all", []],
  ])("filters query %j and source %s", (query, source, expected) => {
    expect(ids(filterMods(PREVIEW_MODS, query, source))).toEqual(expected)
  })

  test.each([
    ["available", ["install"]],
    ["enabled", ["disable", "uninstall"]],
    ["disabled", ["enable", "uninstall"]],
  ])("maps %s state to its actions", (state, expected) => {
    expect(actionsFor({ ...PREVIEW_MODS[0], state })).toEqual(expected)
  })
})

describe("repository normalization", () => {
  test.each([
    ["https://github.com/owner/repository", "owner/repository"],
    ["  https://github.com/Owner/Repository  ", "owner/repository"],
    ["HTTPS://GITHUB.COM/Owner/Repository", "owner/repository"],
    ["https://github.com/Owner/Repository/", "owner/repository"],
    ["https://github.com/Owner/Repository.git", "owner/repository"],
    ["https://github.com/Owner/Repository.GIT/", "owner/repository"],
    ["https://github.com/a/repo_name.v2-test", "a/repo_name.v2-test"],
    [
      `https://github.com/${"a".repeat(39)}/${"b".repeat(100)}`,
      `${"a".repeat(39)}/${"b".repeat(100)}`,
    ],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeRepository(input)).toBe(expected)
  })

  test.each([
    "",
    "   ",
    "owner/repository",
    "github.com/owner/repository",
    "http://github.com/owner/repository",
    "ssh://github.com/owner/repository",
    "git@github.com:owner/repository.git",
    "https://gitlab.com/owner/repository",
    "https://www.github.com/owner/repository",
    "https://github.com.example.com/owner/repository",
    "https://example.com/github.com/owner/repository",
    "https://user@github.com/owner/repository",
    "https://user:password@github.com/owner/repository",
    "https://github.com:443/owner/repository",
    "https://github.com",
    "https://github.com/owner",
    "https://github.com/owner/",
    "https://github.com//repository",
    "https://github.com/owner/repository//",
    "https://github.com/owner/repository/tree/main",
    "https://github.com/owner/repository/issues",
    "https://github.com/owner/repository?tab=readme",
    "https://github.com/owner/repository#readme",
    "https://github.com/-owner/repository",
    "https://github.com/owner-/repository",
    "https://github.com/owner_name/repository",
    "https://github.com/owner/repo name",
    "https://github.com/owner/repo%20name",
    "https://github.com/owner/.",
    "https://github.com/owner/..",
    "https://github.com/owner/.git",
    `https://github.com/${"a".repeat(40)}/repository`,
    `https://github.com/owner/${"a".repeat(101)}`,
  ])("rejects %j", (input) => {
    expect(() => normalizeRepository(input)).toThrow(/GitHub repository URL/)
  })
})

describe("session lists and isolation", () => {
  test("starts with all gallery states and the protected installed manager", () => {
    const session = new PreviewSession()
    expect(session.list("gallery").map(({ id, state }) => [id, state])).toEqual([
      ["focus-mode", "enabled"],
      ["workspace-notes", "disabled"],
      ["terminal-tools", "available"],
    ])
    expect(ids(session.list("installed"))).toEqual(["focus-mode", "workspace-notes", "mod-manager"])
    expect(session.mod("mod-manager")).toMatchObject({
      gallery: false,
      state: "enabled",
      source: "development",
      protectedReason: expect.any(String),
    })
    expect(session.pending).toBeNull()
    expect(session.uninstallId).toBeNull()
  })

  test.each([
    ["gallery", "  TERMINAL  ", "all", ["focus-mode", "terminal-tools"]],
    ["installed", "terminal", "all", ["focus-mode"]],
    ["installed", "terminal-tools", "all", []],
    ["installed", "CONTEXT", "github", ["workspace-notes"]],
    ["installed", "checkout", "development", ["mod-manager"]],
    ["gallery", "", "development", []],
    ["installed", "", "github", ["focus-mode", "workspace-notes"]],
    ["gallery", "not-a-mod", "all", []],
  ])("filters the %s list with %j and %s", (section, query, source, expected) => {
    expect(ids(new PreviewSession().list(section, query, source))).toEqual(expected)
  })

  test("clones fixture objects and resets state in each fresh session", () => {
    const fixtures = structuredClone(PREVIEW_MODS)
    const session = new PreviewSession()
    const untouched = new PreviewSession()
    for (const fixture of PREVIEW_MODS) {
      expect(session.mod(fixture.id)).not.toBe(fixture)
      expect(session.mod(fixture.id)).not.toBe(untouched.mod(fixture.id))
    }
    session.mod("focus-mode").description = "Changed only in this session"
    session.start("install", "terminal-tools")
    session.complete()
    session.installRepository("https://github.com/example/custom-sample")
    session.complete()
    session.requestUninstall("workspace-notes")

    expect(PREVIEW_MODS).toEqual(fixtures)
    expect(views(untouched)).toEqual(views(new PreviewSession()))
    expect(untouched.mod("terminal-tools").state).toBe("available")
    expect(untouched.mod("focus-mode").description).toBe(fixtures[0].description)
    expect(untouched.list("installed")).toHaveLength(3)
    expect(untouched.pending).toBeNull()
    expect(untouched.uninstallId).toBeNull()
  })
})

describe("session actions", () => {
  test("commits install, disable, enable, and confirmed uninstall across both lists", () => {
    const session = new PreviewSession()
    for (const [action, state, count] of [
      ["install", "enabled", 4],
      ["disable", "disabled", 4],
      ["enable", "enabled", 4],
      ["uninstall", "available", 3],
    ]) {
      const before = views(session)
      if (action === "uninstall") {
        session.requestUninstall("terminal-tools")
        expect(session.uninstallId).toBe("terminal-tools")
        expect(session.pending).toBeNull()
        expect(views(session)).toEqual(before)
      }
      session.start(action, "terminal-tools")
      expect(session.pending).toMatchObject({ action, mod: { id: "terminal-tools" } })
      expect(session.uninstallId).toBeNull()
      expect(views(session)).toEqual(before)

      const result = session.complete()
      expect(result).toEqual({ action, mod: session.mod("terminal-tools") })
      expect(result.mod.state).toBe(state)
      expect(session.pending).toBeNull()
      expect(session.list("gallery")).toHaveLength(3)
      expect(session.list("gallery")).toContainEqual(result.mod)
      expect(session.list("installed")).toHaveLength(count)
      expect(session.list("installed").includes(result.mod)).toBe(state !== "available")
      expect(() => session.start(action, "terminal-tools")).toThrow()
      expect(() => session.complete()).toThrow(/No preview action/)
    }
  })

  test.each(["focus-mode", "workspace-notes"])(
    "requires confirmation to uninstall %s and allows cancellation",
    (id) => {
      const session = new PreviewSession()
      const before = views(session)
      expect(() => session.start("uninstall", id)).toThrow(/Confirm/)
      session.requestUninstall(id)
      expect(session.uninstallId).toBe(id)
      session.cancelUninstall()
      expect(session.uninstallId).toBeNull()
      expect(session.pending).toBeNull()
      expect(views(session)).toEqual(before)
      expect(() => session.start("uninstall", id)).toThrow(/Confirm/)
      session.requestUninstall(id)
      session.start("uninstall", id)
      session.complete()
      expect(session.mod(id).state).toBe("available")
      expect(ids(session.list("installed"))).not.toContain(id)
      expect(ids(session.list("gallery"))).toContain(id)
    },
  )

  test.each([
    ["disable", "focus-mode"],
    ["enable", "workspace-notes"],
    ["uninstall", "workspace-notes"],
    ["install", "terminal-tools"],
  ])("failed %s preserves state and can be retried", (action, id) => {
    const session = new PreviewSession()
    const before = views(session)
    const start = () => {
      if (action === "uninstall") session.requestUninstall(id)
      session.start(action, id)
    }
    start()
    session.fail()
    expect(session.pending).toBeNull()
    expect(session.uninstallId).toBeNull()
    expect(views(session)).toEqual(before)
    expect(() => session.complete()).toThrow(/No preview action/)
    start()
    expect(session.complete().action).toBe(action)
  })

  test.each([
    ["install", "focus-mode"],
    ["enable", "focus-mode"],
    ["install", "workspace-notes"],
    ["disable", "workspace-notes"],
    ["enable", "terminal-tools"],
    ["disable", "terminal-tools"],
    ["uninstall", "terminal-tools"],
    ["update", "focus-mode"],
  ])("rejects invalid action %s on %s", (action, id) => {
    const session = new PreviewSession()
    const before = views(session)
    expect(() => session.start(action, id)).toThrow(/not available/)
    expect(session.pending).toBeNull()
    expect(views(session)).toEqual(before)
  })

  test("rejects uninstall requests for available samples", () => {
    const session = new PreviewSession()
    expect(() => session.requestUninstall("terminal-tools")).toThrow(/not available/)
    expect(session.uninstallId).toBeNull()
  })

  test.each(["install", "enable", "disable", "uninstall", "requestUninstall"])(
    "protects the manager from %s",
    (action) => {
      const session = new PreviewSession()
      const before = views(session)
      const attempt = () =>
        action === "requestUninstall"
          ? session.requestUninstall("mod-manager")
          : session.start(action, "mod-manager")
      expect(attempt).toThrow(/protected/)
      expect(views(session)).toEqual(before)
      expect(session.pending).toBeNull()
      expect(session.uninstallId).toBeNull()
    },
  )

  test("rejects unknown IDs without changing the session", () => {
    const session = new PreviewSession()
    const before = views(session)
    expect(() => session.mod("unknown")).toThrow(/not found/)
    for (const action of ["install", "enable", "disable", "uninstall"]) {
      expect(() => session.start(action, "unknown")).toThrow(/not found/)
    }
    expect(() => session.requestUninstall("unknown")).toThrow(/not found/)
    expect(views(session)).toEqual(before)
    expect(session.pending).toBeNull()
    expect(session.uninstallId).toBeNull()
  })

  test("handles no pending action without changing the lists", () => {
    const session = new PreviewSession()
    const before = views(session)
    expect(() => session.complete()).toThrow(/No preview action/)
    session.fail()
    session.cancelUninstall()
    expect(session.pending).toBeNull()
    expect(session.uninstallId).toBeNull()
    expect(views(session)).toEqual(before)
  })
})

describe("action conflicts", () => {
  test.each([
    ["disable", "focus-mode"],
    ["enable", "workspace-notes"],
    ["uninstall", "workspace-notes"],
  ])("blocks duplicate and conflicting work during %s", (action, id) => {
    const session = new PreviewSession()
    const before = views(session)
    if (action === "uninstall") session.requestUninstall(id)
    session.start(action, id)
    expect(() => session.start(action, id)).toThrow(/in progress/)
    expect(() => session.start("install", "terminal-tools")).toThrow(/in progress/)
    expect(() => session.requestUninstall("focus-mode")).toThrow(/in progress/)
    expect(() => session.installRepository("https://github.com/example/new-sample")).toThrow(
      /in progress/,
    )
    expect(session.pending).toMatchObject({ action, mod: { id } })
    expect(views(session)).toEqual(before)
    expect(session.complete()).toMatchObject({ action, mod: { id } })
  })

  const attempts = [
    ["duplicate install", (session, url) => session.installRepository(url)],
    ["catalogue install", (session) => session.start("install", "terminal-tools")],
    ["disable", (session) => session.start("disable", "focus-mode")],
    ["enable", (session) => session.start("enable", "workspace-notes")],
    ["uninstall", (session) => session.start("uninstall", "focus-mode")],
    ["uninstall request", (session) => session.requestUninstall("focus-mode")],
    ["new repository", (session) => session.installRepository("https://github.com/other/sample")],
  ]

  describe.each([
    ["catalogue", "https://github.com/example/terminal-tools"],
    ["new GitHub sample", "https://github.com/example/custom-sample"],
  ])("while installing a %s", (_label, url) => {
    test.each(attempts)("blocks %s without replacing pending work", (_label, attempt) => {
      const session = new PreviewSession()
      const before = views(session)
      session.installRepository(url)
      const pending = session.pending
      expect(() => attempt(session, url)).toThrow(/in progress/)
      expect(session.pending).toBe(pending)
      expect(session.uninstallId).toBeNull()
      expect(views(session)).toEqual(before)
      expect(session.complete()).toMatchObject({
        action: "install",
        mod: { repository: normalizeRepository(url), state: "enabled" },
      })
      expect(session.list("installed")).toHaveLength(4)
    })
  })

  test.each([
    ["disable", (session) => session.start("disable", "focus-mode")],
    ["enable", (session) => session.start("enable", "workspace-notes")],
    ["different uninstall", (session) => session.start("uninstall", "workspace-notes")],
    ["different confirmation", (session) => session.requestUninstall("workspace-notes")],
    [
      "catalogue install",
      (session) => session.installRepository("https://github.com/example/terminal-tools"),
    ],
    [
      "new repository",
      (session) => session.installRepository("https://github.com/example/new-sample"),
    ],
  ])("blocks %s until uninstall confirmation is resolved", (_label, attempt) => {
    const session = new PreviewSession()
    const before = views(session)
    session.requestUninstall("focus-mode")
    expect(() => attempt(session)).toThrow(/Confirm or cancel/)
    expect(session.uninstallId).toBe("focus-mode")
    expect(session.pending).toBeNull()
    expect(views(session)).toEqual(before)
    session.cancelUninstall()
    session.start("disable", "focus-mode")
    expect(session.complete().mod.state).toBe("disabled")
  })
})

describe("GitHub preview installation", () => {
  test.each([
    "not a URL",
    "http://github.com/owner/repo",
    "https://github.com/owner/repo?tab=readme",
  ])("rejects invalid input %j without creating pending work", (input) => {
    const session = new PreviewSession()
    const before = views(session)
    expect(() => session.installRepository(input)).toThrow(/GitHub repository URL/)
    expect(session.pending).toBeNull()
    expect(views(session)).toEqual(before)
  })

  test("reuses a matching catalogue sample instead of adding a duplicate", () => {
    const session = new PreviewSession()
    const before = views(session)
    session.installRepository("  HTTPS://GITHUB.COM/Example/Terminal-Tools.GIT/  ")
    expect(session.pending).toMatchObject({ action: "install", mod: { id: "terminal-tools" } })
    expect(views(session)).toEqual(before)
    expect(session.complete().mod.id).toBe("terminal-tools")
    expect(session.list("gallery")).toHaveLength(3)
    expect(session.list("installed")).toHaveLength(4)
    expect(session.list("installed", "example/terminal-tools")).toHaveLength(1)
    session.requestUninstall("terminal-tools")
    session.start("uninstall", "terminal-tools")
    session.complete()
    session.installRepository("https://github.com/example/terminal-tools/")
    expect(session.complete().mod.id).toBe("terminal-tools")
    expect(session.list("installed", "example/terminal-tools")).toHaveLength(1)
  })

  test.each(["focus-mode", "workspace-notes"])(
    "does not reinstall the already installed catalogue sample %s",
    (id) => {
      const session = new PreviewSession()
      const before = views(session)
      expect(() => session.installRepository(`https://github.com/EXAMPLE/${id}.git/`)).toThrow(
        /not available/,
      )
      expect(session.pending).toBeNull()
      expect(views(session)).toEqual(before)
    },
  )

  test("adds a custom sample only to Installed and removes it on confirmed uninstall", () => {
    const session = new PreviewSession()
    const gallery = session.list("gallery")
    const before = views(session)
    session.installRepository("https://github.com/Some-Owner/Custom-Sample.GIT/")
    expect(session.pending).toMatchObject({
      action: "install",
      mod: { repository: "some-owner/custom-sample", source: "github", gallery: false },
    })
    expect(views(session)).toEqual(before)
    const { mod } = session.complete()
    expect(mod.state).toBe("enabled")
    expect(session.list("gallery")).toEqual(gallery)
    expect(session.list("installed")).toHaveLength(4)
    expect(session.list("installed", "SOME-OWNER/CUSTOM", "github")).toEqual([mod])
    expect(session.list("installed", "custom", "development")).toEqual([])

    for (const url of [
      "https://github.com/some-owner/custom-sample",
      "https://github.com/SOME-OWNER/CUSTOM-SAMPLE.git/",
    ]) {
      expect(() => session.installRepository(url)).toThrow(/not available/)
      expect(session.pending).toBeNull()
      expect(session.list("installed", "some-owner/custom-sample")).toHaveLength(1)
    }
    session.start("disable", mod.id)
    session.complete()
    expect(() => session.installRepository("https://github.com/some-owner/custom-sample/")).toThrow(
      /not available/,
    )
    session.requestUninstall(mod.id)
    session.start("uninstall", mod.id)
    expect(session.list("installed", "some-owner/custom-sample")).toHaveLength(1)
    expect(session.complete()).toMatchObject({ action: "uninstall", mod: { id: mod.id } })
    expect(views(session)).toEqual(before)

    session.installRepository("https://github.com/SOME-OWNER/CUSTOM-SAMPLE.git")
    expect(session.complete()).toMatchObject({
      action: "install",
      mod: { id: mod.id, state: "enabled", repository: "some-owner/custom-sample" },
    })
    expect(session.list("installed", "some-owner/custom-sample")).toHaveLength(1)
    expect(session.list("installed")).toHaveLength(4)
    expect(session.list("gallery")).toEqual(gallery)
  })

  test("a failed new installation leaves no sample and permits a clean retry", () => {
    const session = new PreviewSession()
    const before = views(session)
    session.installRepository("https://github.com/example/never-fetched")
    session.fail()
    expect(session.pending).toBeNull()
    expect(views(session)).toEqual(before)
    expect(() => session.complete()).toThrow(/No preview action/)
    session.installRepository("https://github.com/EXAMPLE/NEVER-FETCHED.git/")
    expect(views(session)).toEqual(before)
    const { mod } = session.complete()
    expect(mod).toMatchObject({ repository: "example/never-fetched", state: "enabled" })
    expect(session.list("installed", "never-fetched")).toEqual([mod])
    expect(session.list("gallery", "never-fetched")).toEqual([])
  })
})
