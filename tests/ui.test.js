import { describe, expect, test, vi } from "vitest"

// Keep native layout checks separate. This adapter exercises the actual view's
// event handlers and rendered state without opening a window or using the host.
const native = vi.hoisted(() => {
  function element(type, id) {
    const node = { type, nodes: [], attributes: { id }, click: null }
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key]
        if (key === "then" || typeof key !== "string") return undefined
        if (key === "child") {
          return (child) => {
            target.nodes.push(child)
            return proxy
          }
        }
        if (key === "children") {
          return (children) => {
            target.nodes.push(...children)
            return proxy
          }
        }
        if (key === "when") return (condition, branch) => (condition ? branch(proxy) : proxy)
        if (key === "on_click") {
          return (handler) => {
            target.click = handler
            return proxy
          }
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

  return { element, input, closeOverlay: vi.fn(), openUrl: vi.fn() }
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
  props: () => ({ overlay: "preview-overlay" }),
  theme: () => ({}),
}))

import ModManager from "../main.js"

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

function setup() {
  const tasks = []
  const cx = {
    notify: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    open_url: native.openUrl,
    spawn(body) {
      tasks.push(body(cx))
    },
  }
  const view = new ModManager()
  view.init()
  return { view, cx, flush: () => Promise.all(tasks) }
}

function search(view, section, value, cx) {
  const node = descendants(view.render()).find((node) => node.type === "input")
  const input = node.attributes.state
  expect(input).toBe(view.searches[section])
  input.set_value(value)
  input.handlers.change({}, cx)
}

