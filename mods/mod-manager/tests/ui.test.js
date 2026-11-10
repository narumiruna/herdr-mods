import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, test, vi } from "vitest"

const taskScope = new AsyncLocalStorage()

// Exercise the actual native view handlers without a window or host I/O.
const native = vi.hoisted(() => {
  function element(type, id) {
    const node = { type, nodes: [], attributes: { id }, click: null }
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key]
        if (key === "then" || typeof key !== "string") return undefined
        if (key === "child")
          return (child) => {
            target.nodes.push(child)
            return proxy
          }
        if (key === "children")
          return (children) => {
            target.nodes.push(...children)
            return proxy
          }
        if (key === "when") return (condition, branch) => (condition ? branch(proxy) : proxy)
        if (key === "on_click")
          return (handler) => {
            target.click = handler
            return proxy
          }
        return (...args) => {
          target.attributes[key] = args[0]
          return proxy
        }
      },
    })
    return proxy
  }
  function input(options = {}) {
    let value = options.value || ""
    return {
      handlers: {},
      on(event, handler) {
        this.handlers[event] = handler
      },
      value: () => value,
      set_value(next) {
        value = next
      },
    }
  }
  return {
    element,
    input,
    closeOverlay: vi.fn(),
    openUrl: vi.fn(),
    createIO: vi.fn(() => {
      throw new Error("Live runtime must not run in UI fixture tests")
    }),
  }
})

vi.mock("gpui-kit", () => ({
  View: class {},
  div: () => native.element("div"),
  svg: (path) => native.element("svg", path),
}))
vi.mock("gpui-base", () => ({
  Button: { new: (id) => native.element("button", id) },
  h_flex: () => native.element("row"),
  v_flex: () => native.element("column"),
  Input: {
    new: (state) => {
      const node = native.element("input")
      node.attributes.state = state
      return node
    },
  },
  InputState: { new: native.input },
  Scrollbar: { vertical: (id) => native.element("scrollbar", `scroll-${id}`) },
}))
vi.mock("herdr", () => ({
  closeOverlay: native.closeOverlay,
  props: () => ({ overlay: "fixture-overlay" }),
  theme: () => ({}),
}))
vi.mock("../runtime.js", () => ({ createIO: native.createIO }))

import ModManager from "../main.js"
import { ManagerSession } from "../manager.js"

const INITIAL = "a".repeat(40)
const UPDATED = "b".repeat(40)
const galleryId = (name) => `mods:example/${name}//${name}`
const copy = (value) => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function listing(name, title, description, version) {
  return {
    owner: "example",
    repo: name,
    fullName: `example/${name}`,
    url: `https://github.com/example/${name}`,
    path: "",
    name: title,
    blurb: description,
    modNames: [name],
    headCommit: INITIAL,
    ...(version ? { version } : {}),
  }
}

function record(name, overrides = {}) {
  return {
    id: name,
    modName: name,
    name: name === "focus-mode" ? "Focus Mode" : name,
    description: "Local manifest description",
    version: "1.0.0",
    repository: `example/${name}`,
    recipePath: "",
    source: "github",
    managed: true,
    path: `/fixture/herdr/mods/${name}`,
    commit: INITIAL,
    identityToken: `verified-${name}`,
    ...overrides,
  }
}

