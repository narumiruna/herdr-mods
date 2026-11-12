import { describe, expect, test, vi } from "vitest"
import {
  actionsFor,
  filterMods,
  GALLERY_URL,
  INDEX_URL,
  ManagerSession,
  normalizeRepository,
  sourceURL,
} from "../manager.js"

const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)

function listing(overrides = {}) {
  return {
    owner: "Example",
    repo: "Focus",
    fullName: "Example/Focus",
    url: "https://github.com/Example/Focus",
    defaultBranch: "main",
    headCommit: A,
    stars: 12,
    pushedAt: "2026-11-09T13:00:00Z",
    path: "Recipes/Focus",
    name: "Focus Mode",
    blurb: "A quiet workspace for terminal work.",
    modNames: ["focus"],
    hasKeys: false,
    hasPreview: false,
    recipeBytes: 1024,
    previewUrl: "",
    ...overrides,
  }
}

function index(mods = [listing()]) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-09T13:30:16.274Z",
    modCount: mods.length,
    repositoryCount: new Set(mods.map((mod) => mod.fullName.toLowerCase())).size,
    source: {
      provider: "github",
      query: "topic:herdr-mod is:public",
      totalCount: mods.length,
      collectedCount: mods.length,
      blacklistedCount: 0,
      skippedCount: 0,
      truncated: false,
      warnings: [],
    },
    mods,
  }
}

function installed(overrides = {}) {
  return {
    id: "focus",
    modName: "focus",
    name: "Local manifest title",
    description: "Installed description",
    version: "",
    repository: "example/focus",
    recipePath: "Recipes/Focus",
    source: "github",
    managed: true,
    path: "/fixture/app/mods/focus",
    commit: A,
    identityToken: "record-1",
    ...overrides,
  }
}

// This fixture is the injected backend. It does not read or change real files.
function backend({ mods = [], gallery = index(), migration } = {}) {
  const fixture = {
    mods: structuredClone(mods),
    gallery: structuredClone(gallery),
    remoteCommit: A,
    generation: 1,
    warnings: [],
    migration: migration && structuredClone(migration),
    fastForward: true,
  }
  fixture.io = {
    discover: vi.fn(async () =>
      structuredClone({
        mods: fixture.mods,
        warnings: fixture.warnings,
        ...(fixture.migration ? { migration: fixture.migration } : {}),
      }),
    ),
    fetchGallery: vi.fn(async () => structuredClone(fixture.gallery)),
    operate: vi.fn(async (request) => {
      if (request.action === "migrate") {
        if (request.migrationToken !== fixture.migration.token)
          throw new Error("Stale migration token")
        fixture.migration = { required: false, blocked: false, token: "", targets: [] }
        return { message: "Migration ownership verified." }
      }
      if (request.action === "install") {
        const names = request.modNames ?? [request.recipePath?.split("/").at(-1) || "external"]
        if (names.some((name) => fixture.mods.some((mod) => mod.id === name))) {
          throw new Error("Destination already exists.")
        }
        if (request.expectedCommit && request.expectedCommit !== fixture.remoteCommit) {
          throw new Error("Gallery commit is stale.")
        }
        fixture.mods.push(
          ...names.map((name) =>
            installed({
              id: name,
              modName: name,
              repository: request.repository,
              recipePath: request.recipePath ?? "",
              path: `/fixture/app/mods/${name}`,
              commit: fixture.remoteCommit,
              identityToken: `record-${++fixture.generation}`,
            }),
          ),
        )
        return {
          ids: names,
          commit: fixture.remoteCommit,
          message: "Files verified. Runtime state is separate.",
        }
      }
      const mod = fixture.mods.find((mod) => mod.id === request.id)
      if (!mod) throw new Error("Target not found.")
      if (
        mod.commit !== request.expectedCommit ||
        mod.path !== request.path ||
        mod.identityToken !== request.identityToken
      )
        throw new Error("Stale backend target.")
      if (request.action === "check-update") {
        return {
          commit: mod.commit,
          updateCommit: mod.commit === fixture.remoteCommit ? null : fixture.remoteCommit,
        }
      }
      if (request.action === "update") {
        if (!fixture.fastForward) throw new Error("Update rejected: not a fast-forward.")
        mod.commit = fixture.remoteCommit
        mod.identityToken = `record-${++fixture.generation}`
        return { ids: [mod.id], commit: mod.commit }
      }
      if (request.action === "uninstall") {
        fixture.mods = fixture.mods.filter((item) => item !== mod)
        return { ids: [mod.id], commit: mod.commit }
      }
      throw new Error("Unsupported backend action.")
    }),
  }
  return fixture
}

async function loaded(options) {
  const fixture = backend(options)
  const session = new ManagerSession(fixture.io)
  await session.load()
  return { fixture, session }
}

