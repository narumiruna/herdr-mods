import { describe, expect, mock, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  age,
  createGitHub,
  detailArgs,
  LIMIT,
  listArgs,
  repositoryFromRemote,
  repositoryName,
  stateLabel,
  withDeadline,
} from "./github.js"

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
const fail = (message) => ({ code: 1, stdout: "", stderr: message })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("repository names", () => {
  test("accepts names, GitHub URLs, .git, and common origin formats", () => {
    for (const value of [
      "cli/cli",
      " cli/cli ",
      "https://github.com/cli/cli/",
      "https://github.com/cli/cli.git",
    ]) {
      expect(repositoryName(value)).toBe("cli/cli")
    }
    for (const value of [
      "https://github.com/cli/cli.git",
      "git@github.com:cli/cli.git",
      "ssh://git@github.com/cli/cli.git",
    ]) {
      expect(repositoryFromRemote(`${value}\n`)).toBe("cli/cli")
    }
  })
  test("rejects unsupported hosts, extra paths, options, and shell text", () => {
    for (const value of [
      "",
      "--help",
      "cli/cli;echo bad",
      "cli/cli/issues",
      "https://example.com/cli/cli",
      "cli/..",
      "cli/.",
    ]) {
      expect(() => repositoryName(value)).toThrow()
    }
    expect(() => repositoryFromRemote("git@example.com:cli/cli")).toThrow("not on github.com")
  })
})

describe("read-only queries", () => {
  test("keeps search text as one argument and caps results", () => {
    const search = 'label:"help wanted" assignee:@me; echo bad'
    const args = listArgs("cli/cli", "issue", "all", search)
    expect(args.slice(0, 2)).toEqual(["issue", "list"])
    expect(args[args.indexOf("--limit") + 1]).toBe(String(LIMIT))
    expect(args.slice(-2)).toEqual(["--search", search])
    expect(args[args.indexOf("--json") + 1]).not.toContain("isDraft")
  })
  test("requests PR metadata and valid detail fields", () => {
    expect(listArgs("cli/cli", "pr", "closed").join(",")).toContain("reviewDecision")
    expect(detailArgs("cli/cli", "pr", 12)).toContain("12")
    expect(detailArgs("cli/cli", "issue", 12).at(-1)).toContain("body")
    for (const value of [0, -1, 1.5, "1;echo bad"])
      expect(() => detailArgs("cli/cli", "issue", value)).toThrow()
  })
  test("formats all item states and invalid timestamps", () => {
    expect(stateLabel({ state: "OPEN" })).toBe("Open")
    expect(stateLabel({ state: "OPEN", isDraft: true })).toBe("Draft")
    expect(stateLabel({ state: "CLOSED", isDraft: true })).toBe("Closed")
    expect(stateLabel({ state: "MERGED" })).toBe("Merged")
    expect(age("bad")).toBe("")
    const now = Date.parse("2026-01-01T00:00:00Z")
    expect(age("2025-12-31T23:58:00Z", now)).toBe("2m")
    expect(age("2026-01-02T00:00:00Z", now)).toBe("now")
  })
})

describe("CLI transport", () => {
  test("uses native gh without a shell", async () => {
    const calls = []
    const client = createGitHub(async (...args) => {
      calls.push(args)
      return ok([])
    }, "windows")
    expect(await client.read(listArgs("cli/cli", "issue", "open"))).toEqual([])
    expect(calls.map((call) => call[0])).toEqual(["gh", "gh"])
    expect(client.transport).toBe("gh")
  })
  test("falls back to gh in the default WSL distribution on Windows", async () => {
    const calls = []
    const client = createGitHub(async (command, args) => {
      calls.push([command, args])
      if (command === "gh") throw new Error("not found")
      return ok([])
    }, "windows")
    await client.read(["issue", "list"])
    expect(calls[1]).toEqual(["wsl.exe", ["--exec", "gh", "--version"]])
    expect(calls[2]).toEqual(["wsl.exe", ["--exec", "gh", "issue", "list"]])
    expect(client.transport).toBe("WSL gh")
  })
  test("does not switch accounts after an authentication failure", async () => {
    const calls = []
    const client = createGitHub(async (command, args) => {
      calls.push(command)
      return args[0] === "--version" ? ok("") : fail("Run gh auth login")
    }, "windows")
    await expect(client.read(["issue", "list"])).rejects.toThrow("gh auth login")
    expect(calls).toEqual(["gh", "gh"])
  })
  test("reports invalid JSON and missing CLI", async () => {
    const client = createGitHub(async () => ({ code: 0, stdout: "not JSON" }), "linux")
    await expect(client.read([])).rejects.toThrow("invalid JSON")
    const missing = createGitHub(async () => {
      throw new Error("not found")
    }, "linux")
    await expect(missing.read([])).rejects.toThrow("Install gh")
  })
  test("retries discovery after installation and caches only completed discovery", async () => {
    let installed = false
    let probes = 0
    const client = createGitHub(async (_command, args) => {
      if (args[0] === "--version") {
        probes++
        if (!installed) throw new Error("not found")
      }
      return ok([])
    }, "linux")
    await expect(client.read([])).rejects.toThrow()
    installed = true
    await Promise.all([client.read([]), client.read([])])
    expect(probes).toBe(3)
    await client.read([])
    expect(probes).toBe(3)
  })
  test("a stuck old probe does not block a new read or replace its transport", async () => {
    const old = deferred()
    let probes = 0
    const client = createGitHub(async (command, args) => {
      if (command === "gh" && args[0] === "--version") {
        if (++probes === 1) return old.promise
        throw new Error("not found")
      }
      return ok([])
    }, "windows")
    const first = client.read([])
    await client.read([])
    expect(client.transport).toBe("WSL gh")
    old.resolve(ok(""))
    await first
    expect(client.transport).toBe("WSL gh")
  })
  for (const machine of ["m4", "m2"]) {
    test(`routes gh probe, list, and detail to ${machine} even on a Windows host`, async () => {
      const calls = []
      const client = createGitHub(
        async (command, args, options) => {
          calls.push({ command, args, options })
          return args.includes("view") ? ok({ number: 1, body: machine }) : ok([])
        },
        "windows",
        machine,
      )
      expect(await client.read(listArgs("owner/repo", "issue", "open"))).toEqual([])
      expect(await client.read(detailArgs("owner/repo", "issue", 1))).toEqual({
        number: 1,
        body: machine,
      })
      expect(client.machine).toBe(machine)
      expect(client.transport).toBe("gh")
      expect(calls.map((call) => [call.command, call.args.slice(0, 2)])).toEqual([
        ["gh", ["--version"]],
        ["gh", ["issue", "list"]],
        ["gh", ["issue", "view"]],
      ])
      expect(calls.map((call) => call.options.on)).toEqual([machine, machine, machine])
      expect(calls.every((call) => call.options.cwd === undefined)).toBe(true)
    })
    test(`does not fall back from ${machine} when gh is missing or unauthenticated`, async () => {
      for (const missing of [true, false]) {
        const calls = []
        const client = createGitHub(
          async (command, args, options) => {
            calls.push({ command, args, options })
            if (missing) throw new Error("not found")
            return args.includes("--version") ? ok("") : fail("Run gh auth login")
          },
          "windows",
          machine,
        )
        await expect(client.read(listArgs("owner/repo", "issue", "open"))).rejects.toThrow(
          missing ? "Install gh" : "gh auth login",
        )
        expect(calls.map((call) => call.command)).toEqual(missing ? ["gh"] : ["gh", "gh"])
        expect(calls.map((call) => call.options.on)).toEqual(
          missing ? [machine] : [machine, machine],
        )
      }
    })
  }
  test("independent deadlines reject stalled host promises and cancel their timer", async () => {
    const pending = deferred()
    const timers = []
    const timer = {
      after(ms, fire) {
        const task = {
          ms,
          fire,
          cancelled: false,
          cancel() {
            this.cancelled = true
          },
        }
        timers.push(task)
        return task
      },
    }
    const result = withDeadline(timer, 12000, () => pending.promise, "origin timed out")
    timers[0].fire()
    await expect(result).rejects.toThrow("origin timed out")
    expect(timers[0].cancelled).toBe(true)
    pending.resolve(ok(""))
    expect(await withDeadline(timer, 12000, () => Promise.resolve("done"), "timeout")).toBe("done")
    expect(timers[1].cancelled).toBe(true)
  })
})