function fixture() {
  const state = {
    records: [
      record("focus-mode"),
      record("workspace-notes", { description: "Keep project context" }),
      record("mod-manager", {
        repository: "",
        source: "development",
        managed: false,
        protectedReason: "Running manager: protected development link.",
      }),
      record("workspace-chrome", {
        repository: "",
        source: "shipped",
        managed: false,
        protectedReason: "Shipped mod cannot be changed.",
      }),
      record("local-tool", { repository: "", source: "local", managed: false }),
    ],
    galleryError: "",
    discoveryError: "",
    operateError: "",
    checkError: "",
    warnings: [],
    migration: undefined,
    galleryGate: null,
    discoveryGate: null,
    operationGate: null,
    afterCommitGate: null,
    readbackFail: false,
  }
  const entries = [
    listing("focus-mode", "Focus Mode", "Remove distractions", "1.0.0"),
    listing("workspace-notes", "Workspace Notes", "Keep project context", "2.0.0"),
    listing("terminal-tools", "Terminal Tools", "Commands for terminals"),
  ]
  const io = {
    fetchGallery: vi.fn(async () => {
      if (state.galleryGate) await state.galleryGate.promise
      if (state.galleryError) throw new Error(state.galleryError)
      return copy({
        schemaVersion: 1,
        generatedAt: "2026-11-09T12:00:00Z",
        modCount: entries.length,
        repositoryCount: entries.length,
        source: {
          provider: "github",
          query: "topic:herdr-mod",
          truncated: false,
          totalCount: entries.length,
          collectedCount: entries.length,
          blacklistedCount: 0,
          skippedCount: 0,
          warnings: [],
        },
        mods: entries,
      })
    }),
    discover: vi.fn(async () => {
      if (state.discoveryGate) await state.discoveryGate.promise
      if (state.discoveryError) throw new Error(state.discoveryError)
      return copy({ mods: state.records, warnings: state.warnings, migration: state.migration })
    }),
    operate: vi.fn(async (request) => {
      expect(taskScope.getStore()).toBe("unowned")
      if (state.operationGate) await state.operationGate.promise
      if (state.operateError) throw new Error(state.operateError)
      if (request.action === "migrate") {
        expect(request.migrationToken).toBe(state.migration.token)
        state.migration = { required: false, blocked: false, token: "", targets: [] }
        return { message: "Migration ownership verified." }
      }
      const name = request.modNames?.[0] || request.id || request.repository.split("/")[1]
      if (request.action === "check-update") {
        if (state.checkError) throw new Error(state.checkError)
        return { commit: INITIAL, updateCommit: UPDATED }
      }
      if (!state.readbackFail) {
        if (request.action === "install")
          state.records.push(
            record(name, {
              repository: request.repository,
              commit: request.expectedCommit || INITIAL,
            }),
          )
        if (request.action === "update")
          state.records.find((mod) => mod.id === name).commit = UPDATED
        if (request.action === "uninstall")
          state.records = state.records.filter((mod) => mod.id !== name)
      }
      if (state.afterCommitGate) await state.afterCommitGate.promise
      return {
        ids: [name],
        commit: request.action === "update" ? UPDATED : INITIAL,
        message: `Verified ${request.action}: ${name}. Runtime reload is not confirmed.`,
      }
    }),
  }
  return { state, io, entries }
}

function descendants(node) {
  if (typeof node === "string") return []
  return [node, ...node.nodes.flatMap(descendants)]
}
function contents(node) {
  if (typeof node === "string") return node
  return node.nodes.map(contents).join(" ")
}
function find(view, id) {
  return descendants(view.render()).find((node) => node.attributes.id === id)
}
function click(view, id, cx) {
  const node = find(view, id)
  expect(node, `Missing control: ${id}`).toBeDefined()
  expect(node.attributes.disabled, `Disabled control: ${id}`).not.toBe(true)
  node.click({}, cx)
}
function setup(options = {}) {
  const backend = options.backend || fixture()
  const session = options.session || new ManagerSession(backend.io)
  const tasks = []
  const create = vi.fn(() => session)
  class FixtureView extends ModManager {
    createSession() {
      return create()
    }
  }
  const view = new FixtureView()
  if (options.supplied) view.session = session
  const asyncCx = {
    sleep: vi.fn(() => new Promise(() => {})),
    notify: vi.fn(() => {
      if (view.closed) throw new Error("Context used after close")
    }),
  }
  const cx = {
    notify: vi.fn(),
    open_url: native.openUrl,
    sleep: asyncCx.sleep,
    spawn: vi.fn((body, options) => {
      const owner = options?.owner === null ? "unowned" : "view"
      const taskCx =
        owner === "unowned"
          ? {
              sleep: asyncCx.sleep,
              notify() {
                throw new Error("An unowned task cannot notify a view")
              },
            }
          : asyncCx
      // The callback runs later. Calling the model in the click handler is an ownership error.
      tasks.push(Promise.resolve().then(() => taskScope.run(owner, () => body(taskCx))))
    }),
  }
  view.init(undefined, cx)
  return {
    view,
    cx,
    asyncCx,
    create,
    ...backend,
    async flush() {
      while (tasks.length) await Promise.all(tasks.splice(0))
    },
  }
}
function search(view, section, value, cx) {
  const input = descendants(view.render()).find((node) => node.type === "input").attributes.state
  expect(input).toBe(view.searches[section])
  input.set_value(value)
  input.handlers.change({}, cx)
}
async function settleUntil(predicate) {
  for (let count = 0; count < 50 && !predicate(); count++) await Promise.resolve()
  expect(predicate()).toBe(true)
}