const focus = (session) => session.list("gallery").find((mod) => mod.modName === "focus")
const pages = (session) =>
  structuredClone({ gallery: session.list("gallery"), installed: session.list("installed") })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("live Gallery metadata", () => {
  test("uses the production endpoints and does not invent a version or enabled state", async () => {
    expect(GALLERY_URL).toBe("https://herdr.dev/gallery/?type=mods")
    expect(INDEX_URL).toBe("https://assets.herdr.dev/mods/index.json")
    const { session } = await loaded()
    expect(focus(session)).toMatchObject({
      name: "Focus Mode",
      description: "A quiet workspace for terminal work.",
      repository: "example/focus",
      recipePath: "Recipes/Focus",
      modName: "focus",
      version: "",
      icon: "package",
      source: "github",
      gallery: true,
      state: "available",
      managed: false,
      commit: A,
    })
    expect(focus(session)).not.toHaveProperty("enabled")
    expect(session.list("installed")).toEqual([])
    expect(actionsFor(focus(session))).toEqual(["install"])
  })

  test("accepts the production source shape without optional warnings", async () => {
    const data = index()
    delete data.source.warnings
    const { session } = await loaded({ gallery: data })
    expect(session.galleryStatus).toBe("ready")
    expect(session.galleryError).toBe("")
    expect(session.warnings).toEqual([])
    expect(session.list("gallery")).toHaveLength(1)
  })

  test("expands bundles into stable, separately installable identities", async () => {
    const { fixture, session } = await loaded({
      gallery: index([listing({ modNames: ["focus", "focus-header"] })]),
    })
    const [first, second] = session.list("gallery")
    expect(first.name).toBe("Focus Mode — focus")
    expect(second.name).toBe("Focus Mode — focus-header")
    expect(first.id).not.toBe(second.id)
    const firstId = first.id
    fixture.gallery.mods[0].name = "Changed display title"
    await session.refresh()
    expect(focus(session).id).toBe(firstId)
    await session.perform("install", second.id)
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "install",
      repository: "example/focus",
      recipePath: "Recipes/Focus",
      modNames: ["focus-header"],
      expectedCommit: A,
    })
    expect(session.list("installed").map((mod) => mod.modName)).toEqual(["focus-header"])
    expect(focus(session).state).toBe("available")
    expect(session.mod(second.id).state).toBe("installed")
  })

  test("keeps recipe and folder case, optional version and source warnings", async () => {
    const data = index([listing({ path: "", version: "custom-release", modNames: ["Focus"] })])
    data.source.truncated = true
    data.source.warnings = ["One repository was skipped."]
    const { session } = await loaded({ gallery: data })
    expect(session.list("gallery")[0]).toMatchObject({
      recipePath: "",
      modName: "Focus",
      version: "custom-release",
    })
    expect(session.warnings).toEqual([
      "One repository was skipped.",
      "The Gallery source reports truncated results.",
    ])
  })

  test.each([
    [
      "unknown schema",
      (data) => {
        data.schemaVersion = 2
      },
    ],
    [
      "missing schema",
      (data) => {
        delete data.schemaVersion
      },
    ],
    [
      "missing mods",
      (data) => {
        delete data.mods
      },
    ],
    [
      "bad listing count",
      (data) => {
        data.modCount = 0
      },
    ],
    [
      "bad repository count",
      (data) => {
        data.repositoryCount = 0
      },
    ],
    [
      "invalid date",
      (data) => {
        data.generatedAt = "not a date"
      },
    ],
    [
      "bad warnings",
      (data) => {
        data.source.warnings = "warning"
      },
    ],
    [
      "source provider",
      (data) => {
        data.source.provider = "other"
      },
    ],
    [
      "source flag",
      (data) => {
        data.source.truncated = "false"
      },
    ],
    [
      "source count",
      (data) => {
        data.source.totalCount = 10000001
      },
    ],
    [
      "source text",
      (data) => {
        data.source.query = "q".repeat(513)
      },
    ],
    [
      "repository stars",
      (data) => {
        data.mods[0].stars = -1
      },
    ],
    [
      "repository branch",
      (data) => {
        data.mods[0].defaultBranch = "b".repeat(256)
      },
    ],
    [
      "repository date",
      (data) => {
        data.mods[0].pushedAt = "not a date"
      },
    ],
    [
      "recipe size",
      (data) => {
        data.mods[0].recipeBytes = -1
      },
    ],
    [
      "preview URL length",
      (data) => {
        data.mods[0].previewUrl = "u".repeat(2049)
      },
    ],
    [
      "listing flag",
      (data) => {
        data.mods[0].hasPreview = "false"
      },
    ],
    [
      "owner mismatch",
      (data) => {
        data.mods[0].owner = "other"
      },
    ],
    [
      "fullName mismatch",
      (data) => {
        data.mods[0].fullName = "example/other"
      },
    ],
    [
      "URL mismatch",
      (data) => {
        data.mods[0].url = "https://github.com/other/focus"
      },
    ],
    [
      "URL credentials",
      (data) => {
        data.mods[0].url = "https://user@github.com/Example/Focus"
      },
    ],
    [
      "URL query",
      (data) => {
        data.mods[0].url += "?tab=readme"
      },
    ],
    [
      "insecure URL",
      (data) => {
        data.mods[0].url = "http://github.com/Example/Focus"
      },
    ],
    [
      "invalid commit",
      (data) => {
        data.mods[0].headCommit = "1234"
      },
    ],
    [
      "nonhex commit",
      (data) => {
        data.mods[0].headCommit = "g".repeat(40)
      },
    ],
    [
      "missing modNames",
      (data) => {
        delete data.mods[0].modNames
      },
    ],
    [
      "empty bundle",
      (data) => {
        data.mods[0].modNames = []
      },
    ],
    [
      "duplicate folder",
      (data) => {
        data.mods[0].modNames = ["focus", "focus"]
      },
    ],
    [
      "duplicate listing",
      (data) => {
        data.mods.push(structuredClone(data.mods[0]))
        data.modCount++
      },
    ],
    [
      "oversized name",
      (data) => {
        data.mods[0].name = "n".repeat(257)
      },
    ],
    [
      "oversized description",
      (data) => {
        data.mods[0].blurb = "d".repeat(4097)
      },
    ],
    [
      "control text",
      (data) => {
        data.mods[0].blurb = "bad\u0000text"
      },
    ],
    [
      "excess bundle count",
      (data) => {
        data.mods[0].modNames = Array(129).fill("focus")
      },
    ],
    [
      "excess listing count",
      (data) => {
        data.mods = Array(10001).fill(data.mods[0])
        data.modCount = 10001
      },
    ],
  ])("rejects %s as an error, not an empty ready Gallery", async (_name, change) => {
    const data = index()
    change(data)
    const { session } = await loaded({ gallery: data })
    expect(session.galleryStatus).toBe("error")
    expect(session.galleryError).not.toBe("")
    expect(session.discoveryStatus).toBe("ready")
    expect(session.list("gallery")).toEqual([])
  })

  test.each([
    "../Focus",
    "a/../Focus",
    "/Focus",
    "a//b",
    "a/",
    "./a",
    "a\\b",
    "a/%2e%2e",
    "C:/a",
    "a\u0000b",
    "a/..",
    "a/.git",
  ])("rejects unsafe recipe path %j", async (path) => {
    const { session } = await loaded({ gallery: index([listing({ path })]) })
    expect(session.galleryStatus).toBe("error")
    expect(session.galleryError).toMatch(/recipe path|metadata text/)
  })

  test.each([
    "..",
    ".",
    ".hidden",
    "../x",
    "a/b",
    "a\\b",
    "a%2fb",
    "a b",
    "-option",
    "a".repeat(129),
  ])("rejects unsafe folder ID %j", async (name) => {
    const { session } = await loaded({ gallery: index([listing({ modNames: [name] })]) })
    expect(session.galleryStatus).toBe("error")
    expect(session.galleryError).toMatch(/folder ID/)
  })
})

describe("recorded source links", () => {
  test("pins valid repository, commit and case-sensitive recipe directory", () => {
    expect(sourceURL({ repository: "Example/Focus", commit: A, recipePath: "Mods/Focus" })).toBe(
      `https://github.com/example/focus/tree/${A}/Mods/Focus`,
    )
    expect(sourceURL({ repository: "example/focus", commit: A, recipePath: "" })).toBe(
      `https://github.com/example/focus/tree/${A}`,
    )
    expect(sourceURL({ repository: "example/focus", commit: "", recipePath: "Mods/Focus" })).toBe(
      "https://github.com/example/focus",
    )
  })

  test("opens the checked update revision instead of the old installed commit", () => {
    expect(
      sourceURL({
        repository: "example/focus",
        commit: A,
        updateCommit: B,
        recipePath: "Mods/Focus",
      }),
    ).toBe(`https://github.com/example/focus/tree/${B}/Mods/Focus`)
    expect(
      sourceURL({
        repository: "example/focus",
        commit: A,
        updateCommit: "invalid",
        recipePath: "",
      }),
    ).toBe("")
  })

  test.each([
    { repository: "user:password@github.com/owner/repo", commit: A, recipePath: "" },
    { repository: "https://evil.invalid/x", commit: A, recipePath: "" },
    { repository: "example/focus", commit: "HEAD?x=1", recipePath: "" },
    { repository: "example/focus", commit: A, recipePath: "../outside" },
    { repository: "", commit: A, recipePath: "" },
  ])("does not expose an unsafe source URL: %j", (mod) => expect(sourceURL(mod)).toBe(""))
})

describe("strict GitHub URL normalization", () => {
  test.each([
    ["https://github.com/Owner/Repo", "owner/repo"],
    [" HTTPS://GITHUB.COM/Owner/Repo.GIT/ ", "owner/repo"],
    ["https://github.com/a/repo_name.v2-test", "a/repo_name.v2-test"],
    [
      `https://github.com/${"a".repeat(39)}/${"b".repeat(100)}`,
      `${"a".repeat(39)}/${"b".repeat(100)}`,
    ],
  ])("normalizes %s", (input, expected) => expect(normalizeRepository(input)).toBe(expected))

  test.each([
    "",
    "owner/repo",
    "github.com/owner/repo",
    "http://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "ssh://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://github.com.evil.test/owner/repo",
    "https://www.github.com/owner/repo",
    "https://user@github.com/owner/repo",
    "https://user:pass@github.com/owner/repo",
    "https://github.com:443/owner/repo",
    "https://github.com/owner/repo?x=1",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/repo//",
    "https://github.com/-owner/repo",
    "https://github.com/owner-/repo",
    "https://github.com/owner_name/repo",
    "https://github.com/owner/.",
    "https://github.com/owner/..",
    "https://github.com/owner/.git",
    "https://github.com/owner/repo%20name",
    "https://github.com/owner/repo name",
    `https://github.com/${"a".repeat(40)}/repo`,
    `https://github.com/owner/${"a".repeat(101)}`,
  ])("rejects %j", (input) =>
    expect(() => normalizeRepository(input)).toThrow(/GitHub repository URL/),
  )
})

