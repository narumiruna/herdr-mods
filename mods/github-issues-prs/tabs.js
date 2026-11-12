import { Button, h_flex } from "gpui-base"
import { div, image, svg } from "gpui-kit"
import { layout, openOverlay, panes, run, settings, shared, spaces, theme, window } from "herdr"

function find(node, id) {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = find(child, id)
    if (found) return found
  }
  return null
}

// Per-view tab-bar state. The mod entry owns this controller, not a nested View.
export class TabBar {
  constructor() {
    this.pressed = null
    this.panels = Object.create(null)
    try {
      const panels = JSON.parse(localStorage.getItem("panels") ?? "{}")
      if (panels && typeof panels === "object" && !Array.isArray(panels))
        Object.assign(this.panels, panels)
    } catch {
      // Ignore invalid saved preferences so the tab bar can still start.
    }
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return
    const now = panel.hidden ? null : (body?.active ?? null)
    if (space.id !== this.space) {
      const first = this.space === undefined
      this.space = space.id
      this.pending = null
      if (!(first && !Object.hasOwn(this.panels, space.id))) {
        const stored = this.panels[space.id] ?? null
        const want = enabled.includes(stored) ? stored : null
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 }
          if (want) {
            run("layout.select", { stack: "panel-body", child: want })
            run("layout.show", { id: "panel" })
          } else run("layout.hide", { id: "panel" })
          return
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return
      this.pending = null
    }
    if (this.panels[space.id] === now) return
    this.panels[space.id] = now
    try {
      localStorage.setItem("panels", JSON.stringify(this.panels))
    } catch {
      // A storage failure must not stop terminal tabs. Keep this session's choice.
    }
  }

  render() {
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme())
    const space = spaces().find((p) => p.active)
    const shown = space?.tabs ?? []
    const stop = (_e, cx) => cx.stop_propagation()
    const button = (id, label, action) =>
      Button.new(id)
        .tab_stop(true)
        .accessibility_label(id === "tab-new" ? "New tab" : id.replaceAll("-", " "))
        .tooltip(id === "tab-new" ? "New tab" : id.replaceAll("-", " "))
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .focus((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label)
    const item = (c) => {
      const program =
        panes().find((p) => p.tab === c.id && p.program?.agent)?.program ??
        panes().find((p) => p.tab === c.id)?.program
      const name = /^tb\d+$/.test(c.name) ? (program?.name ?? "Terminal") : c.name
      return h_flex()
        .id(`tab-${c.id}`)
        .role("tab")
        .selected(Boolean(c.active))
        .accessibility_label(name)
        .tab_stop(true)
        .on_key_down((event, cx) => {
          if (Object.values(event.modifiers ?? {}).some(Boolean)) return
          if (event.key !== "enter" && event.key !== "space") return
          run("tab.select", { id: c.id })
          cx.stop_propagation()
        })
        .h(29)
        .px(10)
        .gap(7)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.8)
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .focus((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation()
          this.pressed = { id: c.id, space: space.id }
          if (e.click_count === 2) run("tab.rename", { id: c.id })
        })
        .on_mouse_up("left", () => {
          const from = this.pressed
          this.pressed = null
          if (
            from &&
            from.space === space.id &&
            from.id !== c.id &&
            shown.some((tab) => tab.id === from.id)
          )
            run("tab.move", {
              id: from.id,
              index: space.tabs.findIndex((x) => x.id === c.id) + 1,
            })
          else run("tab.select", { id: c.id })
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation()
          openOverlay({
            mod: "menu",
            kind: "popup",
            width: 200,
            props: { tab: "tab", target: { id: c.id, space: space.id } },
          })
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).text_color(t.muted)
              : image(program.icon).size(14),
          ),
        )
        .child(
          div()
            .max_w(170)
            .truncate()
            .child(c.zoomed ? `${name} Z` : name),
        )
        .when(c.status === "working", (el) =>
          el.child(
            svg("mods/github-issues-prs/icons/refresh.svg")
              .size(12)
              .flex_none()
              .text_color(t.working)
              .spin(900),
          ),
        )
        .when(c.status === "blocked" || c.status === "done", (el) =>
          el.child(div().size(6).rounded(3).bg(t[c.status])),
        )
        .when(c.active, (el) =>
          el.child(
            Button.new(`close-${c.id}`)
              .tab_stop(true)
              .accessibility_label(`Close ${name}`)
              .tooltip(`Close ${name}`)
              .text_color(t.dim)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation()
                run("tab.close", { id: c.id })
              })
              .child(svg("mods/github-issues-prs/icons/win-close.svg").size(12)),
          ),
        )
    }
    const root = /** @type {{traffic_lights?: number[]}} */ (layout())
    const sidebar = find(root, "sidebar")
    const w = window()
    const zoom = Number(settings().zoom) || 1
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
        ? Math.max(
            10,
            (root.traffic_lights[0] + 64) / zoom - (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0)),
          )
        : 10
    const panel = find(root, "panel")
    const body = find(root, "panel-body")
    const preference = shared("workspace.panels")
    const enabled = [
      ...(Array.isArray(preference) ? preference : ["files", "changes"]),
      "github",
    ].filter((id) => body?.children?.some((child) => child.id === id))
    this.syncPanel(space, panel, body, enabled)
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id
      return Button.new(`panel-${id}`)
        .tab_stop(true)
        .accessibility_label(label)
        .selected(Boolean(on))
        .flex()
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .focus((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" })
          else {
            run("layout.select", { stack: "panel-body", child: id })
            run("layout.show", { id: "panel" })
          }
        })
        .child(svg(icon).size(14))
        .child(label)
    }
    return h_flex()
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .on_mouse_up("left", () => {
        this.pressed = null
      })
      .child(
        h_flex()
          .id("tab-scroll")
          .role("tab_list")
          .accessibility_label("Workspace tabs")
          .on_scroll_wheel((e) => {
            if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next")
          })
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_x_scrollbar()
          .children(shown.map(item)),
      )
      .child(
        button("tab-new", "+", () =>
          openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }),
        ),
      )
      .when(enabled.includes("files"), (el) =>
        el.child(panelButton("files", "Files", "mods/github-issues-prs/icons/files.svg")),
      )
      .when(enabled.includes("changes"), (el) =>
        el.child(panelButton("changes", "Changes", "mods/github-issues-prs/icons/changes.svg")),
      )
      .when(enabled.includes("github"), (el) =>
        el.child(
          panelButton("github", "GitHub Issues & PRs", "mods/github-issues-prs/icons/github.svg"),
        ),
      )
      .when(w?.buttons, (el) =>
        el
          .child(
            button(
              "minimize",
              w.platform === "windows"
                ? svg("mods/github-issues-prs/icons/win-min.svg").size(16)
                : "−",
              () => run("window.minimize"),
            ),
          )
          .child(
            button(
              "maximize",
              w.platform === "windows"
                ? svg(
                    `mods/github-issues-prs/icons/${w.maximized ? "win-restore" : "win-max"}.svg`,
                  ).size(16)
                : "□",
              () => run("window.maximize"),
            ),
          )
          .child(
            button(
              "close-window",
              w.platform === "windows"
                ? svg("mods/github-issues-prs/icons/win-close.svg").size(16)
                : svg("mods/github-issues-prs/icons/win-close.svg").size(13),
              () => run("window.close"),
            ),
          ),
      )
  }
}