// Mock native builders to exercise deferred list/detail render paths and request ordering.
const uiElements = new Map()
const builder = (id, content) => {
  const node = { children: content ? [content] : [], props: {}, handlers: {} }
  let proxy
  proxy = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "node") return node
        return (...args) => {
          if (name === "id") uiElements.set(args[0], proxy)
          else if (name === "child") node.children.push(args[0])
          else if (name === "children") node.children.push(...args[0])
          else if (name === "when") {
            if (args[0]) args[1](proxy)
          } else if (String(name).startsWith("on_")) {
            node.handlers[name] = args.at(-1)
            if (args.length > 1) node.handlers[`${name}_${args[0]}`] = args.at(-1)
          } else node.props[name] = args.length === 1 ? args[0] : args
          return proxy
        }
      },
    },
  )
  if (id !== undefined) uiElements.set(id, proxy)
  return proxy
}
let spaceList = []
let paneList = []
let hostProps = {}
let hostExec
let hostFocus = null
let hostLayout
let hostWindow
let panelPreferences
let commands
let overlays
let storage
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
mock.module("gpui-kit", () => ({ View: class {}, div: builder, svg: builder, image: builder }))
mock.module("gpui-base", () => ({
  v_flex: builder,
  h_flex: builder,
  Button: { new: builder },
  Scrollbar: { vertical: builder },
  TextView: { markdown: builder },
  Input: { new: builder },
  InputState: {
    new: ({ value = "" } = {}) => {
      const handlers = {}
      return {
        value: () => value,
        set_value: (next) => {
          value = next
          handlers.change?.()
        },
        on: (event, handler) => {
          handlers[event] = handler
          return true
        },
      }
    },
  },
}))
mock.module("herdr", () => ({
  exec: (...args) => hostExec(...args),
  spaces: () => spaceList,
  panes: () => paneList,
  focused: () => hostFocus,
  theme: () => ({}),
  window: () => hostWindow,
  props: () => hostProps,
  run: (name, args) => commands.push({ name, args }),
  openOverlay: (options) => overlays.push(options),
  shared: () => panelPreferences,
  layout: () => hostLayout,
  settings: () => ({ zoom: 1 }),
}))
const { default: GitHubIssuesPRs } = await import("./main.js")
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
async function view(options = {}) {
  spaceList = options.spaces ?? []
  paneList = options.panes ?? []
  hostProps = options.props ?? {}
  hostFocus = options.focus ?? null
  hostExec =
    options.exec ??
    (async () => {
      throw new Error("Unexpected host exec in unit test")
    })
  hostLayout = options.layout ?? null
  hostWindow = options.window ?? null
  panelPreferences = options.preferences ?? ["files", "changes"]
  commands = []
  overlays = []
  storage = options.storage ?? new Map()
  const tasks = []
  const timers = []
  const periodic = []
  const cx = {
    notify() {},
    stop_propagation() {},
    focus_handle() {
      return {
        count: 0,
        focus() {
          this.count++
        },
      }
    },
    timer: {
      every(ms, handler) {
        periodic.push({ ms, handler })
      },
      after(ms, handler) {
        const task = {
          ms,
          cancelled: false,
          fire() {
            if (!this.cancelled) handler(cx)
          },
          cancel() {
            this.cancelled = true
          },
        }
        timers.push(task)
        if (ms === 200 && !options.holdFollow) Promise.resolve().then(() => task.fire())
        return task
      },
    },
    spawn(fn) {
      const task = Promise.resolve().then(() => fn(cx))
      tasks.push(task)
    },
  }
  const panel = new GitHubIssuesPRs()
  panel.init(options.initialProps, cx)
  await tick()
  return { panel, cx, tasks, timers, periodic }
}
const item = (number) => ({
  number,
  title: `Unicode 中文 #${number}`,
  url: `https://github.com/cli/cli/issues/${number}`,
  state: "OPEN",
  author: null,
  labels: [],
  updatedAt: "2026-01-01T00:00:00Z",
})

const terminal = (pane, cwd, tab = "tab") => ({ pane, terminal: `t-${pane}`, cwd, tab })
async function paneView(options = {}) {
  const calls = []
  const result = await view({
    spaces: [
      {
        id: "space",
        active: true,
        machine: null,
        folder: "/fallback",
        tabs: [{ id: "old" }, { id: "tab", active: true }],
      },
    ],
    panes: [terminal("old", "/old", "old"), terminal("a", "/a"), terminal("b", "/b")],
    focus: { space: "space", tab: "tab", pane: "a", terminal: "t-a" },
    exec: async (command, args, options) => {
      calls.push({ command, args, options })
      return command === "git"
        ? { code: 0, stdout: `git@github.com:owner/${options.cwd.slice(1)}.git` }
        : args.includes("--version")
          ? ok("")
          : ok([item(1)])
    },
    ...options,
  })
  return { ...result, calls }
}

const layoutExamples = [
  ...readFileSync(new URL("./README.md", import.meta.url), "utf8").matchAll(
    /```json\r?\n([\s\S]*?)\r?\n```/g,
  ),
].map((match) => JSON.parse(match[1]))
function tabBarLayout() {
  return {
    id: "root",
    children: [
      structuredClone(layoutExamples[0]),
      {
        id: "panel",
        hidden: true,
        children: [
          {
            id: "panel-body",
            active: "files",
            children: [{ id: "files" }, { id: "changes" }, structuredClone(layoutExamples[1])],
          },
        ],
      },
    ],
  }
}
const rightPanel = () => hostLayout.children.find((node) => node.id === "panel")
async function tabBarView(options = {}) {
  const result = await view({
    props: { tabs: true },
    layout: tabBarLayout(),
    spaces: [{ id: "space-one", active: true, tabs: [] }],
    ...options,
  })
  renderText(result.panel, result.cx)
  return result
}