describe("independent loading, retry and search", () => {
  test("publishes each source while the other is loading", async () => {
    const gallery = deferred()
    const discovery = deferred()
    const fixture = backend()
    fixture.io.fetchGallery.mockReturnValue(gallery.promise)
    fixture.io.discover.mockReturnValue(discovery.promise)
    const session = new ManagerSession(fixture.io)
    expect([session.galleryStatus, session.discoveryStatus]).toEqual(["idle", "idle"])
    const work = session.load()
    expect([session.galleryStatus, session.discoveryStatus]).toEqual(["loading", "loading"])
    gallery.resolve(index())
    await vi.waitFor(() => expect(session.galleryStatus).toBe("ready"))
    expect(session.discoveryStatus).toBe("loading")
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(/discovery/)
    discovery.resolve({ mods: [installed()], warnings: ["Unreadable manifest was protected."] })
    await work
    expect(focus(session).state).toBe("installed")
    expect(session.warnings).toEqual(["Unreadable manifest was protected."])
  })

  test("Gallery failure does not hide installed mods; retry restores matching", async () => {
    const fixture = backend({ mods: [installed()] })
    fixture.io.fetchGallery.mockRejectedValueOnce(new Error("Network unavailable."))
    const session = new ManagerSession(fixture.io)
    await session.load()
    expect(session.galleryStatus).toBe("error")
    expect(session.galleryError).toBe("Network unavailable.")
    expect(session.discoveryStatus).toBe("ready")
    expect(session.list("installed")).toHaveLength(1)
    const installedId = session.list("installed")[0].id
    await session.refresh()
    expect(session.galleryStatus).toBe("ready")
    expect(session.galleryError).toBe("")
    expect(focus(session).id).toBe(installedId)
    expect(focus(session).state).toBe("installed")
  })

  test("discovery errors retain last state but block all mutations", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const before = pages(session)
    fixture.io.discover.mockRejectedValue(new Error("Inventory is unreadable."))
    fixture.io.fetchGallery.mockRejectedValue(new Error("Offline."))
    await session.refresh()
    expect(session.discoveryStatus).toBe("error")
    expect(session.discoveryError).toBe("Inventory is unreadable.")
    expect(pages(session)).toEqual(before)
    expect(() => session.requestUninstall(focus(session).id)).toThrow(/discovery/)
    await expect(session.installRepository("https://github.com/example/other")).rejects.toThrow(
      /discovery/,
    )
    await expect(session.perform("update", focus(session).id)).rejects.toThrow(/discovery/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    fixture.io.discover.mockImplementation(async () => ({ mods: fixture.mods, warnings: [] }))
    fixture.io.fetchGallery.mockResolvedValue(index())
    await session.refresh()
    expect([session.galleryStatus, session.discoveryStatus]).toEqual(["ready", "ready"])
    expect(session.discoveryError).toBe("")
  })

  test("a valid empty Gallery and no-results search remain distinct from errors", async () => {
    const { fixture, session } = await loaded({ gallery: index([]), mods: [installed()] })
    expect(session.galleryStatus).toBe("ready")
    expect(session.galleryError).toBe("")
    expect(session.list("gallery")).toEqual([])
    expect(session.list("installed")).toHaveLength(1)
    fixture.gallery = index()
    await session.refresh()
    expect(session.list("gallery", "not present")).toEqual([])
    expect(session.galleryStatus).toBe("ready")
    expect(session.list("gallery", "")).toHaveLength(1)
  })

  test("searches name, description and repository and keeps every source filter", async () => {
    const mods = [
      installed(),
      ...["local", "development", "shipped"].map((source) =>
        installed({
          id: source,
          modName: source,
          name: `${source} title`,
          repository: "",
          source,
          description: "An independent installed mod.",
          managed: false,
          path: `/fixture/app/mods/${source}`,
          commit: "",
          identityToken: undefined,
        }),
      ),
    ]
    const { session } = await loaded({ mods })
    expect(session.list("installed")).toHaveLength(4)
    expect(session.list("gallery")).toHaveLength(1)
    expect(session.list("gallery", "  FOCUS MODE ")).toHaveLength(1)
    expect(session.list("installed", " QUIET WORKSPACE ", "github")).toHaveLength(1)
    expect(session.list("gallery", "EXAMPLE/FOCUS")).toHaveLength(1)
    for (const source of ["github", "development", "local", "shipped"]) {
      expect(session.list("installed", "", source)).toHaveLength(1)
    }
    expect(session.list("gallery", "", "local")).toEqual([])
    expect(filterMods(session.mods, "  ", "all")).toEqual(session.mods)
    expect(filterMods(session.mods, "missing", "all")).toEqual([])
  })

  test("bounds large discovery warning displays without rejecting a valid inventory", async () => {
    const { fixture, session } = await loaded()
    fixture.warnings = Array.from(
      { length: 405 },
      (_, position) => `Unreadable manifest ${position}.`,
    )
    await session.refresh()
    expect(session.discoveryStatus).toBe("ready")
    expect(session.warnings).toHaveLength(201)
    expect(session.warnings.at(-1)).toBe("205 additional discovery warnings.")
  })

  test("a stale fetch cannot overwrite a newer refresh", async () => {
    const { fixture, session } = await loaded()
    const old = deferred()
    fixture.io.fetchGallery.mockReturnValueOnce(old.promise)
    const first = session.refresh()
    fixture.gallery.mods[0].name = "New title"
    await session.refresh()
    old.resolve(index([listing({ name: "Stale title" })]))
    await first
    expect(focus(session).name).toBe("New title")
    expect(session.galleryStatus).toBe("ready")
  })
})

