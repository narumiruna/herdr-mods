import { h_flex, v_flex } from "gpui-base"
import { div, svg } from "gpui-kit"
import { layout, run, theme, updates } from "herdr"

/** @import { Color, NativeElement } from "gpui-kit" */
/** @typedef {{id?: string, size?: {px?: number}, children?: LayoutNode[]}} LayoutNode */

/** @param {LayoutNode | undefined} node @returns {LayoutNode | undefined} */
function findSidebar(node) {
  if (node?.id === "sidebar") return node
  for (const child of node?.children ?? []) {
    const found = findSidebar(child)
    if (found) return found
  }
}

/** @returns {NativeElement} */
export function renderSidebarFooter() {
  const t = /** @type {Record<string, Color>} */ (theme())
  // Width also detects a sidebar narrowed by dragging, without a shared flag.
  const collapsed = (findSidebar(/** @type {LayoutNode} */ (layout()))?.size?.px ?? Infinity) < 160
  /**
   * @param {string} id
   * @param {string} icon
   * @param {string} label
   * @param {boolean} dim
   * @param {() => void} action
   */
  const row = (id, icon, label, dim, action) =>
    h_flex()
      .id(id)
      .h(28)
      .px(8)
      .gap(9)
      .items_center()
      .rounded(8)
      .when(collapsed, (el) => el.relative().w(32).px(0).justify_center().tooltip(label))
      .text_color(dim ? t.dim : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer()
      .on_click(action)
      // Use shipped assets so external development links also work.
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14))
      .when(!collapsed, (el) => el.child(label))
  const ready = div().id("app-update-ready").size(6).rounded_full().bg(t.accent)
  return v_flex()
    .id("mod-manager-footer")
    .size_full()
    .bg(t.chrome)
    .border_t_1()
    .border_color(t.border)
    .px(8)
    .pt(4)
    .pb(8)
    .text_size(13)
    .when(collapsed, (el) => el.px(0).items_center())
    .child(row("mods", "layers", "Mods", false, () => run("mod.open", { name: "mod-manager" })))
    .child(
      row("layout-manager", "panel-right", "Layout Manager", false, () =>
        run("mod.open", { name: "layout-manager" }),
      ),
    )
    .child(
      row("settings", "settings", "Settings", false, () => run("app.settings")).when(
        Boolean(updates().app.ready),
        (el) => el.child(collapsed ? ready.absolute().top(5).right(6) : ready),
      ),
    )
    .child(
      row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })),
    )
}