describe("preview view", () => {
  test("opens a searchable Gallery with actions for every sample state", () => {
    const { view } = setup()
    expect(view.section).toBe("gallery")
    expect(contents(view.render())).toContain("SAMPLE LIBRARY")
    expect(contents(find(view, "mod-focus-mode"))).toContain("Installed · Enabled")
    expect(find(view, "action-disable-focus-mode")).toBeDefined()
    expect(contents(find(view, "mod-workspace-notes"))).toContain("Installed · Disabled")
    expect(find(view, "action-enable-workspace-notes")).toBeDefined()
    expect(contents(find(view, "mod-terminal-tools"))).toContain("Not installed")
    expect(find(view, "action-install-terminal-tools")).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("3")
    expect(find(view, "mod-mod-manager")).toBeUndefined()
  })

  test("searches independently on both pages and retains Installed source filters", () => {
    const { view, cx } = setup()
    const input = () => descendants(view.render()).find((node) => node.type === "input")
    expect(input().attributes.state).toBe(view.searches.gallery)
    search(view, "gallery", "CONTEXT", cx)
    expect(find(view, "mod-workspace-notes")).toBeDefined()
    expect(find(view, "mod-focus-mode")).toBeUndefined()
    click(view, "nav-installed", cx)
    expect(input().attributes.state).toBe(view.searches.installed)
    click(view, "filter-development", cx)
    expect(find(view, "mod-mod-manager")).toBeDefined()
    expect(find(view, "mod-workspace-notes")).toBeUndefined()
    search(view, "installed", "nothing matches", cx)
    expect(contents(view.render())).toContain("No matching mods")
    click(view, "nav-gallery", cx)
    expect(find(view, "mod-workspace-notes")).toBeDefined()
    expect(view.queries.installed).toBe("nothing matches")
    search(view, "gallery", "", cx)
    expect(find(view, "mod-terminal-tools")).toBeDefined()
  })

  test("installs, disables, and enables through the rendered controls on either page", async () => {
    const { view, cx, flush } = setup()
    click(view, "action-install-terminal-tools", cx)
    expect(contents(view.render())).toContain("Simulating installation")
    expect(find(view, "action-install-terminal-tools").attributes.disabled).toBe(true)
    expect(find(view, "action-disable-focus-mode").attributes.disabled).toBe(true)
    expect(contents(find(view, "nav-installed"))).toContain("3")
    click(view, "nav-installed", cx)
    expect(find(view, "mod-terminal-tools")).toBeUndefined()
    await flush()
    expect(find(view, "action-disable-terminal-tools")).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("4")
    expect(contents(view.render())).toContain("Simulated: Terminal Tools installed")
    click(view, "action-disable-terminal-tools", cx)
    await flush()
    click(view, "nav-gallery", cx)
    expect(find(view, "action-enable-terminal-tools")).toBeDefined()
    click(view, "action-enable-terminal-tools", cx)
    await flush()
    click(view, "nav-installed", cx)
    expect(contents(find(view, "mod-terminal-tools"))).toContain("Installed · Enabled")
  })

  test("clears a stale-handler rejection when the pending operation succeeds", async () => {
    const { view, cx, flush } = setup()
    click(view, "action-install-terminal-tools", cx)
    view.act("install", "terminal-tools", cx)
    expect(view.noticeError).toBe(true)
    expect(view.notice).toContain("in progress")
    await flush()
    expect(view.notice).toContain("Simulated: Terminal Tools installed")
    expect(view.noticeError).toBe(false)
    expect(view.session.list("installed")).toHaveLength(4)
  })

  test("requires confirmation, supports cancel, and restores Install after uninstall", async () => {
    const { view, cx, flush } = setup()
    click(view, "action-uninstall-focus-mode", cx)
    expect(find(view, "uninstall-confirmation")).toBeDefined()
    expect(contents(view.render())).toContain("Uninstall Focus Mode?")
    expect(contents(view.render())).toContain("Sample path: /preview/mods/focus-mode")
    expect(contents(view.render())).toContain("No files will be removed")
    expect(find(view, "nav-installed").attributes.disabled).toBe(true)
    expect(find(view, "action-disable-focus-mode")).toBeUndefined()
    click(view, "cancel-uninstall", cx)
    expect(find(view, "action-disable-focus-mode")).toBeDefined()
    click(view, "action-uninstall-focus-mode", cx)
    click(view, "confirm-uninstall", cx)
    await flush()
    expect(find(view, "action-install-focus-mode")).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("2")
    click(view, "nav-installed", cx)
    expect(find(view, "mod-focus-mode")).toBeUndefined()
  })

  test("shows protected action reasons and does not allow the running manager to change", () => {
    const { view, cx } = setup()
    click(view, "nav-installed", cx)
    const card = find(view, "mod-mod-manager")
    expect(contents(card)).toContain("protected development link")
    for (const action of ["disable", "uninstall"]) {
      const node = find(view, `action-${action}-mod-manager`)
      expect(node.attributes.disabled).toBe(true)
      expect(node.attributes.tooltip).toContain("protected development link")
    }
    // A stale or programmatic handler must still fail the model's safety check.
    view.act("disable", "mod-manager", cx)
    expect(view.noticeError).toBe(true)
    expect(view.session.mod("mod-manager").state).toBe("enabled")
  })

  test("validates GitHub input, simulates installation, and prevents duplicates", async () => {
    const { view, cx, flush } = setup()
    click(view, "nav-github", cx)
    const input = descendants(view.render()).find((node) => node.type === "input")
    expect(input.attributes.state).toBe(view.repository)
    view.repository.set_value("not a URL")
    click(view, "preview-install", cx)
    expect(view.noticeError).toBe(true)
    expect(contents(view.render())).toContain("Enter a GitHub repository URL")
    expect(view.session.pending).toBeNull()
    view.repository.set_value("https://github.com/Example/Terminal-Tools.git/")
    click(view, "preview-install", cx)
    expect(find(view, "preview-install").attributes.disabled).toBe(true)
    await flush()
    click(view, "view-installed", cx)
    expect(find(view, "mod-terminal-tools")).toBeDefined()
    expect(contents(find(view, "nav-installed"))).toContain("4")
    click(view, "nav-gallery", cx)
    expect(find(view, "action-disable-terminal-tools")).toBeDefined()
    click(view, "nav-github", cx)
    click(view, "preview-install", cx)
    expect(view.noticeError).toBe(true)
    expect(view.session.list("installed")).toHaveLength(4)
  })

  test("shows new GitHub samples in Installed without inventing Gallery entries", async () => {
    const { view, cx, flush } = setup()
    click(view, "nav-github", cx)
    view.repository.set_value("https://github.com/owner/new-mod")
    click(view, "preview-install", cx)
    await flush()
    click(view, "view-installed", cx)
    expect(contents(view.render())).toContain("owner/new-mod")
    expect(contents(view.render())).not.toContain("vundefined")
    click(view, "nav-gallery", cx)
    expect(contents(view.render())).not.toContain("owner/new-mod")
  })

  test("shows asynchronous failures without committing partial installation and permits retry", async () => {
    const { view, cx, flush } = setup()
    cx.sleep.mockRejectedValueOnce(new Error("Sample operation interrupted"))
    click(view, "action-install-terminal-tools", cx)
    await flush()
    expect(contents(view.render())).toContain("Sample operation interrupted")
    expect(view.noticeError).toBe(true)
    expect(view.session.pending).toBeNull()
    expect(view.session.mod("terminal-tools").state).toBe("available")
    expect(find(view, "action-install-terminal-tools").attributes.disabled).toBe(false)
    click(view, "action-install-terminal-tools", cx)
    await flush()
    expect(view.noticeError).toBe(false)
    expect(view.session.mod("terminal-tools").state).toBe("enabled")
  })

  test("fresh view instances reset sample state without affecting another open instance", async () => {
    const first = setup()
    click(first.view, "action-install-terminal-tools", first.cx)
    await first.flush()
    const second = setup()
    expect(second.view.session.mod("terminal-tools").state).toBe("available")
    expect(first.view.session.mod("terminal-tools").state).toBe("enabled")
  })

  test("opens the website only on request and closes only its own overlay", () => {
    native.openUrl.mockClear()
    native.closeOverlay.mockClear()
    const { view, cx } = setup()
    expect(native.openUrl).not.toHaveBeenCalled()
    click(view, "open-gallery", cx)
    expect(native.openUrl).toHaveBeenCalledWith("https://herdr.dev/gallery/?type=mods")
    click(view, "close-manager", cx)
    expect(native.closeOverlay).toHaveBeenCalledWith("preview-overlay")
  })
})