describe("verified discovery identity and protection", () => {
  test("read-only fallback blocks all operations and a verified refresh restores them", async () => {
    const { fixture, session } = await loaded()
    fixture.io.discover.mockResolvedValueOnce({
      mods: [],
      warnings: ["Missing tools"],
      readOnlyReason: "Missing tools",
    })
    await session.refreshInstalled()
    expect(session.discoveryStatus).toBe("ready")
    expect(session.readOnlyReason).toBe("Missing tools")
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(
      /Read-only inventory/,
    )
    await expect(session.installRepository("https://github.com/other/repo")).rejects.toThrow(
      /Missing tools/,
    )
    await expect(session.checkUpdates()).rejects.toThrow(/Missing tools/)
    expect(() => session.requestMigration()).toThrow(/Missing tools/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    await session.refreshInstalled()
    expect(session.readOnlyReason).toBe("")
    await session.perform("install", focus(session).id)
    expect(focus(session).state).toBe("installed")
  })

  test("fallback discovered at mutation-time blocks both writes and success readback", async () => {
    const { fixture, session } = await loaded()
    fixture.io.discover.mockResolvedValueOnce({
      mods: [],
      warnings: [],
      readOnlyReason: "Backend timed out",
    })
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(
      /Read-only inventory/,
    )
    expect(fixture.io.operate).not.toHaveBeenCalled()
    await session.refreshInstalled()
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      const result = await real(request)
      fixture.io.discover.mockResolvedValue({
        mods: fixture.mods,
        warnings: [],
        readOnlyReason: "Unverified readback",
      })
      return result
    })
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(
      /Unverified readback/,
    )
    expect(session.lastMessage).toBe("")
    expect(session.readOnlyReason).toBe("Unverified readback")
  })

  test("matches normalized repository and exact recipe/folder, never display title", async () => {
    const { session } = await loaded({ mods: [installed({ repository: "EXAMPLE/FOCUS" })] })
    expect(focus(session).state).toBe("installed")
    expect(focus(session).name).toBe("Focus Mode")
    expect(session.list("installed")).toHaveLength(1)
    for (const changes of [
      { repository: "other/focus" },
      { recipePath: "recipes/Focus" },
      { modName: "other", id: "other", path: "/fixture/app/mods/other" },
      { repository: "", managed: false },
    ]) {
      const { session: different } = await loaded({
        mods: [installed({ name: "Focus Mode", ...changes })],
      })
      expect(focus(different).state).toBe("available")
      expect(different.list("installed")).toHaveLength(1)
      expect(different.list("installed")[0].gallery).toBe(false)
    }
  })

  test("destination collisions are visible and cannot install", async () => {
    const { fixture, session } = await loaded({ mods: [installed({ repository: "other/focus" })] })
    expect(focus(session).protectedReason).toMatch(/another installed identity/)
    expect(actionsFor(focus(session))).toEqual(["install"])
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(
      /another installed identity/,
    )
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test("duplicate discovery identities remain visible and protected", async () => {
    const { fixture, session } = await loaded({ mods: [installed(), installed()] })
    expect(session.discoveryStatus).toBe("ready")
    expect(session.list("installed")).toHaveLength(2)
    expect(new Set(session.mods.map((mod) => mod.id)).size).toBe(session.mods.length)
    expect(session.warnings.join(" ")).toMatch(/identity collision/)
    for (const mod of session.list("installed")) {
      expect(mod.protectedReason).toMatch(/identity collision/)
      expect(() => session.requestUninstall(mod.id)).toThrow(/identity collision/)
    }
    expect(focus(session).state).toBe("available")
    expect(focus(session).protectedReason).toBeTruthy()
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test.each([
    { protectedReason: "The target is a symbolic link." },
    { protectedReason: "The active layout depends on this mod." },
    { protectedReason: "Local files were changed." },
    { protectedReason: "This is the running manager." },
    { managed: false, source: "shipped" },
    { managed: false, source: "development" },
    { managed: false, source: "local" },
    { path: "/fixture/app/mods/../outside" },
    { path: "/fixture/app/mods/focus/" },
    { path: "relative/focus" },
    { path: "/fixture/app/mods/another-folder" },
    { identityToken: undefined },
    { commit: "invalid" },
    { repository: "not a repository" },
    { recipePath: "../unsafe" },
    { modName: "renamed" },
  ])("blocks protected or unverified discovery %j", async (changes) => {
    const { fixture, session } = await loaded({ mods: [installed(changes)] })
    const mod = session.list("installed")[0]
    expect(mod.protectedReason).toBeTruthy()
    expect(actionsFor(mod)).toEqual(["uninstall"])
    expect(() => session.requestUninstall(mod.id)).toThrow()
    await session.checkUpdates()
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test("keeps unsupported existing folder names and long display metadata visible", async () => {
    const local = (id, extra = {}) =>
      installed({
        id,
        modName: id,
        path: `/fixture/app/mods/${id}`,
        repository: "",
        managed: false,
        source: "local",
        ...extra,
      })
    const { session } = await loaded({
      mods: [
        installed(),
        local("bad name"),
        local("本機"),
        local("long-description", {
          name: "n".repeat(300),
          description: "d".repeat(4097),
          version: "v".repeat(140),
        }),
      ],
    })
    expect(session.discoveryStatus).toBe("ready")
    expect(session.list("installed")).toHaveLength(4)
    expect(focus(session).state).toBe("installed")
    const unusual = session.list("installed").find((mod) => mod.modName === "bad name")
    expect(unusual.protectedReason).toBeTruthy()
    expect(() => session.requestUninstall(unusual.id)).toThrow()
    const long = session.list("installed").find((mod) => mod.modName === "long-description")
    expect(long.name.length).toBeLessThanOrEqual(256)
    expect(long.description.length).toBeLessThanOrEqual(4096)
    expect(long.version.length).toBeLessThanOrEqual(128)
    expect(session.warnings.join(" ")).toContain("display metadata")
  })

  test("malformed discovery is an error and does not authorize Gallery writes", async () => {
    const fixture = backend()
    fixture.io.discover.mockResolvedValue({ mods: [{ id: "../escape" }], warnings: [] })
    const session = new ManagerSession(fixture.io)
    await session.load()
    expect(session.discoveryStatus).toBe("error")
    expect(session.galleryStatus).toBe("ready")
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(/discovery/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })
})

describe("one shared live lifecycle", () => {
  test("Gallery install, explicit update check, update and confirmed uninstall refresh both pages", async () => {
    const { fixture, session } = await loaded()
    const id = focus(session).id
    expect(session.pending).toBeNull()
    const operation = session.perform("install", id)
    expect(session.pending).toEqual({ id, action: "install" })
    expect(session.mod(id).state).toBe("available")
    await operation
    expect(session.mod(id).state).toBe("installed")
    expect(session.list("installed")[0]).toBe(session.mod(id))
    expect(actionsFor(session.mod(id))).toEqual(["uninstall"])
    expect(session.lastMessage).toMatch(/Files verified/)
    fixture.remoteCommit = B
    await session.checkUpdates()
    expect(session.mod(id).updateCommit).toBe(B)
    expect(actionsFor(session.mod(id))).toEqual(["uninstall", "update"])
    const token = session.mod(id).identityToken
    await session.perform("update", id)
    expect(fixture.io.operate).toHaveBeenLastCalledWith({
      action: "update",
      id: "focus",
      expectedCommit: A,
      targetCommit: B,
      path: "/fixture/app/mods/focus",
      identityToken: token,
    })
    expect(session.mod(id).commit).toBe(B)
    expect(session.mod(id)).not.toHaveProperty("updateCommit")
    expect(session.list("installed")[0].commit).toBe(B)
    const confirmation = session.requestUninstall(id)
    expect(confirmation).toMatchObject({
      id,
      name: "Focus Mode",
      path: "/fixture/app/mods/focus",
      commit: B,
    })
    expect(Object.isFrozen(confirmation)).toBe(true)
    expect(session.confirmation).toBe(confirmation)
    await session.confirmUninstall()
    expect(fixture.io.operate).toHaveBeenLastCalledWith({
      action: "uninstall",
      id: "focus",
      expectedCommit: B,
      path: confirmation.path,
      identityToken: confirmation.identityToken,
    })
    expect(session.list("installed")).toEqual([])
    expect(session.mod(id).state).toBe("available")
    expect(actionsFor(session.mod(id))).toEqual(["install"])
    expect(session.mod(id).repository).toBe("example/focus")
    expect(session.pending).toBeNull()
    expect(session.confirmation).toBeNull()
    expect(session.uninstallId).toBeNull()
    fixture.remoteCommit = A
    await session.perform("install", id)
    expect(session.mod(id).state).toBe("installed")
  })

  test("cancel preserves records and confirmation blocks conflicting cross-page actions", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const before = pages(session)
    const id = focus(session).id
    session.requestUninstall(id)
    expect(session.uninstallId).toBe(id)
    expect(() => session.requestUninstall(id)).toThrow(/Confirm or cancel/)
    await expect(session.perform("update", id)).rejects.toThrow(/Confirm or cancel/)
    await expect(session.installRepository("https://github.com/example/other")).rejects.toThrow(
      /Confirm or cancel/,
    )
    await expect(session.checkUpdates()).rejects.toThrow(/Confirm or cancel/)
    session.cancelUninstall()
    expect(session.confirmation).toBeNull()
    expect(session.uninstallId).toBeNull()
    expect(pages(session)).toEqual(before)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    await expect(session.confirmUninstall()).rejects.toThrow(/Confirm the uninstall/)
  })

  test("pending is synchronous and duplicate/conflicting calls cannot start a second backend write", async () => {
    const { fixture, session } = await loaded()
    const gate = deferred()
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      await gate.promise
      return real(request)
    })
    const id = focus(session).id
    const first = session.perform("install", id)
    expect(session.pending).toEqual({ id, action: "install" })
    await expect(session.perform("install", id)).rejects.toThrow(/in progress/)
    await expect(session.installRepository("https://github.com/other/repo")).rejects.toThrow(
      /in progress/,
    )
    await expect(session.checkUpdates()).rejects.toThrow(/in progress/)
    expect(() => session.requestUninstall(id)).toThrow(/in progress/)
    expect(() => session.cancelUninstall()).toThrow(/in progress/)
    await vi.waitFor(() => expect(fixture.io.operate).toHaveBeenCalledTimes(1))
    expect(session.mod(id).state).toBe("available")
    expect(session.lastMessage).toBe("")
    gate.resolve()
    await first
    expect(session.pending).toBeNull()
    expect(session.mod(id).state).toBe("installed")
  })

  test("rejects forged actions, missing IDs and actions for the wrong state", async () => {
    const { fixture, session } = await loaded()
    const id = focus(session).id
    for (const action of ["enable", "disable", "uninstall", "check-update", "complete"]) {
      await expect(session.perform(action, id)).rejects.toThrow(/Unsupported action/)
    }
    await expect(session.perform("install", "forged-id")).rejects.toThrow(/not found/)
    await expect(session.perform("update", id)).rejects.toThrow(/not available/)
    expect(() => session.requestUninstall(id)).toThrow(/not available/)
    expect(() => {
      session.mod(id).state = "installed"
    }).toThrow()
    expect(session).not.toHaveProperty("complete")
    expect(session).not.toHaveProperty("enable")
    expect(session).not.toHaveProperty("disable")
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test.each([
    ["commit", B],
    ["path", "/fixture/app/mods/moved"],
    ["identityToken", "reinstalled-same-commit"],
  ])("rejects stale confirmation after %s changes", async (key, value) => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    const confirmation = session.requestUninstall(id)
    fixture.mods[0][key] = value
    await expect(session.confirmUninstall()).rejects.toThrow(/changed|stale/)
    expect(confirmation[key]).not.toBe(value)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    expect(session.list("installed")).toHaveLength(1)
    expect(session.pending).toBeNull()
  })

  test("a refreshed stale confirmation stays blocked until cancel", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    session.requestUninstall(id)
    fixture.mods[0].commit = B
    await session.refresh()
    await expect(session.confirmUninstall()).rejects.toThrow(/stale/)
    expect(session.confirmation).not.toBeNull()
    session.cancelUninstall()
    expect(session.requestUninstall(id).commit).toBe(B)
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test("revalidates protection and discovery before issuing a write", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    session.requestUninstall(id)
    fixture.mods[0].protectedReason = "New active dependency."
    await expect(session.confirmUninstall()).rejects.toThrow(/New active dependency/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    const fresh = await loaded()
    fresh.fixture.io.discover.mockRejectedValue(new Error("Read failed."))
    await expect(fresh.session.perform("install", focus(fresh.session).id)).rejects.toThrow(
      /discovery failed/,
    )
    expect(fresh.fixture.io.operate).not.toHaveBeenCalled()
    expect(fresh.session.pending).toBeNull()
  })

  test("backend-owned records and membership survive manager close/reopen", async () => {
    const { fixture, session } = await loaded()
    const id = focus(session).id
    await session.perform("install", id)
    const reopened = new ManagerSession(fixture.io)
    await reopened.load()
    expect(pages(reopened)).toEqual(pages(session))
    expect(reopened.mod(id).managed).toBe(true)
    expect(reopened.mod(id).identityToken).toBe(session.mod(id).identityToken)
    expect(reopened.pending).toBeNull()
    expect(reopened.confirmation).toBeNull()
  })
})

describe("URL installation uses the same actual discovery", () => {
  test("installs an Installed-only repository, preserves its folder ID and supports uninstall", async () => {
    const { fixture, session } = await loaded()
    const operation = session.installRepository(" HTTPS://GITHUB.COM/Other/External.git/ ")
    expect(session.pending).toEqual({ id: "github:other/external", action: "install" })
    await operation
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "install",
      repository: "other/external",
    })
    expect(session.list("gallery")).toHaveLength(1)
    const mod = session.list("installed")[0]
    expect(mod).toMatchObject({
      repository: "other/external",
      modName: "external",
      state: "installed",
      gallery: false,
    })
    await expect(session.installRepository("https://github.com/Other/External")).rejects.toThrow(
      /already installed/,
    )
    session.requestUninstall(mod.id)
    await session.confirmUninstall()
    expect(session.list("installed")).toEqual([])
    expect(() => session.mod(mod.id)).toThrow(/not found/)
  })

  test("installs the exact case-sensitive directory and joins its Gallery identity", async () => {
    const { fixture, session } = await loaded({
      gallery: index([listing({ path: "Mods/Focus", modNames: ["Focus"] })]),
    })
    const id = session.list("gallery")[0].id
    const operation = session.installRepository("https://github.com/Example/Focus", " Mods/Focus ")
    expect(session.pending).toEqual({
      id: "github:example/focus/Mods/Focus",
      action: "install",
    })
    await operation
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "install",
      repository: "example/focus",
      recipePath: "Mods/Focus",
    })
    expect(session.mods).toHaveLength(1)
    expect(session.mod(id)).toMatchObject({
      modName: "Focus",
      recipePath: "Mods/Focus",
      path: "/fixture/app/mods/Focus",
      state: "installed",
    })
    await expect(
      session.installRepository("https://github.com/example/focus", "Mods/Focus"),
    ).rejects.toThrow(/already installed/)
    expect(fixture.io.operate).toHaveBeenCalledTimes(1)
  })

  test.each([
    ["", "mods/alpha", "mods/beta"],
    ["mods/alpha", "mods/beta", ""],
  ])("installs independent root and sibling packages in order %j", async (...directories) => {
    const { fixture, session } = await loaded()
    for (const directory of directories) {
      await session.installRepository("https://github.com/other/external", directory)
    }
    expect(
      session
        .list("installed")
        .map((mod) => mod.modName)
        .sort(),
    ).toEqual(["alpha", "beta", "external"])
    for (const directory of directories) {
      await expect(
        session.installRepository("https://github.com/other/external", directory),
      ).rejects.toThrow(/already installed/)
    }
    expect(fixture.io.operate).toHaveBeenCalledTimes(3)
  })

  test("rechecks duplicate directory identity after fresh discovery", async () => {
    const { fixture, session } = await loaded()
    fixture.mods.push(installed({ recipePath: "mods/focus" }))
    await expect(
      session.installRepository("https://github.com/example/focus", "mods/focus"),
    ).rejects.toThrow(/already installed/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    expect(session.pending).toBeNull()
  })

  test.each([
    "../focus",
    "/mods/focus",
    "mods/../focus",
    "mods/./focus",
    "mods//focus",
    "mods/focus/",
    "mods\\focus",
    "mods/.git",
    "mods/my mod",
    "mods/focus\nother",
    "mods/%66ocus",
    "mods/_focus",
    "https://github.com/owner/repo/tree/main/mods/focus",
    `mods/${"a".repeat(129)}`,
    `${"parent/".repeat(171)}focus`,
    `${"a/".repeat(64)}focus`,
  ])("rejects unsafe or unsupported directories before I/O: %j", async (directory) => {
    const { fixture, session } = await loaded()
    fixture.io.discover.mockClear()
    await expect(
      session.installRepository("https://github.com/other/external", directory),
    ).rejects.toThrow(/path|folder|metadata/)
    expect(fixture.io.discover).not.toHaveBeenCalled()
    expect(fixture.io.operate).not.toHaveBeenCalled()
    expect(session.pending).toBeNull()
  })

  test("a whitespace-only directory keeps repository-root installation", async () => {
    const { fixture, session } = await loaded()
    await session.installRepository("https://github.com/other/external", "  ")
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "install",
      repository: "other/external",
    })
  })

  test.each([
    { recipePath: "mods/other" },
    { recipePath: "Mods/focus" },
    { repository: "other/repo" },
  ])("rejects directory readback with a different source: %j", async (changes) => {
    const { fixture, session } = await loaded()
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      const result = await real(request)
      Object.assign(fixture.mods[0], changes)
      return result
    })
    await expect(
      session.installRepository("https://github.com/example/focus", "mods/focus"),
    ).rejects.toThrow(/readback failed/)
    expect(session.lastMessage).toBe("")
    expect(session.pending).toBeNull()
  })

  test.each([["other"], ["focus", "other"]])(
    "rejects unexpected returned directory selections: %j",
    async (...ids) => {
      const { fixture, session } = await loaded()
      const real = fixture.io.operate.getMockImplementation()
      fixture.io.operate.mockImplementation(async (request) => ({ ...(await real(request)), ids }))
      await expect(
        session.installRepository("https://github.com/example/focus", "mods/focus"),
      ).rejects.toThrow(/unexpected mod selection/)
      expect(session.lastMessage).toBe("")
      expect(session.pending).toBeNull()
    },
  )

  test("URL install can join an existing Gallery identity without duplicate cards", async () => {
    const { fixture, session } = await loaded({
      gallery: index([listing({ path: "", modNames: ["external"] })]),
    })
    const id = session.list("gallery")[0].id
    await session.installRepository("https://github.com/example/focus")
    expect(session.mods).toHaveLength(1)
    expect(session.mod(id).state).toBe("installed")
    expect(session.list("installed")[0]).toBe(session.mod(id))
    expect(fixture.io.operate).toHaveBeenCalledTimes(1)
  })

  test("invalid URLs do not reach the backend and failures can be retried", async () => {
    const { fixture, session } = await loaded()
    await expect(
      session.installRepository("https://github.com/owner/repo/tree/main"),
    ).rejects.toThrow(/GitHub repository URL/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    fixture.io.operate.mockRejectedValueOnce(new Error("Git fetch failed."))
    await expect(session.installRepository("https://github.com/other/external")).rejects.toThrow(
      /Git fetch failed/,
    )
    expect(session.list("installed")).toEqual([])
    expect(session.pending).toBeNull()
    await session.installRepository("https://github.com/other/external")
    expect(session.list("installed")).toHaveLength(1)
  })

  test.each([
    { ids: ["external"] },
    { commit: A },
    { ids: ["external"], commit: B },
    { ids: ["forged"], commit: A },
    { ids: ["../escape"], commit: A },
  ])("does not report URL success with unverified result %j", async (result) => {
    const { fixture, session } = await loaded()
    fixture.io.operate.mockResolvedValue(result)
    await expect(session.installRepository("https://github.com/other/external")).rejects.toThrow()
    expect(session.lastMessage).toBe("")
    expect(session.list("installed")).toEqual([])
    expect(session.pending).toBeNull()
  })
})