// These fixtures use the real ManagerSession. Only its I/O is replaced.
describe("live manager view with fixture I/O", () => {
  test("initializes once, honors injected sessions, and never creates live I/O", async () => {
    const first = setup()
    first.view.init(undefined, first.cx)
    await first.flush()
    expect(first.create).toHaveBeenCalledTimes(1)
    expect(first.io.fetchGallery).toHaveBeenCalledTimes(1)
    expect(first.io.discover).toHaveBeenCalledTimes(1)
    const supplied = setup({ supplied: true })
    await supplied.flush()
    expect(supplied.create).not.toHaveBeenCalled()
    expect(native.createIO).not.toHaveBeenCalled()
  })

  test("renders real Gallery cards, known versions, membership and no toggle or simulated controls", async () => {
    const { view, flush } = setup()
    await flush()
    expect(view.section).toBe("gallery")
    expect(contents(find(view, `mod-${galleryId("focus-mode")}`))).toContain("Installed")
    expect(contents(find(view, `mod-${galleryId("focus-mode")}`))).toContain("Version 1.0.0")
    const available = contents(find(view, `mod-${galleryId("terminal-tools")}`))
    expect(available).toContain("example/terminal-tools")
    expect(available).toContain("GitHub")
    expect(available).toContain("Not installed")
    expect(available).not.toContain("Version")
    expect(contents(view.render())).not.toMatch(/undefined|simulat|sample|enable|disable/i)
    expect(find(view, `action-install-${galleryId("terminal-tools")}`)).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("5")
  })

  test("keeps independent searches and all five source filters", async () => {
    const { view, cx, flush } = setup()
    await flush()
    for (const term of ["CONTEXT", "Workspace Notes", "EXAMPLE/WORKSPACE-NOTES"]) {
      search(view, "gallery", term, cx)
      expect(find(view, `mod-${galleryId("workspace-notes")}`)).toBeDefined()
      expect(find(view, `mod-${galleryId("focus-mode")}`)).toBeUndefined()
    }
    click(view, "nav-installed", cx)
    for (const [source, id] of [
      ["development", "local:mod-manager"],
      ["local", "local:local-tool"],
      ["shipped", "local:workspace-chrome"],
      ["github", galleryId("focus-mode")],
    ]) {
      click(view, `filter-${source}`, cx)
      expect(find(view, `mod-${id}`)).toBeDefined()
    }
    search(view, "installed", "nothing matches", cx)
    expect(contents(view.render())).toContain("No matching mods")
    click(view, "filter-all", cx)
    click(view, "nav-gallery", cx)
    expect(find(view, `mod-${galleryId("workspace-notes")}`)).toBeDefined()
    expect(view.queries.installed).toBe("nothing matches")
    search(view, "gallery", "", cx)
    expect(view.session.list("gallery")).toHaveLength(3)
  })

  test("shows loading rather than empty results and disables mutation until discovery succeeds", async () => {
    const backend = fixture()
    backend.state.discoveryGate = deferred()
    const { view, cx, flush } = setup({ backend })
    expect(contents(view.render())).toContain("Loading Gallery")
    expect(contents(view.render())).not.toContain("No matching mods")
    await settleUntil(() => view.session.galleryStatus === "ready")
    expect(find(view, `action-install-${galleryId("terminal-tools")}`).attributes.disabled).toBe(
      true,
    )
    click(view, "nav-installed", cx)
    expect(contents(view.render())).toContain("Discovering installed mods")
    backend.state.discoveryGate.resolve()
    await flush()
    expect(find(view, `mod-${galleryId("focus-mode")}`)).toBeDefined()
  })

  test("shows source errors and warnings without an empty-state lie and retries from Refresh", async () => {
    const backend = fixture()
    backend.state.galleryError = "Fixture Gallery offline"
    backend.state.warnings = ["Fixture unreadable manifest"]
    const { view, cx, flush } = setup({ backend })
    await flush()
    expect(contents(find(view, "gallery-error"))).toContain("Fixture Gallery offline")
    expect(contents(view.render())).toContain("Fixture unreadable manifest")
    expect(contents(view.render())).not.toContain("No matching mods")
    click(view, "nav-installed", cx)
    expect(find(view, `mod-${galleryId("focus-mode")}`)).toBeDefined()
    backend.state.galleryError = ""
    click(view, "nav-gallery", cx)
    click(view, "refresh-library", cx)
    await flush()
    expect(find(view, "gallery-error")).toBeUndefined()
    expect(find(view, `mod-${galleryId("terminal-tools")}`)).toBeDefined()
    backend.state.discoveryError = "Fixture discovery denied"
    click(view, "nav-installed", cx)
    click(view, "refresh-library", cx)
    await flush()
    expect(contents(find(view, "discovery-error"))).toContain("Fixture discovery denied")
    click(view, "nav-gallery", cx)
    expect(find(view, `action-install-${galleryId("terminal-tools")}`).attributes.disabled).toBe(
      true,
    )
  })

  test("installs through a rendered card and updates shared Installed membership only after readback", async () => {
    const { view, cx, flush, state, io } = setup()
    await flush()
    state.operationGate = deferred()
    click(view, `action-install-${galleryId("terminal-tools")}`, cx)
    expect(contents(view.render())).toContain("Installing mod")
    expect(find(view, `action-uninstall-${galleryId("focus-mode")}`).attributes.disabled).toBe(true)
    expect(contents(find(view, "nav-installed"))).toContain("5")
    click(view, "nav-installed", cx)
    expect(find(view, `mod-${galleryId("terminal-tools")}`)).toBeUndefined()
    state.operationGate.resolve()
    await flush()
    expect(find(view, `action-uninstall-${galleryId("terminal-tools")}`)).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("6")
    expect(view.notice).toContain("Verified install")
    expect(io.operate).toHaveBeenCalledTimes(1)
    click(view, "nav-gallery", cx)
    expect(contents(find(view, `mod-${galleryId("terminal-tools")}`))).toContain("Manager-owned")
  })

  test("blocks duplicate pending handlers without a second backend request", async () => {
    const { view, cx, flush, state, io } = setup()
    await flush()
    const id = galleryId("terminal-tools")
    const stale = find(view, `action-install-${id}`).click
    state.operationGate = deferred()
    stale({}, cx)
    stale({}, cx)
    expect(view.noticeError).toBe(true)
    expect(view.notice).toContain("in progress")
    expect(find(view, "operation-progress")).toBeDefined()
    state.operationGate.resolve()
    await flush()
    expect(view.noticeError).toBe(false)
    expect(io.operate).toHaveBeenCalledTimes(1)
  })

  test("checks updates explicitly, shows per-mod failures, and performs offered updates", async () => {
    const { view, cx, flush, state, io } = setup()
    await flush()
    const id = galleryId("focus-mode")
    expect(io.operate).not.toHaveBeenCalled()
    click(view, "nav-installed", cx)
    state.checkError = "Fixture update lookup failed"
    click(view, "check-updates", cx)
    expect(contents(view.render())).toContain("Checking for updates")
    await flush()
    expect(contents(find(view, `mod-${id}`))).toContain("Fixture update lookup failed")
    expect(find(view, `action-update-${id}`)).toBeUndefined()
    state.checkError = ""
    click(view, "check-updates", cx)
    await flush()
    expect(contents(find(view, `mod-${id}`))).toContain("Update available")
    click(view, `action-update-${id}`, cx)
    expect(contents(view.render())).toContain("Updating mod")
    await flush()
    expect(view.session.mod(id).commit).toBe(UPDATED)
    expect(view.notice).toContain("Verified update")
    click(view, "nav-gallery", cx)
    expect(find(view, `action-update-${id}`)).toBeUndefined()
  })

  test("confirms verified absolute path, blocks stale background actions, cancels without mutation and uninstalls", async () => {
    const { view, cx, flush, io } = setup()
    await flush()
    const id = galleryId("focus-mode")
    const staleInstall = find(view, `action-install-${galleryId("terminal-tools")}`).click
    const staleFilter = find(view, "filter-development").click
    click(view, `action-uninstall-${id}`, cx)
    expect(find(view, "uninstall-confirmation")).toBeDefined()
    expect(contents(view.render())).toContain("Uninstall Focus Mode?")
    expect(contents(view.render())).toContain(
      "Verified absolute path: /fixture/herdr/mods/focus-mode",
    )
    expect(contents(view.render())).toContain("irreversible")
    expect(find(view, "nav-installed").attributes.disabled).toBe(true)
    view.navigate("github", cx)
    staleInstall({}, cx)
    staleFilter({}, cx)
    view.act("uninstall", galleryId("workspace-notes"), cx)
    expect(view.section).toBe("gallery")
    expect(view.sources.gallery).toBe("all")
    expect(view.session.confirmation.id).toBe(id)
    click(view, "cancel-uninstall", cx)
    expect(io.operate).not.toHaveBeenCalled()
    expect(view.session.mod(id).state).toBe("installed")
    click(view, `action-uninstall-${id}`, cx)
    click(view, "confirm-uninstall", cx)
    await flush()
    expect(find(view, `action-install-${id}`)).toBeDefined()
    click(view, "nav-installed", cx)
    expect(find(view, `mod-${id}`)).toBeUndefined()
    expect(io.operate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uninstall",
        path: "/fixture/herdr/mods/focus-mode",
        expectedCommit: INITIAL,
        identityToken: "verified-focus-mode",
      }),
    )
  })

  test("rejects old confirmation handlers after cancel and a different confirmation", async () => {
    const { view, cx, flush, io } = setup()
    await flush()
    click(view, `action-uninstall-${galleryId("focus-mode")}`, cx)
    const oldConfirm = find(view, "confirm-uninstall").click
    const oldCancel = find(view, "cancel-uninstall").click
    click(view, "cancel-uninstall", cx)
    click(view, `action-uninstall-${galleryId("workspace-notes")}`, cx)
    const current = view.session.confirmation
    oldConfirm({}, cx)
    oldCancel({}, cx)
    await flush()
    expect(view.session.confirmation).toBe(current)
    expect(io.operate).not.toHaveBeenCalled()
    click(view, "confirm-uninstall", cx)
    await flush()
    expect(io.operate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "uninstall", id: "workspace-notes" }),
    )
    expect(view.session.mod(galleryId("focus-mode")).state).toBe("installed")
  })

  test("shows protected ownership reasons and rejects programmatic mutation", async () => {
    const { view, cx, flush, io } = setup()
    await flush()
    click(view, "nav-installed", cx)
    const id = "local:mod-manager"
    const action = find(view, `action-uninstall-${id}`)
    expect(action.attributes.disabled).toBe(true)
    expect(action.attributes.tooltip).toContain("protected development link")
    expect(contents(find(view, `mod-${id}`))).toContain("Not manager-owned")
    view.act("uninstall", id, cx)
    expect(view.noticeError).toBe(true)
    expect(view.session.confirmation).toBeNull()
    expect(io.operate).not.toHaveBeenCalled()
  })

  test("validates GitHub URLs, reuses Gallery identity and prevents duplicate installs", async () => {
    const { view, cx, flush } = setup()
    await flush()
    click(view, "nav-github", cx)
    view.repository.set_value("not a URL")
    click(view, "install-repository", cx)
    await flush()
    expect(view.noticeError).toBe(true)
    expect(contents(view.render())).toContain("Enter a GitHub repository URL")
    view.repository.set_value("https://github.com/Example/Terminal-Tools.git/")
    click(view, "install-repository", cx)
    expect(find(view, "install-repository").attributes.disabled).toBe(true)
    await flush()
    click(view, "view-installed", cx)
    expect(find(view, `mod-${galleryId("terminal-tools")}`)).toBeDefined()
    click(view, "nav-gallery", cx)
    expect(find(view, `action-uninstall-${galleryId("terminal-tools")}`)).toBeDefined()
    click(view, "nav-github", cx)
    click(view, "install-repository", cx)
    await flush()
    expect(view.noticeError).toBe(true)
    expect(view.notice).toContain("already installed")
    expect(view.session.list("installed")).toHaveLength(6)
  })

  test("shows GitHub-only installations in Installed without inventing Gallery listings", async () => {
    const { view, cx, flush } = setup()
    await flush()
    click(view, "nav-github", cx)
    view.repository.set_value("https://github.com/owner/new-mod")
    click(view, "install-repository", cx)
    await flush()
    click(view, "view-installed", cx)
    expect(contents(view.render())).toContain("owner/new-mod")
    click(view, "nav-gallery", cx)
    expect(contents(view.render())).not.toContain("owner/new-mod")
  })

  test.each(["operateError", "readbackFail"])(
    "does not show success for %s and permits retry",
    async (failure) => {
      const { view, cx, flush, state } = setup()
      await flush()
      state[failure] = failure === "operateError" ? "Fixture operation failed" : true
      const id = galleryId("terminal-tools")
      click(view, `action-install-${id}`, cx)
      await flush()
      expect(view.noticeError).toBe(true)
      expect(view.notice).toMatch(/operation failed|readback failed/i)
      expect(view.notice).not.toContain("Verified install")
      expect(view.session.mod(id).state).toBe("available")
      expect(view.session.pending).toBeNull()
      state[failure] = failure === "operateError" ? "" : false
      click(view, `action-install-${id}`, cx)
      await flush()
      expect(view.noticeError).toBe(false)
    },
  )

  test.each(["update", "uninstall"])(
    "shows %s readback failures without false success",
    async (action) => {
      const { view, cx, flush, state } = setup()
      await flush()
      const id = galleryId("focus-mode")
      if (action === "update") {
        click(view, "nav-installed", cx)
        click(view, "check-updates", cx)
        await flush()
      }
      state.readbackFail = true
      click(view, `action-${action}-${id}`, cx)
      if (action === "uninstall") click(view, "confirm-uninstall", cx)
      await flush()
      expect(view.noticeError).toBe(true)
      expect(view.notice).toMatch(/readback failed/i)
      expect(view.notice).not.toContain(`Verified ${action}`)
      expect(view.session.mod(id).state).toBe("installed")
      expect(view.session.mod(id).commit).toBe(INITIAL)
    },
  )

  test("keeps late mutation failures visible in state without notifying after close", async () => {
    const { view, cx, asyncCx, flush, state } = setup()
    await flush()
    state.operationGate = deferred()
    state.operateError = "Fixture late transaction rejection"
    const id = galleryId("terminal-tools")
    click(view, `action-install-${id}`, cx)
    click(view, "close-manager", cx)
    const notifications = asyncCx.notify.mock.calls.length
    state.operationGate.resolve()
    await flush()
    expect(asyncCx.notify).toHaveBeenCalledTimes(notifications)
    expect(view.noticeError).toBe(true)
    expect(view.notice).toBe("Fixture late transaction rejection")
    expect(view.session.pending).toBeNull()
    expect(view.session.mod(id).state).toBe("available")
  })

  test.each([false, true])(
    "does not use task contexts after closing during load (failure: %s)",
    async (failure) => {
      const backend = fixture()
      backend.state.galleryGate = deferred()
      if (failure) backend.state.galleryError = "Fixture late Gallery failure"
      const { view, cx, asyncCx, flush } = setup({ backend })
      click(view, "close-manager", cx)
      const notifications = asyncCx.notify.mock.calls.length
      backend.state.galleryGate.resolve()
      await flush()
      expect(view.closed).toBe(true)
      expect(asyncCx.notify).toHaveBeenCalledTimes(notifications)
      expect(view.session.galleryStatus).toBe(failure ? "error" : "ready")
    },
  )

  test("lets a committed operation reconcile after close without canceling it or notifying a closed view", async () => {
    const backend = fixture()
    const { view, cx, asyncCx, flush } = setup({ backend })
    await flush()
    backend.state.afterCommitGate = deferred()
    click(view, `action-install-${galleryId("terminal-tools")}`, cx)
    await settleUntil(() => backend.state.records.some((mod) => mod.id === "terminal-tools"))
    click(view, "close-manager", cx)
    const notifications = asyncCx.notify.mock.calls.length
    backend.state.afterCommitGate.resolve()
    await flush()
    expect(asyncCx.notify).toHaveBeenCalledTimes(notifications)
    expect(view.session.mod(galleryId("terminal-tools")).state).toBe("installed")
    const reopened = setup({ backend })
    await reopened.flush()
    expect(reopened.view.session.mod(galleryId("terminal-tools")).state).toBe("installed")
  })

  test("renders bounded batches but searches the complete Gallery", async () => {
    const backend = fixture()
    backend.entries.splice(
      0,
      backend.entries.length,
      ...Array.from({ length: 75 }, (_, i) =>
        listing(`batch-${i}`, `Batch mod ${i}`, "Fixture batch"),
      ),
    )
    const { view, cx, flush } = setup({ backend })
    await flush()
    const cards = () =>
      descendants(view.render()).filter((node) =>
        String(node.attributes.id).startsWith("mod-mods:"),
      )
    expect(cards()).toHaveLength(50)
    expect(find(view, `mod-${galleryId("batch-74")}`)).toBeUndefined()
    click(view, "show-more-gallery", cx)
    expect(cards()).toHaveLength(75)
    search(view, "gallery", "Batch mod 74", cx)
    expect(cards()).toHaveLength(1)
    expect(find(view, `mod-${galleryId("batch-74")}`)).toBeDefined()
    search(view, "gallery", "", cx)
    expect(cards()).toHaveLength(50)
    click(view, "show-more-gallery", cx)
    click(view, "filter-github", cx)
    expect(cards()).toHaveLength(50)
  })

  test("notifies Installed completion while the Gallery request is still pending", async () => {
    const backend = fixture()
    backend.state.galleryGate = deferred()
    const { view, cx, asyncCx, flush } = setup({ backend })
    await settleUntil(() => view.session.discoveryStatus === "ready")
    await Promise.resolve()
    expect(view.session.galleryStatus).toBe("loading")
    expect(asyncCx.notify).toHaveBeenCalled()
    click(view, "nav-installed", cx)
    expect(find(view, `mod-${galleryId("focus-mode")}`)).toBeDefined()
    backend.state.galleryGate.resolve()
    await flush()
    expect(view.session.galleryStatus).toBe("ready")
  })

  test("opens the Website only on request and closes only its own overlay", async () => {
    native.openUrl.mockClear()
    native.closeOverlay.mockClear()
    const { view, cx, flush } = setup()
    await flush()
    expect(native.openUrl).not.toHaveBeenCalled()
    click(view, "open-gallery", cx)
    expect(native.openUrl).toHaveBeenCalledWith("https://herdr.dev/gallery/?type=mods")
    click(view, "close-manager", cx)
    expect(native.closeOverlay).toHaveBeenCalledWith("fixture-overlay")
  })

  test("starts the model inside an unowned task and uses a separate owned redraw task", async () => {
    const { view, cx, flush, io } = setup()
    await flush()
    cx.spawn.mockClear()
    const perform = vi.spyOn(view.session, "perform")
    click(view, `action-install-${galleryId("terminal-tools")}`, cx)
    expect(perform).not.toHaveBeenCalled()
    expect(io.operate).not.toHaveBeenCalled()
    expect(cx.spawn.mock.calls.map((call) => call[1])).toEqual([{ owner: null }, undefined])
    expect(view.operationQueued).toBe(true)
    await flush()
    expect(perform).toHaveBeenCalledTimes(1)
    expect(io.operate).toHaveBeenCalledTimes(1)
    expect(view.operationQueued).toBe(false)
  })

  test("closing before the unowned callback starts cannot cancel the operation or redraw", async () => {
    const { view, cx, asyncCx, flush, io } = setup()
    await flush()
    click(view, `action-install-${galleryId("terminal-tools")}`, cx)
    expect(io.operate).not.toHaveBeenCalled()
    click(view, "close-manager", cx)
    const before = asyncCx.notify.mock.calls.length
    await flush()
    expect(io.operate).toHaveBeenCalledTimes(1)
    expect(asyncCx.notify).toHaveBeenCalledTimes(before)
    expect(view.session.mod(galleryId("terminal-tools")).state).toBe("installed")
  })

  test("GitHub installation captures native input before close but starts the model only in its task", async () => {
    const { view, cx, asyncCx, flush, io } = setup()
    await flush()
    click(view, "nav-github", cx)
    view.repository.set_value("https://github.com/example/terminal-tools")
    const value = vi.spyOn(view.repository, "value")
    const install = vi.spyOn(view.session, "installRepository")
    click(view, "install-repository", cx)
    expect(value).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
    click(view, "close-manager", cx)
    value.mockImplementation(() => {
      throw new Error("Native input used after view close")
    })
    const before = asyncCx.notify.mock.calls.length
    await flush()
    expect(install).toHaveBeenCalledWith("https://github.com/example/terminal-tools")
    expect(io.operate).toHaveBeenCalledTimes(1)
    expect(asyncCx.notify).toHaveBeenCalledTimes(before)
    expect(view.noticeError).toBe(false)
  })

  test("a stalled Gallery does not disable Installed refresh, checks or confirmed uninstall", async () => {
    const backend = fixture()
    backend.state.galleryGate = deferred()
    const { view, cx, flush, io } = setup({ backend })
    await settleUntil(() => view.session.discoveryStatus === "ready")
    click(view, "nav-installed", cx)
    expect(find(view, "refresh-library").attributes.disabled).toBe(false)
    click(view, "refresh-library", cx)
    await settleUntil(
      () => io.discover.mock.calls.length >= 2 && view.session.discoveryStatus === "ready",
    )
    expect(view.session.galleryStatus).toBe("loading")
    click(view, "check-updates", cx)
    await settleUntil(() => !view.operationQueued)
    click(view, `action-uninstall-${galleryId("focus-mode")}`, cx)
    click(view, "confirm-uninstall", cx)
    await settleUntil(() => !view.operationQueued)
    expect(view.session.list("installed").some((mod) => mod.modName === "focus-mode")).toBe(false)
    expect(view.session.galleryStatus).toBe("loading")
    backend.state.galleryGate.resolve()
    await flush()
  })

  test("concurrent views sharing a session cannot start a second backend write", async () => {
    const backend = fixture()
    const first = setup({ backend })
    await first.flush()
    const second = setup({ backend, session: first.view.session, supplied: true })
    await second.flush()
    backend.state.operationGate = deferred()
    const control = `action-install-${galleryId("terminal-tools")}`
    click(first.view, control, first.cx)
    click(second.view, control, second.cx)
    await settleUntil(() => backend.io.operate.mock.calls.length === 1)
    expect(second.view.noticeError).toBe(true)
    first.view.close()
    backend.state.operationGate.resolve()
    await first.flush()
    await second.flush()
    expect(backend.io.operate).toHaveBeenCalledTimes(1)
    expect(second.view.session.mod(galleryId("terminal-tools")).state).toBe("installed")
  })

  test("browser failure is caught and leaves a printed Gallery URL", async () => {
    const { view, cx, flush } = setup()
    await flush()
    native.openUrl.mockImplementationOnce(() => {
      throw new Error("Browser unavailable")
    })
    expect(() => click(view, "open-gallery", cx)).not.toThrow()
    expect(view.noticeError).toBe(true)
    expect(contents(view.render())).toContain("https://herdr.dev/gallery/?type=mods")
    expect(view.notice).toContain("Could not open the browser")
  })

  test("both install routes show code trust and docking policy before mutation", async () => {
    const { view, cx, flush, io } = setup()
    await flush()
    const card = contents(find(view, `mod-${galleryId("terminal-tools")}`))
    expect(card).toContain("Community mods run code")
    expect(card).toContain("may load immediately")
    expect(card).toContain("omitted, none, left, right, top and bottom")
    expect(card).toContain("may dock immediately")
    click(view, "nav-github", cx)
    expect(contents(view.render())).toContain("Community mods run code")
    expect(contents(view.render())).toContain("may dock immediately")
    expect(io.operate).not.toHaveBeenCalled()
  })

  test("migration requires a name/path/source/kind review; cancel has no backend action", async () => {
    const backend = fixture()
    backend.state.migration = migration()
    const { view, cx, flush, io } = setup({ backend })
    await flush()
    expect(io.operate).not.toHaveBeenCalled()
    expect(find(view, `action-install-${galleryId("terminal-tools")}`).attributes.disabled).toBe(
      true,
    )
    click(view, "nav-installed", cx)
    expect(find(view, "check-updates").attributes.disabled).toBe(true)
    click(view, "nav-github", cx)
    expect(find(view, "install-repository").attributes.disabled).toBe(true)
    click(view, "review-migration", cx)
    expect(find(view, "migration-confirmation")).toBeDefined()
    for (const value of [
      "Name: Focus Mode",
      "Path: /fixture/herdr/mods/focus-mode",
      "Source: example/focus-mode",
      "Kind: package",
    ]) {
      expect(contents(view.render())).toContain(value)
    }
    click(view, "cancel-migration", cx)
    expect(view.session.migrationConfirmation).toBeNull()
    expect(io.operate).not.toHaveBeenCalled()
    click(view, "review-migration", cx)
    click(view, "confirm-migration", cx)
    expect(io.operate).not.toHaveBeenCalled()
    await flush()
    expect(io.operate).toHaveBeenCalledWith({ action: "migrate", migrationToken: "a".repeat(64) })
    expect(view.session.migration.required).toBe(false)
    expect(view.session.migrationConfirmation).toBeNull()
  })

  test("blocked recovery reason stays visible while browsing and cannot migrate", async () => {
    const backend = fixture()
    backend.state.migration = migration({
      blocked: true,
      reason: "Unknown lock; retained /fixture/recovery",
    })
    const { view, cx, flush, io } = setup({ backend })
    await flush()
    expect(contents(view.render())).toContain("/fixture/recovery")
    expect(find(view, "review-migration").attributes.disabled).toBe(true)
    click(view, "nav-installed", cx)
    expect(find(view, `mod-${galleryId("focus-mode")}`)).toBeDefined()
    expect(io.operate).not.toHaveBeenCalled()
  })

  test("stale migration handlers cannot confirm a replacement summary", async () => {
    const backend = fixture()
    backend.state.migration = migration()
    const { view, cx, flush, io } = setup({ backend })
    await flush()
    click(view, "review-migration", cx)
    const old = find(view, "confirm-migration").click
    const oldCancel = find(view, "cancel-migration").click
    click(view, "cancel-migration", cx)
    backend.state.migration.token = "b".repeat(64)
    await view.session.refreshInstalled()
    click(view, "review-migration", cx)
    old({}, cx)
    oldCancel({}, cx)
    await flush()
    expect(io.operate).not.toHaveBeenCalled()
    expect(view.session.migrationConfirmation.summary.token).toBe("b".repeat(64))
    backend.state.migration.token = "c".repeat(64)
    click(view, "confirm-migration", cx)
    await flush()
    expect(view.notice).toContain("stale")
    expect(io.operate).not.toHaveBeenCalled()
  })

  test("Git removal confirms archive/history retention and the displayed destination", async () => {
    const backend = fixture()
    const archivePath = "/fixture/herdr/data/mod-manager/archives/focus-mode-1"
    Object.assign(backend.state.records[0], { kind: "git", archivePath })
    const { view, cx, flush, io } = setup({ backend })
    await flush()
    click(view, `action-uninstall-${galleryId("focus-mode")}`, cx)
    expect(contents(view.render())).toContain("complete Git checkout and history")
    expect(contents(view.render())).toContain(`Retained Git archive: ${archivePath}`)
    click(view, "cancel-uninstall", cx)
    expect(io.operate).not.toHaveBeenCalled()
    click(view, `action-uninstall-${galleryId("focus-mode")}`, cx)
    click(view, "confirm-uninstall", cx)
    await flush()
    expect(io.operate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "uninstall", archiveGit: true, archivePath }),
    )
  })
})

function migration(overrides = {}) {
  return {
    required: true,
    blocked: false,
    token: "a".repeat(64),
    targets: [
      {
        id: "focus-mode",
        path: "/fixture/herdr/mods/focus-mode",
        repository: "example/focus-mode",
        kind: "package",
      },
    ],
    ...overrides,
  }
}