describe("one-mod entry point", () => {
  test("documents two copies of the same mod with different props", () => {
    expect(layoutExamples).toHaveLength(2)
    expect(layoutExamples[0]).toEqual({
      id: "tabs",
      type: "block",
      content: { mod: "github-issues-prs", props: { tabs: true } },
    })
    expect(layoutExamples[1]).toEqual({
      id: "github",
      type: "block",
      content: { mod: "github-issues-prs" },
    })
  })
  test("tab-bar mode does not create panel state, requests, inputs, or timers", async () => {
    const calls = []
    const { panel, tasks, timers, periodic } = await tabBarView({
      props: { tabs: true, repo: "owner/repo" },
      exec: async (...args) => {
        calls.push(args)
        return ok([])
      },
    })
    expect(panel.tabBar).toBeDefined()
    expect(panel.clients).toBeUndefined()
    expect(panel.searchInput).toBeUndefined()
    expect(calls).toEqual([])
    expect(tasks).toEqual([])
    expect(timers).toEqual([])
    expect(periodic).toEqual([])
    expect(uiElements.has("tab-scroll")).toBe(true)
    expect(uiElements.has("github-repo")).toBe(false)
  })
  test("explicit initial props select the tab bar before host props", async () => {
    const { panel } = await tabBarView({ props: {}, initialProps: { tabs: true } })
    expect(panel.tabBar).toBeDefined()
    expect(uiElements.has("panel-github")).toBe(true)
  })
  for (const tabs of [undefined, false, "true", 1]) {
    test(`keeps the default panel for tabs=${String(tabs)}`, async () => {
      const { panel, cx } = await view({ props: { tabs } })
      expect(panel.tabBar).toBeUndefined()
      expect(panel.clients).toBeInstanceOf(Map)
      expect(renderText(panel, cx)).toContain("GitHub Issues & PRs")
      expect(uiElements.has("tab-scroll")).toBe(false)
    })
  }
  test("keeps independent panel and tab-bar copies with fixed modes", async () => {
    const panelView = await view()
    const tabsView = await tabBarView()
    hostProps = {}
    expect(renderText(tabsView.panel, tabsView.cx)).toContain("GitHub Issues & PRs")
    expect(uiElements.has("tab-scroll")).toBe(true)
    expect(renderText(panelView.panel, panelView.cx)).toContain("GitHub Issues & PRs")
    expect(uiElements.has("github-repo")).toBe(true)
    expect(panelView.panel.tabBar).toBeUndefined()
  })
})

describe("workspace tab bar", () => {
  for (const saved of ["{", "null", "[]", '"github"', "1", "true"]) {
    test(`recovers from invalid saved panels: ${saved}`, async () => {
      const storage = new Map([["panels", saved]])
      const { panel, cx } = await tabBarView({ storage })
      expect(uiElements.has("tab-scroll")).toBe(true)
      expect(commands).toEqual([])
      expect(panel.tabBar.panels).toEqual({ "space-one": null })
      rightPanel().hidden = false
      rightPanel().children[0].active = "github"
      panel.render(cx)
      expect(JSON.parse(storage.get("panels"))).toEqual({ "space-one": "github" })
    })
  }
  test("restores a valid saved panel preference", async () => {
    await tabBarView({ storage: new Map([["panels", '{"space-one":"github"}']]) })
    expect(commands).toEqual([
      { name: "layout.select", args: { stack: "panel-body", child: "github" } },
      { name: "layout.show", args: { id: "panel" } },
    ])
  })
  test("shows GitHub beside Files and Changes", async () => {
    await tabBarView()
    for (const id of ["panel-files", "panel-changes", "panel-github"])
      expect(uiElements.has(id)).toBe(true)
    expect(commands).toEqual([])
  })
  test("opens GitHub in the shared right panel, not an overlay", async () => {
    await tabBarView()
    uiElements.get("panel-github").node.handlers.on_click()
    expect(commands).toEqual([
      { name: "layout.select", args: { stack: "panel-body", child: "github" } },
      { name: "layout.show", args: { id: "panel" } },
    ])
    expect(rightPanel().children[0].children.find((node) => node.id === "github").content.mod).toBe(
      "github-issues-prs",
    )
    expect(overlays).toEqual([])
  })
  test("clicking the active GitHub button closes the panel", async () => {
    const layout = tabBarLayout()
    const panel = layout.children[1]
    panel.hidden = false
    panel.children[0].active = "github"
    await tabBarView({ layout })
    uiElements.get("panel-github").node.handlers.on_click()
    expect(commands).toEqual([{ name: "layout.hide", args: { id: "panel" } }])
  })
  test("Files and Changes keep their panel switching behavior", async () => {
    await tabBarView()
    for (const id of ["files", "changes"]) {
      commands = []
      uiElements.get(`panel-${id}`).node.handlers.on_click()
      expect(commands).toEqual([
        { name: "layout.select", args: { stack: "panel-body", child: id } },
        { name: "layout.show", args: { id: "panel" } },
      ])
    }
  })
  test("keeps GitHub available without changing Files/Changes preferences", async () => {
    await tabBarView({ preferences: [] })
    expect(uiElements.has("panel-files")).toBe(false)
    expect(uiElements.has("panel-changes")).toBe(false)
    expect(uiElements.has("panel-github")).toBe(true)
    expect(panelPreferences).toEqual([])
  })
  test("remembers GitHub per space and restores it after switching back", async () => {
    const layout = tabBarLayout()
    const panel = layout.children[1]
    panel.hidden = false
    panel.children[0].active = "github"
    const { panel: view, cx } = await tabBarView({ layout })
    expect(JSON.parse(storage.get("panels"))["space-one"]).toBe("github")
    spaceList = [{ id: "space-two", active: true, tabs: [] }]
    view.render(cx)
    expect(commands.at(-1)).toEqual({ name: "layout.hide", args: { id: "panel" } })
    panel.hidden = true
    view.render(cx)
    commands = []
    spaceList = [{ id: "space-one", active: true, tabs: [] }]
    view.render(cx)
    expect(commands).toEqual([
      { name: "layout.select", args: { stack: "panel-body", child: "github" } },
      { name: "layout.show", args: { id: "panel" } },
    ])
  })
  test("loads tab-bar icons from this mod and keeps window controls", async () => {
    const { panel, cx } = await tabBarView({ window: { platform: "windows", buttons: true } })
    for (const name of ["github", "win-min", "win-max", "win-close"]) {
      expect(uiElements.has(`mods/github-issues-prs/icons/${name}.svg`)).toBe(true)
      expect(existsSync(new URL(`./icons/${name}.svg`, import.meta.url))).toBe(true)
    }
    for (const [id, name] of [
      ["minimize", "window.minimize"],
      ["maximize", "window.maximize"],
      ["close-window", "window.close"],
    ]) {
      uiElements.get(id).node.handlers.on_click()
      expect(commands.at(-1)).toEqual({ name, args: undefined })
    }
    hostWindow.maximized = true
    renderText(panel, cx)
    expect(uiElements.has("mods/github-issues-prs/icons/win-restore.svg")).toBe(true)
    expect(existsSync(new URL("./icons/win-restore.svg", import.meta.url))).toBe(true)
  })
  test("keeps tab select, reorder, rename, close, and new-tab actions", async () => {
    const { panel, cx } = await tabBarView({
      spaces: [
        {
          id: "space-one",
          active: true,
          tabs: [
            { id: "one", name: "tb1", active: true },
            { id: "two", name: "Named" },
          ],
        },
      ],
    })
    uiElements.get("tab-one").node.handlers.on_mouse_up_left()
    expect(commands.at(-1)).toEqual({ name: "tab.select", args: { id: "one" } })
    uiElements.get("tab-one").node.handlers.on_mouse_down_left({ click_count: 1 }, cx)
    uiElements.get("tab-two").node.handlers.on_mouse_up_left()
    expect(commands.at(-1)).toEqual({ name: "tab.move", args: { id: "one", index: 2 } })
    uiElements.get("tab-one").node.handlers.on_mouse_down_left({ click_count: 2 }, cx)
    expect(commands.at(-1)).toEqual({ name: "tab.rename", args: { id: "one" } })
    uiElements.get("close-one").node.handlers.on_click({}, cx)
    expect(commands.at(-1)).toEqual({ name: "tab.close", args: { id: "one" } })
    uiElements.get("tab-new").node.handlers.on_click()
    expect(overlays.at(-1)).toEqual({ mod: "new-menu", kind: "popup", width: 250, height: 512 })
    const root = panel.render(cx)
    root.node.handlers.on_scroll_wheel({ delta: { y: 2 } })
    expect(commands.at(-1)).toEqual({ name: "tab.prev", args: undefined })
    root.node.handlers.on_scroll_wheel({ delta: { y: -2 } })
    expect(commands.at(-1)).toEqual({ name: "tab.next", args: undefined })
  })
})