describe("verified readback and visible failures", () => {
  test("missing readback ownership token is not a verified installation", async () => {
    const { fixture, session } = await loaded()
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      const result = await real(request)
      delete fixture.mods[0].identityToken
      return result
    })
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(/readback failed/)
    expect(session.list("installed")).toHaveLength(1)
    expect(session.list("installed")[0].protectedReason).toMatch(/token/)
    expect(session.lastMessage).toBe("")
  })

  test("a backend success response without installed files is not success", async () => {
    const { fixture, session } = await loaded()
    fixture.io.operate.mockResolvedValue({
      ids: ["focus"],
      commit: A,
      message: "Do not display success.",
    })
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(/readback failed/)
    expect(focus(session).state).toBe("available")
    expect(session.list("installed")).toEqual([])
    expect(session.lastMessage).toBe("")
    expect(session.pending).toBeNull()
  })

  test("failed discovery after a write blocks success until an explicit refresh reads actual files", async () => {
    const { fixture, session } = await loaded()
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      const result = await real(request)
      fixture.io.discover.mockRejectedValue(new Error("Readback unavailable."))
      return result
    })
    const id = focus(session).id
    await expect(session.perform("install", id)).rejects.toThrow(/Readback unavailable/)
    expect(session.mod(id).state).toBe("available")
    expect(session.discoveryStatus).toBe("error")
    expect(session.lastMessage).toBe("")
    await expect(session.perform("install", id)).rejects.toThrow(/discovery/)
    fixture.io.discover.mockImplementation(async () => ({ mods: fixture.mods, warnings: [] }))
    await session.refresh()
    expect(session.mod(id).state).toBe("installed")
    expect(session.list("installed")).toHaveLength(1)
  })

  test("failure after a backend change retains actual state instead of simulating rollback", async () => {
    const { fixture, session } = await loaded()
    fixture.io.operate.mockImplementation(async () => {
      fixture.mods.push(installed())
      throw new Error("Ownership verification failed after the write.")
    })
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(
      /Ownership verification/,
    )
    expect(focus(session).state).toBe("installed")
    expect(session.list("installed")).toHaveLength(1)
    expect(session.lastMessage).toBe("")
    expect(session.pending).toBeNull()
  })

  test("uninstall failure retains the actual installed entry and permits new confirmation", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    fixture.io.operate.mockRejectedValueOnce(new Error("Local changes prevent removal."))
    session.requestUninstall(id)
    await expect(session.confirmUninstall()).rejects.toThrow(/Local changes/)
    expect(session.mod(id).state).toBe("installed")
    expect(session.confirmation).toBeNull()
    expect(session.pending).toBeNull()
    session.requestUninstall(id)
    await session.confirmUninstall()
    expect(session.mod(id).state).toBe("available")
  })

  test("an uninstall response without actual removal is rejected", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    fixture.io.operate.mockResolvedValue({ ids: ["focus"], commit: A })
    session.requestUninstall(id)
    await expect(session.confirmUninstall()).rejects.toThrow(/still installed/)
    expect(session.mod(id).state).toBe("installed")
  })

  test("updates propagate fast-forward rejection and can retry without changing installed commit", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    fixture.remoteCommit = B
    await session.checkUpdates()
    fixture.fastForward = false
    await expect(session.perform("update", id)).rejects.toThrow(/not a fast-forward/)
    expect(session.mod(id).commit).toBe(A)
    expect(session.mod(id).updateCommit).toBe(B)
    expect(session.pending).toBeNull()
    fixture.fastForward = true
    await session.perform("update", id)
    expect(session.mod(id).commit).toBe(B)
  })

  test("a different installed update commit fails readback but stays visible as actual state", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const id = focus(session).id
    fixture.remoteCommit = B
    await session.checkUpdates()
    fixture.remoteCommit = C
    await expect(session.perform("update", id)).rejects.toThrow(/readback failed/)
    expect(session.mod(id).commit).toBe(C)
    expect(session.mod(id)).not.toHaveProperty("updateCommit")
    expect(session.lastMessage).toBe("")
  })
})

describe("explicit update checks", () => {
  test("stops between repositories, retains completed candidates, and reports partial progress", async () => {
    const { fixture, session } = await loaded({
      mods: [
        installed(),
        installed({
          id: "extra",
          modName: "extra",
          repository: "other/extra",
          path: "/fixture/app/mods/extra",
        }),
      ],
    })
    const gate = deferred()
    const real = fixture.io.operate.getMockImplementation()
    fixture.remoteCommit = B
    fixture.io.operate.mockImplementation(async (request) => {
      await gate.promise
      return real(request)
    })
    const changes = vi.fn()
    const work = session.checkUpdates(changes)
    await vi.waitFor(() => expect(fixture.io.operate).toHaveBeenCalledTimes(1))
    expect(session.updateCheck).toMatchObject({ completed: 0, total: 2, name: "Focus Mode" })
    session.cancelUpdateCheck()
    expect(session.pending).not.toBeNull()
    expect(session.updateCheck.cancelRequested).toBe(true)
    gate.resolve()
    expect((await work).message).toBe("Update check stopped. 1 of 2 mods checked; 0 failed.")
    expect(fixture.io.operate).toHaveBeenCalledTimes(1)
    expect(focus(session).updateCommit).toBe(B)
    expect(changes).toHaveBeenCalled()
    expect(session.pending).toBeNull()
    expect(session.updateCheck).toBeNull()
    fixture.io.operate.mockImplementation(real)
    expect((await session.checkUpdates()).message).toContain("2 of 2")
  })

  test("a refreshed protection change stops subsequent stale checks", async () => {
    const { fixture, session } = await loaded({
      mods: [
        installed(),
        installed({
          id: "extra",
          modName: "extra",
          repository: "other/extra",
          path: "/fixture/app/mods/extra",
        }),
      ],
    })
    fixture.io.operate.mockImplementation(async () => {
      fixture.mods[1].protectedReason = "New active dependency"
      throw new Error("First check failed")
    })
    const result = await session.checkUpdates()
    expect(result.message).toContain("stopped. 1 of 2 mods checked; 1 failed")
    expect(result.message).toContain("Refresh Installed")
    expect(fixture.io.operate).toHaveBeenCalledTimes(1)
  })

  test("reports zero eligible targets without claiming completed update checks", async () => {
    const { fixture, session } = await loaded()
    expect((await session.checkUpdates()).message).toBe("No eligible manager-owned mods to check.")
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test("does not check during load or infer an update from Gallery commit", async () => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      gallery: index([listing({ headCommit: B })]),
    })
    const id = focus(session).id
    expect(fixture.io.operate).not.toHaveBeenCalled()
    expect(session.mod(id)).not.toHaveProperty("updateCommit")
    await session.checkUpdates()
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "check-update",
      id: "focus",
      expectedCommit: A,
      path: "/fixture/app/mods/focus",
      identityToken: "record-1",
    })
    expect(session.mod(id)).not.toHaveProperty("updateCommit")
    expect(session.updateErrors).toEqual({})
  })

  test.each([undefined, "bad", 123, A, null])(
    "never offers a false update for candidate %j",
    async (candidate) => {
      const { fixture, session } = await loaded({ mods: [installed()] })
      fixture.io.operate.mockResolvedValue({ commit: A, updateCommit: candidate })
      await session.checkUpdates()
      expect(focus(session)).not.toHaveProperty("updateCommit")
      expect(actionsFor(focus(session))).toEqual(["uninstall"])
      if (candidate === A || candidate === null) expect(session.updateErrors).toEqual({})
      else expect(session.updateErrors[focus(session).id]).toMatch(/commit/)
      expect(session.pending).toBeNull()
    },
  )

  test("clears a previous candidate after check failure and makes the error visible per mod", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    fixture.remoteCommit = B
    await session.checkUpdates()
    expect(focus(session).updateCommit).toBe(B)
    fixture.io.operate.mockRejectedValueOnce(new Error("Remote access denied."))
    await session.checkUpdates()
    expect(focus(session)).not.toHaveProperty("updateCommit")
    expect(session.updateErrors[focus(session).id]).toBe("Remote access denied.")
    await expect(session.perform("update", focus(session).id)).rejects.toThrow(/not available/)
    await session.checkUpdates()
    expect(focus(session).updateCommit).toBe(B)
    expect(session.updateErrors).toEqual({})
  })

  test("one failed update check does not suppress other installed checks", async () => {
    const { fixture, session } = await loaded({
      mods: [
        installed(),
        installed({
          id: "extra",
          modName: "extra",
          repository: "other/extra",
          recipePath: "",
          path: "/fixture/app/mods/extra",
          identityToken: "extra-record",
        }),
      ],
    })
    fixture.remoteCommit = B
    fixture.io.operate.mockRejectedValueOnce(new Error("First remote failed."))
    await session.checkUpdates()
    expect(session.updateErrors[focus(session).id]).toBe("First remote failed.")
    expect(session.list("installed").find((mod) => mod.modName === "extra").updateCommit).toBe(B)
    expect(fixture.io.operate).toHaveBeenCalledTimes(2)
  })

  test("a same-commit reinstall cannot reuse the previous ownership update candidate", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    fixture.remoteCommit = B
    await session.checkUpdates()
    expect(focus(session).updateCommit).toBe(B)
    fixture.mods[0].identityToken = "reinstalled-record"
    await session.refresh()
    expect(focus(session)).not.toHaveProperty("updateCommit")
  })

  test("rejects a stale installed commit from check-update", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    fixture.io.operate.mockResolvedValue({ commit: B, updateCommit: C })
    await session.checkUpdates()
    expect(focus(session)).not.toHaveProperty("updateCommit")
    expect(session.updateErrors[focus(session).id]).toMatch(/stale installed commit/)
  })
})