describe("pane following and smooth switching", () => {
  test("uses the focused terminal in the active tab instead of the first workspace pane", async () => {
    const { panel } = await paneView({ focus: { tab: "tab", pane: "b", terminal: "t-b" } })
    expect(panel.repository).toBe("owner/b")
    expect(panel.location().cwd).toBe("/b")
  })
  test("keeps the last terminal when the GitHub panel receives keyboard focus", async () => {
    const { panel, cx, calls } = await paneView({
      focus: { tab: "tab", pane: "b", terminal: "t-b" },
    })
    const count = calls.length
    hostFocus = { tab: "tab", pane: null, terminal: null }
    panel.render(cx)
    await tick()
    expect(panel.repository).toBe("owner/b")
    expect(calls.length).toBe(count)
  })
  test("uses the active tab's terminal before a terminal in another tab", async () => {
    const { panel, cx } = await paneView()
    spaceList[0].tabs = [{ id: "old", active: true }, { id: "tab" }]
    hostFocus = { tab: "old", pane: "viewer", terminal: null }
    panel.render(cx)
    await tick()
    expect(panel.repository).toBe("owner/old")
  })
  test("falls back to another terminal after the focused pane closes", async () => {
    const { panel, cx } = await paneView({ focus: { tab: "tab", pane: "b", terminal: "t-b" } })
    paneList = paneList.filter((pane) => pane.pane !== "b")
    panel.render(cx)
    await tick()
    expect(panel.repository).toBe("owner/a")
    expect(panel.loading).toBe(false)
  })
  test("combines rapid pane changes into one lookup after 200 ms", async () => {
    const { panel, cx, calls, timers } = await paneView({ holdFollow: true })
    paneList.push(terminal("c", "/c"))
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    hostFocus = { tab: "tab", pane: "c", terminal: "t-c" }
    panel.render(cx)
    panel.render(cx)
    const follows = timers.filter((timer) => timer.ms === 200)
    expect(follows.length).toBe(2)
    expect(follows[0].cancelled).toBe(true)
    expect(calls.filter((call) => call.command === "git").length).toBe(1)
    follows.at(-1).fire()
    await tick()
    expect(calls.filter((call) => call.command === "git").map((call) => call.options.cwd)).toEqual([
      "/a",
      "/c",
    ])
    expect(panel.repository).toBe("owner/c")
  })
  test("switching between panes in the same folder performs no new commands", async () => {
    const { panel, cx, calls } = await paneView({
      panes: [terminal("a", "/shared"), terminal("b", "/shared")],
    })
    const count = calls.length
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    await tick()
    expect(calls.length).toBe(count)
    expect(panel.repository).toBe("owner/shared")
  })
  test("same-repo worktrees retain results and preview without another GitHub query", async () => {
    let queries = 0
    const { panel, cx } = await paneView({
      exec: async (command, args) => {
        if (command === "git") return { code: 0, stdout: "git@github.com:owner/shared.git" }
        if (!args.includes("--version")) queries++
        return args.includes("--version") ? ok("") : ok([item(1)])
      },
    })
    const rows = panel.items
    const detail = { ...item(1), body: "Keep reading" }
    panel.selected = item(1)
    panel.detail = detail
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    await tick()
    expect(queries).toBe(1)
    expect(panel.items).toBe(rows)
    expect(panel.detail).toBe(detail)
    expect(panel.loading).toBe(false)
    panel.selected = null
    panel.refresh(cx, false)
    await tick()
    expect(queries).toBe(2)
    panel.resultAt = Date.now() - 120001
    hostFocus = { tab: "tab", pane: "a", terminal: "t-a" }
    panel.render(cx)
    await tick()
    expect(queries).toBe(3)
  })
  test("retains old content during origin lookup and clears it when a different repo is known", async () => {
    const origin = deferred()
    const query = deferred()
    const { panel, cx } = await paneView({
      exec: async (command, args, options) => {
        if (command === "git")
          return options.cwd === "/b"
            ? origin.promise
            : { code: 0, stdout: "git@github.com:owner/a.git" }
        return args.includes("--version")
          ? ok("")
          : args.includes("owner/b")
            ? query.promise
            : ok([item(1)])
      },
    })
    const rows = panel.items
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    await tick()
    expect(panel.items).toBe(rows)
    expect(panel.repository).toBe("owner/a")
    origin.resolve({ code: 0, stdout: "git@github.com:owner/b.git" })
    await tick()
    expect(panel.repository).toBe("owner/b")
    expect(panel.items).toEqual([])
    query.resolve(ok([item(2)]))
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([2])
  })
  test("resumes a preview discarded during an A-B-A focus change before debounce fires", async () => {
    const { panel, cx } = await paneView({ holdFollow: true })
    const first = deferred()
    let previews = 0
    panel.clients.set(panel.queryMachine, {
      read: async () => (++previews === 1 ? first.promise : { ...item(1), body: "Loaded preview" }),
    })
    panel.pick(item(1), cx)
    await tick()
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    first.resolve({ ...item(1), body: "Discarded preview" })
    await tick()
    expect(panel.detail).toBeNull()
    hostFocus = { tab: "tab", pane: "a", terminal: "t-a" }
    panel.render(cx)
    await tick()
    expect(panel.detail?.body).toBe("Loaded preview")
    expect(previews).toBe(2)
    expect(panel.detailPending).toBe(false)
  })
  test("a failed refresh after confirming the same origin keeps list, preview, and repository", async () => {
    let queries = 0
    const { panel, cx } = await paneView({
      exec: async (command, args) => {
        if (command === "git") return { code: 0, stdout: "git@github.com:owner/shared.git" }
        if (args.includes("--version")) return ok("")
        if (++queries > 1) throw new Error("Network unavailable")
        return ok([item(1)])
      },
    })
    const rows = panel.items
    const detail = { ...item(1), body: "Keep reading" }
    panel.selected = item(1)
    panel.detail = detail
    panel.resultAt = Date.now() - 120001
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    await tick()
    expect(panel.items).toBe(rows)
    expect(panel.detail).toBe(detail)
    expect(panel.repository).toBe("owner/shared")
    expect(panel.error).toContain("Network unavailable")
    expect(panel.loading).toBe(false)
  })
  test("a context change before a spawned refresh starts still ends Loading", async () => {
    const { panel, cx } = await paneView({ holdFollow: true })
    panel.refresh(cx)
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    await tick()
    expect(panel.loading).toBe(false)
    expect(panel.loadedContext).toBeNull()
    hostFocus = { tab: "tab", pane: "a", terminal: "t-a" }
    panel.render(cx)
    panel.followTimer?.fire()
    await tick()
    expect(panel.repository).toBe("owner/a")
    expect(panel.items.length).toBe(1)
    expect(panel.loading).toBe(false)
  })
  test("recovers an initial request discarded during an A-B-A focus change", async () => {
    const first = deferred()
    let queries = 0
    const { panel, cx, timers } = await paneView({
      holdFollow: true,
      exec: async (command, args, options) =>
        command === "git"
          ? { code: 0, stdout: `git@github.com:owner/${options.cwd.slice(1)}.git` }
          : args.includes("--version")
            ? ok("")
            : ++queries === 1
              ? first.promise
              : ok([item(2)]),
    })
    hostFocus = { tab: "tab", pane: "b", terminal: "t-b" }
    panel.render(cx)
    first.resolve(ok([item(1)]))
    await tick()
    hostFocus = { tab: "tab", pane: "a", terminal: "t-a" }
    panel.render(cx)
    timers
      .filter((timer) => timer.ms === 200 && !timer.cancelled)
      .at(-1)
      .fire()
    await tick()
    expect(panel.repository).toBe("owner/a")
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.loading).toBe(false)
  })
})

function renderText(panel, cx) {
  uiElements.clear()
  const root = panel.render(cx)
  const visit = (element) =>
    typeof element === "string" || typeof element === "number"
      ? [String(element)]
      : element?.node
        ? element.node.children.flatMap(visit)
        : []
  return visit(root).join("\n")
}

describe("redesigned interface", () => {
  test("uses the renamed mod title and icon paths", async () => {
    const metadata = JSON.parse(readFileSync(new URL("./mod.json", import.meta.url), "utf8"))
    expect(metadata.title).toBe("GitHub Issues & PRs")
    const { panel } = await view()
    uiElements.clear()
    for (const name of [
      "alert",
      "arrow-left",
      "external",
      "issue",
      "pull-request",
      "refresh",
      "repository",
      "search",
    ]) {
      panel.icon(name)
      expect(uiElements.has(`mods/github-issues-prs/icons/${name}.svg`)).toBe(true)
      expect(existsSync(new URL(`./icons/${name}.svg`, import.meta.url))).toBe(true)
    }
  })
  test("shows read-only repository context and full tab labels without legacy controls", async () => {
    const { panel, cx } = await view({ props: { repo: "owner/repo" }, exec: async () => ok([]) })
    const text = renderText(panel, cx)
    expect(text).toContain("owner/repo")
    expect(text).toContain("Issues")
    expect(text).toContain("Pull Requests")
    expect(text).toContain("GitHub Issues & PRs")
    expect(uiElements.get("github-tab-pr").node.children).toContain("Pull Requests")
    for (const id of ["github-repository", "github-use", "github-auto"])
      expect(uiElements.has(id)).toBe(false)
    expect(uiElements.get("github-repo").node.props.text_size).toBe(11)
    expect(uiElements.get("github-tabs").node.props.role).toBe("tab_list")
    expect(uiElements.get("github-tab-issue").node.props.selected).toBe(true)
    expect(uiElements.get("github-tab-pr").node.props.selected).toBe(false)
    expect(uiElements.get("github-tab-pr").node.props.role).toBe("tab")
  })
  test("tab clicks and arrow, Home, and End keys select and focus the correct tab", async () => {
    const { panel, cx } = await view({ props: { repo: "owner/repo" }, exec: async () => ok([]) })
    renderText(panel, cx)
    uiElements.get("github-tab-pr").node.handlers.on_click({}, cx)
    await tick()
    expect(panel.kind).toBe("pr")
    renderText(panel, cx)
    uiElements.get("github-tab-pr").node.handlers.on_key_down({ key: "left" }, cx)
    await tick()
    expect(panel.kind).toBe("issue")
    expect(panel.tabHandles.issue.count).toBe(1)
    renderText(panel, cx)
    uiElements.get("github-tab-issue").node.handlers.on_key_down({ key: "end" }, cx)
    await tick()
    expect(panel.kind).toBe("pr")
    renderText(panel, cx)
    expect(uiElements.get("github-tab-pr").node.props.tab_stop).toBe(true)
    expect(uiElements.get("github-tab-issue").node.props.tab_stop).toBe(false)
    uiElements.get("github-tab-pr").node.handlers.on_key_down({ key: "home" }, cx)
    await tick()
    expect(panel.kind).toBe("issue")
  })
  test("Issues and Pull Requests retain independent applied search, drafts, and status filters", async () => {
    const { panel, cx } = await view({ props: { repo: "owner/repo" }, exec: async () => ok([]) })
    panel.selectState("closed", cx)
    panel.searchInput.set_value("label:bug")
    panel.submitSearch(cx)
    await tick()
    panel.searchInput.set_value("unfinished draft")
    panel.selectKind("pr", cx)
    await tick()
    expect(panel.state).toBe("open")
    expect(panel.search).toBe("")
    expect(panel.searchInput.value()).toBe("")
    panel.selectState("all", cx)
    panel.searchInput.set_value("author:@me")
    panel.submitSearch(cx)
    await tick()
    panel.selectKind("issue", cx)
    await tick()
    expect(panel.state).toBe("closed")
    expect(panel.search).toBe("label:bug")
    expect(panel.searchInput.value()).toBe("unfinished draft")
    panel.selectKind("pr", cx)
    await tick()
    expect(panel.state).toBe("all")
    expect(panel.search).toBe("author:@me")
  })
  test("non-repository folders show a neutral empty state instead of a fatal Git error", async () => {
    const { panel, cx } = await view({
      spaces: [{ id: "space", active: true, folder: "/settings", tabs: [] }],
      exec: async () => fail("fatal: not a git repository (or any parent): .git"),
    })
    expect(panel.error).toBe("")
    expect(panel.notice).toContain("no GitHub origin")
    const text = renderText(panel, cx)
    expect(text).toContain("No GitHub repository")
    expect(text).not.toContain("fatal:")
    expect(uiElements.has("github-search")).toBe(false)
    expect(uiElements.has("github-retry")).toBe(false)
  })
  test("non-GitHub origins are neutral but real operational errors still offer Retry", async () => {
    const { panel, cx } = await view({
      spaces: [{ id: "space", active: true, folder: "/repo", tabs: [] }],
      exec: async () => ({ code: 0, stdout: "git@example.com:owner/repo.git" }),
    })
    expect(panel.error).toBe("")
    expect(panel.notice).toContain("not on github.com")
    expect(renderText(panel, cx)).toContain("No GitHub repository")
    hostExec = async () => fail("Permission denied")
    panel.refresh(cx)
    await tick()
    expect(panel.notice).toBe("")
    expect(panel.error).toContain("Permission denied")
    expect(renderText(panel, cx)).toContain("Could not load issues")
    expect(uiElements.has("github-retry")).toBe(true)
  })
  test("empty pull-request results name the current filter and can clear an applied search", async () => {
    const { panel, cx } = await view({ props: { repo: "owner/repo" }, exec: async () => ok([]) })
    panel.selectKind("pr", cx)
    await tick()
    expect(renderText(panel, cx)).toContain("No open pull requests")
    panel.searchInput.set_value("no-match")
    panel.submitSearch(cx)
    await tick()
    expect(renderText(panel, cx)).toContain("No matching pull requests")
    uiElements.get("github-clear-search").node.handlers.on_click({}, cx)
    await tick()
    expect(panel.search).toBe("")
    expect(panel.searchInput.value()).toBe("")
  })
  test("detail reading hides list controls and preserves browser and Escape navigation", async () => {
    const { panel, cx } = await view({ props: { repo: "owner/repo" }, exec: async () => ok([]) })
    panel.kind = "pr"
    panel.selected = item(1)
    panel.detail = {
      ...item(1),
      body: "# Description",
      headRefName: "feature",
      baseRefName: "main",
      changedFiles: 2,
      additions: 8,
      deletions: 1,
      reviewDecision: "REVIEW_REQUIRED",
    }
    expect(renderText(panel, cx)).toContain("Review required")
    expect(uiElements.has("github-search")).toBe(false)
    expect(uiElements.has("github-state-open")).toBe(false)
    expect(uiElements.get("github-back").node.props.accessibility_label).toBe(
      "Back to pull requests",
    )
    let opened
    uiElements.get("github-open-browser").node.handlers.on_click(
      {},
      {
        open_url: (url) => {
          opened = url
        },
      },
    )
    expect(opened).toBe(item(1).url)
    uiElements.get("github").node.handlers.on_key_down({ key: "escape" }, cx)
    expect(panel.selected).toBeNull()
  })
})