describe("source independence and bounded native wait", () => {
  test("Installed refresh, checks and uninstall finish while Gallery is stalled", async () => {
    const { fixture, session } = await loaded({ mods: [installed()] })
    const gate = deferred()
    fixture.io.fetchGallery.mockReturnValueOnce(gate.promise)
    const stalled = session.refreshGallery()
    await session.refreshInstalled()
    expect(session.discoveryStatus).toBe("ready")
    expect(session.galleryStatus).toBe("loading")
    await session.checkUpdates()
    session.requestUninstall(focus(session).id)
    await session.confirmUninstall()
    expect(session.list("installed")).toEqual([])
    gate.resolve(index())
    await stalled
    expect(focus(session).state).toBe("available")
  })

  test("timeout clears only Gallery loading; late success cannot overwrite a retry", async () => {
    const fixture = backend({ mods: [installed()] })
    const wait = deferred()
    const old = deferred()
    fixture.io.wait = vi.fn(() => wait.promise)
    fixture.io.fetchGallery.mockReturnValueOnce(old.promise)
    const session = new ManagerSession(fixture.io)
    const work = session.load()
    await vi.waitFor(() => expect(session.discoveryStatus).toBe("ready"))
    expect(session.galleryStatus).toBe("loading")
    expect(fixture.io.wait).toHaveBeenCalledWith(15_000)
    wait.resolve()
    await work
    expect(session.galleryStatus).toBe("error")
    expect(session.galleryError).toMatch(/timed out/)
    expect(session.list("installed")).toHaveLength(1)
    fixture.io.wait.mockImplementation(() => new Promise(() => {}))
    fixture.gallery.mods[0].name = "Latest title"
    await session.refreshGallery()
    old.resolve(index([listing({ name: "Stale title" })]))
    await Promise.resolve()
    expect(focus(session).name).toBe("Latest title")
    expect(session.galleryStatus).toBe("ready")
    await session.checkUpdates()
  })

  test("late Gallery failure cannot replace a newer source success", async () => {
    const { fixture, session } = await loaded()
    const old = deferred()
    fixture.io.fetchGallery.mockReturnValueOnce(old.promise)
    const first = session.refreshGallery()
    await session.refreshGallery()
    old.reject(new Error("Old source failed"))
    await first
    expect(session.galleryStatus).toBe("ready")
    expect(session.galleryError).toBe("")
  })

  test("stale discovery cannot overwrite newer membership or migration", async () => {
    const { fixture, session } = await loaded()
    const old = deferred()
    fixture.io.discover.mockReturnValueOnce(old.promise)
    const first = session.refreshInstalled()
    fixture.mods.push(installed())
    fixture.migration = migrationSummary()
    await session.refreshInstalled()
    old.resolve({ mods: [], warnings: ["old"] })
    await first
    expect(session.list("installed")).toHaveLength(1)
    expect(session.discoveryStatus).toBe("ready")
    expect(session.migration.required).toBe(true)
    expect(session.warnings).not.toContain("old")
  })

  test("search includes folder IDs and modName independently of title and repository", async () => {
    const { session } = await loaded({
      gallery: index([listing({ name: "Different title", modNames: ["UniqueFolder"] })]),
      mods: [
        installed({
          id: "LocalFolder",
          modName: "LocalFolder",
          name: "Unrelated",
          repository: "",
          path: "/fixture/app/mods/LocalFolder",
          managed: false,
        }),
      ],
    })
    expect(session.list("gallery", "uniquefolder")).toHaveLength(1)
    expect(session.list("installed", "localfolder")).toHaveLength(1)
    expect(
      filterMods(
        [
          {
            name: "Title",
            description: "",
            repository: "",
            id: "stable-id",
            modName: "CaseFolder",
            source: "local",
          },
        ],
        "casefolder",
      ),
    ).toHaveLength(1)
  })
})

function migrationSummary(overrides = {}) {
  return {
    required: true,
    blocked: false,
    token: "a".repeat(64),
    targets: [
      {
        id: "focus",
        path: "/fixture/app/mods/focus",
        repository: "example/focus",
        kind: "package",
      },
    ],
    ...overrides,
  }
}