describe("view state and deferred rendering", () => {
  test("automatically loads the focused workspace repository without edit controls", async () => {
    const calls = []
    const { panel } = await view({
      spaces: [{ id: "m4/one", active: true, machine: "m4", folder: "/repo", tabs: [] }],
      exec: async (command, args) => {
        calls.push(args)
        return command === "git"
          ? { code: 0, stdout: "git@github.com:owner/workspace.git" }
          : args.includes("--version")
            ? ok("")
            : ok([item(1)])
      },
    })
    expect(panel.pinned).toBe(false)
    expect(panel.repository).toBe("owner/workspace")
    expect(panel.items.length).toBe(1)
    expect(panel.loading).toBe(false)
    expect(calls.some((args) => args.includes("--repo") && args.includes("owner/workspace"))).toBe(
      true,
    )
  })

  test("an explicitly pinned props.repo keeps its captured machine across workspaces", async () => {
    const calls = []
    const { panel, cx } = await view({
      props: { repo: "owner/pinned" },
      spaces: [{ id: "m4/one", active: true, machine: "m4", folder: "/repo", tabs: [] }],
      exec: async (command, args, options) => {
        calls.push({ command, args, options })
        return args.includes("view") ? ok({ ...item(1), body: "Pinned m4" }) : ok([item(1)])
      },
    })
    const context = panel.context()
    const count = calls.length
    spaceList = [{ id: "m2/two", active: true, machine: "m2", folder: "/repo", tabs: [] }]
    panel.render(cx)
    await tick()
    expect(panel.context()).toBe(context)
    expect(calls.length).toBe(count)
    panel.refresh(cx, false)
    await tick()
    panel.pick(item(1), cx)
    await tick()
    expect(panel.pinned).toBe(true)
    expect(panel.pinnedMachine).toBe("m4")
    expect(panel.queryMachine).toBe("m4")
    expect(panel.cliMachine()).toBe("m4")
    expect(panel.client.machine).toBe("m4")
    expect(panel.repository).toBe("owner/pinned")
    expect(panel.detail?.body).toBe("Pinned m4")
    expect(calls.map((call) => call.command)).toEqual(["gh", "gh", "gh", "gh"])
    expect(calls.map((call) => call.options.on)).toEqual(["m4", "m4", "m4", "m4"])
    expect(calls.slice(1).every((call) => call.args.includes("owner/pinned"))).toBe(true)
    expect(renderText(panel, cx)).toContain("gh on m4")
    expect(uiElements.get("github-repo").node.props.tooltip).toContain("Pinned repository on m4")
  })

  for (const machine of ["m4", "m2"]) {
    test(`routes origin and gh probe/list/view to workspace machine ${machine}`, async () => {
      const calls = []
      const { panel, cx } = await view({
        spaces: [
          {
            id: `${machine}/space`,
            active: true,
            machine,
            folder: "/old-folder",
            tabs: [{ id: `${machine}/tab` }],
          },
        ],
        panes: [{ tab: `${machine}/tab`, cwd: "/live repo" }],
        exec: async (command, args, options) => {
          calls.push({ command, args, options })
          if (command === "git")
            return { code: 0, stdout: "git@github.com:cli/cli.git", stderr: "" }
          return args.includes("view") ? ok({ ...item(1), body: machine }) : ok([item(1)])
        },
      })
      panel.pick(item(1), cx)
      await tick()
      expect(calls[0].options).toEqual({ cwd: "/live repo", on: machine, timeout: 10000 })
      expect(calls.map((call) => call.command)).toEqual(["git", "gh", "gh", "gh"])
      expect(calls.slice(1).map((call) => call.args.slice(0, 2))).toEqual([
        ["--version"],
        ["issue", "list"],
        ["issue", "view"],
      ])
      for (const call of calls.slice(1)) {
        expect(call.options.on).toBe(machine)
        expect(call.options.cwd).toBeUndefined()
      }
      expect(panel.repository).toBe("cli/cli")
      expect(panel.queryMachine).toBe(machine)
      expect(panel.client).toBe(panel.clientFor(machine))
      expect(panel.items.length).toBe(1)
      expect(panel.detail?.body).toBe(machine)
      expect(panel.loading).toBe(false)
      expect(renderText(panel, cx)).toContain(`gh on ${machine}`)
      expect(uiElements.get("github-repo").node.props.tooltip).toContain(
        `GitHub CLI: gh on ${machine}`,
      )
    })
    test(`reports ${machine} auth and missing-CLI errors without local fallback`, async () => {
      for (const missing of [true, false]) {
        const calls = []
        const { panel, cx } = await view()
        panel.platform = "windows"
        spaceList = [{ active: true, machine, folder: "/repo", tabs: [] }]
        hostExec = async (command, args, options) => {
          calls.push({ command, args, options })
          if (command === "git") return { code: 0, stdout: "git@github.com:owner/repo.git" }
          if (missing) throw new Error("not found")
          return args.includes("--version") ? ok("") : fail("Run gh auth login")
        }
        panel.refresh(cx)
        await tick()
        expect(panel.loading).toBe(false)
        expect(panel.error).toContain(missing ? "Install gh" : "gh auth login")
        expect(panel.error).toContain(machine)
        expect(panel.items).toEqual([])
        expect(calls.map((call) => call.command)).toEqual(
          missing ? ["git", "gh"] : ["git", "gh", "gh"],
        )
        expect(calls.every((call) => call.options.on === machine)).toBe(true)
      }
    })
  }
  test("switching from m4 to m2 does not reuse an unfinished CLI probe", async () => {
    const { panel, cx } = await view()
    const oldProbe = deferred()
    let probes = 0
    spaceList = [{ active: true, machine: "m4", folder: "/m4-repo", tabs: [] }]
    hostExec = async (command, args, options) => {
      if (command === "git") return { code: 0, stdout: `git@github.com:owner/${options.on}.git` }
      if (args.includes("--version")) return ++probes === 1 ? oldProbe.promise : ok("")
      return ok([item(args.includes("owner/m2") ? 2 : 1)])
    }
    panel.refresh(cx)
    await tick()
    expect(panel.phase).toBe("Finding GitHub CLI on m4 with gh…")
    spaceList = [{ active: true, machine: "m2", folder: "/m2-repo", tabs: [] }]
    panel.render(cx)
    await tick()
    expect(probes).toBe(2)
    expect(panel.client.machine).toBe("m2")
    expect(panel.repository).toBe("owner/m2")
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.loading).toBe(false)
    oldProbe.resolve(ok(""))
    await tick()
    expect(panel.repository).toBe("owner/m2")
    expect(panel.items.map((row) => row.number)).toEqual([2])
  })
  test("caches distinct clients by exact machine or null", async () => {
    const { panel } = await view()
    const local = panel.clientFor(null)
    const m4 = panel.clientFor("m4")
    const m2 = panel.clientFor("m2")
    expect(panel.clients.size).toBe(3)
    expect(local.machine).toBeNull()
    expect(m4.machine).toBe("m4")
    expect(m2.machine).toBe("m2")
    expect(panel.clientFor(null)).toBe(local)
    expect(panel.clientFor("m4")).toBe(m4)
    expect(panel.clientFor("m2")).toBe(m2)
    expect(m4).not.toBe(local)
    expect(m4).not.toBe(m2)
    expect(panel.client).toBe(local)
  })
  test("an explicit read uses its captured machine instead of the displayed client", async () => {
    const calls = []
    const { panel, cx } = await view({
      exec: async (command, args, options) => {
        calls.push({ command, args, options })
        return ok([item(1)])
      },
    })
    panel.queryMachine = "m2"
    panel.client = panel.clientFor("m2")
    const displayed = panel.client
    expect(await panel.read(listArgs("owner/repo", "issue", "open"), cx, () => true, "m4")).toEqual(
      [item(1)],
    )
    expect(calls.map((call) => call.options.on)).toEqual(["m4", "m4"])
    expect(panel.phase).toBe("Loading from GitHub with gh on m4…")
    expect(panel.client).toBe(displayed)
    expect(panel.client.machine).toBe("m2")
  })
  test("a same-repository machine switch clears old data before lookup and fetches fresh results", async () => {
    const origin = deferred()
    const calls = []
    const { panel, cx } = await view({
      spaces: [{ id: "m4/space", active: true, machine: "m4", folder: "/repo", tabs: [] }],
      exec: async (command, args, options) => {
        calls.push({ command, args, options })
        if (command === "git")
          return options.on === "m2"
            ? origin.promise
            : { code: 0, stdout: "git@github.com:owner/shared.git" }
        if (args.includes("--version")) return ok("")
        return args.includes("view")
          ? ok({ ...item(1), body: "m4 detail" })
          : ok([item(options.on === "m2" ? 2 : 1)])
      },
    })
    panel.pick(item(1), cx)
    await tick()
    const rows = panel.items
    const key = panel.resultKey
    expect(panel.detail?.body).toBe("m4 detail")
    spaceList = [{ id: "m2/space", active: true, machine: "m2", folder: "/repo", tabs: [] }]
    panel.refresh(cx, false, true)
    expect(panel.repository).toBe("")
    expect(panel.items).toEqual([])
    expect(panel.selected).toBeNull()
    expect(panel.detail).toBeNull()
    expect(panel.detailPending).toBe(false)
    expect(panel.resultKey).toBeNull()
    expect(panel.queryMachine).toBe("m2")
    expect(panel.client.machine).toBe("m2")
    await tick()
    expect(panel.phase).toContain("m2")
    origin.resolve({ code: 0, stdout: "git@github.com:owner/shared.git" })
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.resultKey).not.toBe(key)
    expect(JSON.parse(panel.resultKey)).toEqual(["m2", "owner/shared", "issue", "open", ""])
    expect(panel.detail).toBeNull()
    spaceList = [{ id: "m4/space", active: true, machine: "m4", folder: "/repo", tabs: [] }]
    panel.render(cx)
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([1])
    expect(panel.items).not.toBe(rows)
    expect(panel.clients.size).toBe(2)
    for (const machine of ["m4", "m2"]) {
      expect(
        calls.filter(
          (call) =>
            call.command === "gh" && call.args.includes("--version") && call.options.on === machine,
        ).length,
      ).toBe(1)
      expect(
        calls.filter(
          (call) =>
            call.command === "gh" && call.args.includes("list") && call.options.on === machine,
        ).length,
      ).toBe(machine === "m4" ? 2 : 1)
    }
  })
  test("late list and detail responses from m4 cannot replace the same repo on m2", async () => {
    const oldList = deferred()
    const oldDetail = deferred()
    let m4Lists = 0
    const { panel, cx } = await view({
      spaces: [{ id: "m4/space", active: true, machine: "m4", folder: "/repo", tabs: [] }],
      exec: async (command, args, options) => {
        if (command === "git") return { code: 0, stdout: "git@github.com:owner/shared.git" }
        if (args.includes("--version")) return ok("")
        if (args.includes("view"))
          return options.on === "m4" ? oldDetail.promise : ok({ ...item(2), body: "m2 detail" })
        if (options.on === "m4" && ++m4Lists === 2) return oldList.promise
        return ok([item(options.on === "m2" ? 2 : 1)])
      },
    })
    panel.refresh(cx, false)
    panel.pick(item(1), cx)
    await tick()
    expect(panel.detailPending).toBe(true)
    spaceList = [{ id: "m2/space", active: true, machine: "m2", folder: "/repo", tabs: [] }]
    panel.render(cx)
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.selected).toBeNull()
    expect(panel.detailPending).toBe(false)
    panel.pick(item(2), cx)
    await tick()
    expect(panel.detail?.body).toBe("m2 detail")
    const key = panel.resultKey
    oldList.resolve(ok([item(99)]))
    oldDetail.resolve(ok({ ...item(1), body: "stale m4 detail" }))
    await tick()
    expect(panel.repository).toBe("owner/shared")
    expect(panel.queryMachine).toBe("m2")
    expect(panel.client.machine).toBe("m2")
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.selected?.number).toBe(2)
    expect(panel.detail?.body).toBe("m2 detail")
    expect(panel.resultKey).toBe(key)
    expect(panel.loading).toBe(false)
    expect(panel.detailPending).toBe(false)
    expect(panel.error).toBe("")
    expect(panel.detailError).toBe("")
  })
  test("a locally pinned repository stays local after a remote workspace becomes active", async () => {
    const calls = []
    const { panel, cx } = await view({
      props: { repo: "owner/pinned" },
      spaces: [{ id: "local/space", active: true, machine: null, folder: "/repo", tabs: [] }],
      exec: async (command, args, options) => {
        calls.push({ command, args, options })
        return ok([])
      },
    })
    const context = panel.context()
    spaceList = [{ id: "m4/space", active: true, machine: "m4", folder: "/repo", tabs: [] }]
    panel.refresh(cx, false)
    await tick()
    expect(panel.context()).toBe(context)
    expect(panel.pinnedMachine).toBeNull()
    expect(panel.queryMachine).toBeNull()
    expect(panel.client.machine).toBeNull()
    expect(calls.map((call) => call.command)).toEqual(["gh", "gh", "gh"])
    expect(calls.every((call) => call.options.on === null)).toBe(true)
  })
  test("remote origin timeout ends Loading and ignores a late result", async () => {
    const { panel, cx, timers } = await view()
    const pending = deferred()
    spaceList = [{ active: true, machine: "m4", folder: "/repo", tabs: [] }]
    hostExec = () => pending.promise
    panel.refresh(cx)
    await tick()
    expect(panel.phase).toContain("m4")
    expect(timers[0].ms).toBe(12000)
    timers[0].fire()
    await tick()
    expect(panel.loading).toBe(false)
    expect(panel.error).toContain("git timed out on m4")
    pending.resolve({ code: 0, stdout: "git@github.com:cli/cli.git" })
    await tick()
    expect(panel.repository).toBe("")
    expect(panel.items).toEqual([])
  })
  test("CLI discovery timeout can recover on the next explicit refresh", async () => {
    const { panel, cx, timers } = await view()
    const pending = deferred()
    panel.pinned = true
    panel.repository = "cli/cli"
    hostExec = () => pending.promise
    panel.clients.set(panel.queryMachine, createGitHub(hostExec, "linux"))
    panel.refresh(cx)
    await tick()
    expect(panel.phase).toContain("Finding GitHub CLI")
    timers[0].fire()
    await tick()
    expect(panel.loading).toBe(false)
    expect(panel.error).toContain("timed out")
    hostExec = async (_command, args) => (args.includes("--version") ? ok("") : ok([item(2)]))
    panel.refresh(cx)
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.loading).toBe(false)
    pending.resolve(ok(""))
    await tick()
    expect(panel.items.map((row) => row.number)).toEqual([2])
  })
  test("query timeout clears Loading without changing accounts", async () => {
    const { panel, cx, timers } = await view()
    const pending = deferred()
    const calls = []
    panel.pinned = true
    panel.repository = "cli/cli"
    hostExec = async (command, args) => {
      calls.push(command)
      return args.includes("--version") ? ok("") : pending.promise
    }
    panel.clients.set(panel.queryMachine, createGitHub(hostExec, "windows"))
    panel.refresh(cx)
    await tick()
    const query = timers.find((timer) => timer.ms === 47000)
    expect(query).toBeDefined()
    query.fire()
    await tick()
    expect(panel.loading).toBe(false)
    expect(panel.error).toContain("gh timed out")
    expect(calls).toEqual(["gh", "gh"])
    pending.resolve(ok([item(1)]))
    await tick()
    expect(panel.items).toEqual([])
  })
  test("publishes the detected repository before a slow GitHub query finishes", async () => {
    const { panel, cx } = await view()
    const pending = deferred()
    spaceList = [{ active: true, machine: "mini", folder: "/repo", tabs: [] }]
    hostExec = async () => ({ code: 0, stdout: "git@github.com:cli/cli.git" })
    panel.clients.set("mini", { transport: "gh", read: () => pending.promise })
    panel.refresh(cx)
    await tick()
    expect(panel.repository).toBe("cli/cli")
    expect(panel.phase).toBe("Loading from GitHub with gh on mini…")
    expect(panel.loading).toBe(true)
    pending.resolve([])
    await tick()
    expect(panel.loading).toBe(false)
  })
  test("renders missing-workspace, populated list, issue and PR previews, and errors", async () => {
    const { panel, cx } = await view()
    expect(panel.notice).toContain("No terminal folder")
    expect(panel.error).toBe("")
    expect(() => panel.render(cx)).not.toThrow()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.loadedContext = panel.context()
    panel.error = ""
    panel.items = [item(1)]
    expect(() => panel.render(cx)).not.toThrow()
    panel.selected = item(1)
    panel.detail = { ...item(1), body: "# Description", labels: [{ name: "bug" }] }
    expect(() => panel.render(cx)).not.toThrow()
    panel.kind = "pr"
    panel.detail = {
      ...panel.detail,
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
      headRefName: "fix",
      baseRefName: "main",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
    }
    expect(() => panel.render(cx)).not.toThrow()
    panel.detail = null
    panel.detailError = "Network unavailable"
    expect(() => panel.render(cx)).not.toThrow()
  })
  test("ignores an old repository response after a new request finishes", async () => {
    const { panel, cx } = await view()
    const first = deferred()
    const second = deferred()
    panel.clients.set(panel.queryMachine, {
      read: (args) => (args.includes("owner/one") ? first.promise : second.promise),
    })
    panel.pinned = true
    panel.repository = "owner/one"
    panel.refresh(cx)
    await tick()
    panel.repository = "owner/two"
    panel.refresh(cx)
    await tick()
    second.resolve([item(2)])
    await tick()
    first.resolve([item(1)])
    await tick()
    expect(panel.repository).toBe("owner/two")
    expect(panel.items.map((row) => row.number)).toEqual([2])
    expect(panel.loading).toBe(false)
  })
  test("ignores an old preview and does not reopen after Back", async () => {
    const { panel, cx } = await view()
    const first = deferred()
    const second = deferred()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.clients.set(panel.queryMachine, {
      read: (args) => (args[2] === "1" ? first.promise : second.promise),
    })
    panel.pick(item(1), cx)
    await tick()
    panel.pick(item(2), cx)
    await tick()
    first.resolve({ ...item(1), body: "old" })
    await tick()
    expect(panel.detail).toBeNull()
    panel.back(cx)
    second.resolve({ ...item(2), body: "new" })
    await tick()
    expect(panel.selected).toBeNull()
    expect(panel.detail).toBeNull()
  })
  test("retains results after a background failure, and clears them for new filters", async () => {
    const { panel, cx } = await view()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.loadedContext = panel.context()
    panel.items = [item(1)]
    panel.clients.set(panel.queryMachine, {
      read: async () => {
        throw new Error("Network unavailable")
      },
    })
    panel.refresh(cx, false)
    await tick()
    expect(panel.items.length).toBe(1)
    expect(panel.error).toContain("Network unavailable")
    panel.state = "closed"
    panel.refresh(cx)
    await tick()
    expect(panel.items).toEqual([])
  })
  test("keeps a loaded description visible while refreshing it in the background", async () => {
    const { panel, cx } = await view()
    const preview = deferred()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.loadedContext = panel.context()
    panel.items = [item(1)]
    panel.selected = item(1)
    panel.detail = { ...item(1), body: "Description being read" }
    panel.clients.set(panel.queryMachine, {
      read: (args) => (args[1] === "view" ? preview.promise : Promise.resolve([item(1)])),
    })
    panel.refresh(cx, false)
    await tick()
    expect(panel.detail?.body).toBe("Description being read")
    preview.resolve({ ...item(1), body: "Updated description" })
    await tick()
    expect(panel.detail?.body).toBe("Updated description")
  })
  test("a failed background refresh does not leave an in-flight preview loading forever", async () => {
    const { panel, cx } = await view()
    const preview = deferred()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.loadedContext = panel.context()
    panel.items = [item(1)]
    panel.clients.set(panel.queryMachine, {
      read: (args) =>
        args[1] === "view" ? preview.promise : Promise.reject(new Error("Network unavailable")),
    })
    panel.pick(item(1), cx)
    await tick()
    panel.refresh(cx, false)
    await tick()
    preview.resolve({ ...item(1), body: "Loaded description" })
    await tick()
    expect(panel.detail?.body).toBe("Loaded description")
    expect(panel.error).toContain("Network unavailable")
  })
  test("discarded list requests cannot replace results after a workspace change", async () => {
    const { panel, cx } = await view()
    const pending = deferred()
    panel.pinned = true
    panel.repository = "cli/cli"
    panel.clients.set(panel.queryMachine, { read: () => pending.promise })
    panel.refresh(cx)
    await tick()
    panel.pinned = false
    panel.repository = ""
    panel.refresh(cx)
    await tick()
    pending.resolve([item(1)])
    await tick()
    expect(panel.items).toEqual([])
    expect(panel.repository).toBe("")
    expect(panel.loading).toBe(false)
  })
})