describe("explicit ownership migration", () => {
  test("load preserves the summary without migration; browsing and cancel remain read-only", async () => {
    const summary = migrationSummary()
    const { fixture, session } = await loaded({ mods: [installed()], migration: summary })
    expect(session.migration).toEqual(summary)
    expect(Object.isFrozen(session.migration.targets[0])).toBe(true)
    expect(session.list("gallery")).toHaveLength(1)
    expect(session.list("installed")).toHaveLength(1)
    await expect(session.perform("install", focus(session).id)).rejects.toThrow(/migration/)
    await expect(session.installRepository("https://github.com/other/new")).rejects.toThrow(
      /migration/,
    )
    await expect(session.checkUpdates()).rejects.toThrow(/migration/)
    expect(() => session.requestUninstall(focus(session).id)).toThrow(/migration/)
    const confirmation = session.requestMigration()
    expect(confirmation.summary).toBe(session.migration)
    expect(Object.isFrozen(confirmation)).toBe(true)
    session.cancelMigration()
    expect(session.migrationConfirmation).toBeNull()
    expect(fixture.io.operate).not.toHaveBeenCalled()
    await expect(session.confirmMigration()).rejects.toThrow(/Confirm/)
  })

  test("confirm explicitly sends the frozen token and verifies actual original membership", async () => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      migration: migrationSummary(),
    })
    session.requestMigration()
    await session.confirmMigration()
    expect(fixture.io.operate).toHaveBeenCalledWith({
      action: "migrate",
      migrationToken: "a".repeat(64),
    })
    expect(session.migration.required).toBe(false)
    expect(session.list("installed")[0].managed).toBe(true)
    expect(session.migrationConfirmation).toBeNull()
    expect(session.lastMessage).toContain("verified")
    expect(session.pending).toBeNull()
  })

  test.each([
    { token: "b".repeat(64) },
    { blocked: true, reason: "Conflicting lock: /fixture/lock" },
    { targets: [] },
    { required: false },
  ])("fresh discovery rejects a stale summary %j without a write", async (change) => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      migration: migrationSummary(),
    })
    session.requestMigration()
    Object.assign(fixture.migration, change)
    await expect(session.confirmMigration()).rejects.toThrow(/stale/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
    expect(session.migrationConfirmation).not.toBeNull()
    session.cancelMigration()
  })

  test.each([
    (fixture) => {
      fixture.mods = []
    },
    (fixture) => {
      fixture.mods[0].commit = B
    },
    (fixture) => {
      fixture.mods[0].managed = false
    },
    (fixture) => {
      fixture.migration = migrationSummary({
        blocked: true,
        reason: "Retained recovery evidence: /fixture/journal",
      })
    },
  ])("rejects unverified migration readback and shows actual state", async (change) => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      migration: migrationSummary(),
    })
    const real = fixture.io.operate.getMockImplementation()
    fixture.io.operate.mockImplementation(async (request) => {
      const result = await real(request)
      change(fixture)
      return result
    })
    session.requestMigration()
    await expect(session.confirmMigration()).rejects.toThrow(/readback|recovery evidence/)
    expect(session.lastMessage).toBe("")
    expect(session.pending).toBeNull()
  })

  test("blocked and interrupted migrations expose reasons without automatic writes", async () => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      migration: migrationSummary({ blocked: true, reason: "Unknown lock: /fixture/lock" }),
    })
    expect(() => session.requestMigration()).toThrow(/Unknown lock/)
    await expect(session.installRepository("https://github.com/other/new")).rejects.toThrow(
      /Unknown lock/,
    )
    fixture.migration = migrationSummary({
      reason: "Interrupted migration: review to resume /fixture/journal",
    })
    await session.refreshInstalled()
    session.requestMigration()
    expect(fixture.io.operate).not.toHaveBeenCalled()
    await session.confirmMigration()
    expect(session.migration.required).toBe(false)
  })

  test("a backend exception refreshes actual migration state, not a simulated rollback", async () => {
    const { fixture, session } = await loaded({
      mods: [installed()],
      migration: migrationSummary(),
    })
    fixture.io.operate.mockImplementation(async () => {
      fixture.migration.blocked = true
      fixture.migration.reason = "Interrupted; retained /fixture/recovery"
      throw new Error("Unknown backend error")
    })
    session.requestMigration()
    await expect(session.confirmMigration()).rejects.toThrow(/Unknown backend error/)
    expect(session.migration.reason).toContain("/fixture/recovery")
    expect(session.migration.blocked).toBe(true)
    expect(session.pending).toBeNull()
  })

  test.each([
    { required: "true" },
    { blocked: 1 },
    { token: "" },
    { token: "not-a-sha256-token" },
    { token: "A".repeat(64) },
    {
      targets: [
        {
          id: "focus",
          path: "/fixture/app/mods/focus",
          repository: "Example/Focus",
          kind: "package",
        },
      ],
    },
    {
      targets: [
        {
          id: "focus",
          path: "/fixture/app/mods/focus",
          repository: "example/focus",
          kind: "unknown",
        },
      ],
    },
    {
      targets: [
        {
          id: "bad name",
          path: "/fixture/app/mods/bad name",
          repository: "example/focus",
          kind: "package",
        },
      ],
    },
    {
      targets: [
        { id: "focus", path: "relative/focus", repository: "example/focus", kind: "package" },
      ],
    },
  ])("malformed migration metadata fails discovery closed: %j", async (change) => {
    const { fixture, session } = await loaded({ migration: migrationSummary(change) })
    expect(session.discoveryStatus).toBe("error")
    await expect(session.installRepository("https://github.com/other/new")).rejects.toThrow(
      /discovery/,
    )
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })

  test("new migration discovered immediately before an install blocks the write", async () => {
    const { fixture, session } = await loaded()
    fixture.migration = migrationSummary()
    await expect(session.installRepository("https://github.com/other/new")).rejects.toThrow(
      /migration/,
    )
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })
})

test("blocked migration keeps a minimal recovery reason visible without token or targets", async () => {
  const { fixture, session } = await loaded({
    mods: [installed()],
    migration: { required: true, blocked: true, reason: "Unknown lock /fixture/lock" },
  })
  expect(session.discoveryStatus).toBe("ready")
  expect(session.migration.reason).toContain("/fixture/lock")
  expect(session.migration.targets).toEqual([])
  expect(() => session.requestMigration()).toThrow(/Unknown lock/)
  expect(fixture.io.operate).not.toHaveBeenCalled()
})

test("failed update check refreshes actual installed state instead of retaining a false snapshot", async () => {
  const { fixture, session } = await loaded({ mods: [installed()] })
  fixture.io.operate.mockImplementation(async () => {
    fixture.mods[0].identityToken = "externally-changed"
    fixture.mods[0].protectedReason = "Recovery evidence retained at /fixture/journal"
    throw new Error("Unknown backend error")
  })
  await session.checkUpdates()
  expect(focus(session).identityToken).toBe("externally-changed")
  expect(focus(session).protectedReason).toContain("/fixture/journal")
  expect(session.updateErrors[focus(session).id]).toBe("Unknown backend error")
})

describe("confirmed Git archival", () => {
  const git = { kind: "git", archivePath: "/fixture/app/data/mod-manager/archives/focus-1" }
  test("cancel preserves files; explicit confirmation sends the displayed archive path", async () => {
    const { fixture, session } = await loaded({ mods: [installed(git)] })
    const id = focus(session).id
    expect(session.requestUninstall(id)).toMatchObject(git)
    session.cancelUninstall()
    expect(fixture.io.operate).not.toHaveBeenCalled()
    session.requestUninstall(id)
    await session.confirmUninstall()
    expect(fixture.io.operate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uninstall",
        archiveGit: true,
        archivePath: git.archivePath,
      }),
    )
  })
  test.each([
    { kind: "package" },
    { archivePath: "/fixture/app/data/mod-manager/archives/changed" },
  ])("rejects stale Git confirmation %j before writing", async (change) => {
    const { fixture, session } = await loaded({ mods: [installed(git)] })
    session.requestUninstall(focus(session).id)
    Object.assign(fixture.mods[0], change)
    await expect(session.confirmUninstall()).rejects.toThrow(/stale|changed/)
    expect(fixture.io.operate).not.toHaveBeenCalled()
  })
})
