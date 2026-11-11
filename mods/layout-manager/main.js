// biome-ignore lint/style/useNodejsImportProtocol: Herdr exposes fs/promises, not Node.js APIs.
import * as fs from "fs/promises"
import { Button, h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base"
import { div, View } from "gpui-kit"
import {
  appHome,
  closeOverlay,
  layout,
  openOverlay,
  props,
  readTextFile,
  run,
  shared,
  theme,
  writeTextFile,
} from "herdr"
import {
  addPanel,
  DOCK_ID,
  findNode,
  MOD_NAME,
  managedSlots,
  parseProps,
  references,
  removePanel,
  STACK_ID,
  validName,
} from "./model.js"
import { discoverMods, includeMissing, overlaySpec, readSnapshot, saveSnapshot } from "./runtime.js"

const stop = (_event, cx) => cx.stop_propagation()
const message = (error) => String(error?.message ?? error)
const colors = () => /** @type {Record<string, import("gpui-kit").Color>} */ (theme())
const label = (text, size = 12, color = colors().foreground) =>
  div().text_size(size).text_color(color).child(text)

export default class LayoutManager extends View {
  createIO() {
    return {
      home: appHome(),
      readText: readTextFile,
      writeText: writeTextFile,
      list: (path) => fs.readdir(path),
      exists: (path) => fs.exists(path),
      currentName: () => shared("layout"),
    }
  }

  currentTree() {
    return layout()
  }

  init(initialProps, cx) {
    this.entry = initialProps ?? props() ?? {}
    if (this.entry.mode === "dock") return
    this.io = this.createIO()
    this.mods = []
    this.snapshot = null
    this.selected = null
    this.loadedName = null
    this.query = ""
    this.loading = false
    this.busy = false
    this.closed = false
    this.error = ""
    this.notice = ""
    this.request = 0
    this.limit = 100
    this.drafts = new Map()
    this.needsRefresh = false
    this.search = InputState.new({ placeholder: "Search installed mods…" })
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value()
      this.limit = 100
      cx.notify()
    })
    this.properties = TextareaState.new({ value: "{}", rows: 6 })
    this.cloneName = InputState.new({ placeholder: "Personal layout name" })
    this.refresh(cx)
  }

  close() {
    this.closed = true
    this.search?.release()
    this.properties?.release()
    this.cloneName?.release()
  }

  refresh(cx) {
    if (this.busy) return
    const name = this.io.currentName()
    const request = ++this.request
    this.loadedName = name
    this.loading = true
    this.error = ""
    this.notice = ""
    this.needsRefresh = false
    cx.spawn(async (cx) => {
      const [snapshot, inventory] = await Promise.allSettled([
        readSnapshot(this.io, name),
        discoverMods(this.io),
      ])
      if (this.closed || request !== this.request) return
      this.snapshot = snapshot.status === "fulfilled" ? snapshot.value : null
      this.mods = includeMissing(
        inventory.status === "fulfilled" ? inventory.value : [],
        this.snapshot,
      )
      this.error = [
        ...new Set(
          [snapshot, inventory]
            .filter((result) => result.status === "rejected")
            .map((result) => message(result.reason)),
        ),
      ].join("\n")
      this.loading = false
      this.drafts = new Map()
      const selected = this.mods.some((mod) => mod.name === this.selected)
        ? this.selected
        : this.mods[0]?.name
      this.selectMod(selected, cx, true)
      this.cloneName.set_value(validName(name) ? `${name}-personal` : "my-layout")
      cx.notify()
    })
    cx.notify()
  }

  selectMod(name, cx, reset = false) {
    if (this.busy) return
    if (this.selected && !reset) this.drafts.set(this.selected, this.properties.value())
    this.selected = name ?? null
    const slot = this.snapshot?.slots.find((item) => item.name === name)
    this.properties.set_value(this.drafts.get(name) ?? JSON.stringify(slot?.props ?? {}, null, 2))
    cx.notify()
  }

  button(id, text, action, { disabled = false, primary = false, danger = false } = {}) {
    const t = colors()
    return Button.new(id)
      .h(32)
      .px(12)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface)
      .text_color(primary ? t.solid_foreground : danger ? t.blocked : t.foreground)
      .text_size(12)
      .cursor_pointer()
      .disabled(disabled)
      .when(disabled, (element) => element.opacity(0.45))
      .hover((style) => style.opacity(0.85))
      .on_mouse_down("left", stop)
      .on_click((_event, cx) => action(cx))
      .child(text)
  }

  apply(cx, remove = false) {
    const mod = this.mods.find((item) => item.name === this.selected)
    const snapshot = this.snapshot
    if (!mod || !snapshot || this.loading || this.busy || this.needsRefresh) return
    let properties
    try {
      properties = remove ? {} : parseProps(this.properties.value())
    } catch (error) {
      this.error = message(error)
      cx.notify()
      return
    }
    this.busy = true
    this.error = ""
    this.notice = ""
    cx.notify()
    cx.spawn(async (cx) => {
      try {
        const next = await saveSnapshot(this.io, snapshot, (tree) =>
          remove
            ? removePanel(tree, mod.name)
            : addPanel(tree, { name: mod.name, title: mod.title, props: properties }),
        )
        if (this.closed) return
        this.snapshot = next
        this.mods = includeMissing(
          this.mods.filter((item) => !item.missing),
          next,
        )
        this.notice = remove
          ? `Removed ${mod.title} from ${snapshot.name}. Mod files were not changed.`
          : `Saved ${mod.title} in ${snapshot.name}.`
        this.drafts.set(mod.name, JSON.stringify(properties, null, 2))
        if (!remove)
          this.reveal = {
            name: snapshot.name,
            id: next.slots.find((slot) => slot.name === mod.name).id,
          }
      } catch (error) {
        if (this.closed) return
        this.error = `${message(error)} Refresh before trying again.`
        this.needsRefresh = true
      } finally {
        this.busy = false
        if (!this.closed) cx.notify()
      }
    })
  }

  showSelected(cx) {
    const slot = this.snapshot?.slots.find((item) => item.name === this.selected)
    try {
      if (
        !slot ||
        this.io.currentName() !== this.snapshot.name ||
        !findNode(this.currentTree(), slot.id)
      ) {
        throw new Error(
          "The managed panel is not in the current layout. Refresh before trying again.",
        )
      }
      run("layout.select", { stack: STACK_ID, child: slot.id })
      run("layout.show", { id: DOCK_ID })
      this.error = ""
    } catch (error) {
      this.error = message(error)
    }
    cx.notify()
  }

  openSelected(cx) {
    const mod = this.mods.find((item) => item.name === this.selected)
    if (!mod || this.busy || this.loading) return
    try {
      openOverlay(overlaySpec(mod, parseProps(this.properties.value())))
      this.error = ""
    } catch (error) {
      this.error = message(error)
    }
    cx.notify()
  }

  dock() {
    const t = colors()
    const tree = this.currentTree()
    let slots = []
    let active
    try {
      slots = managedSlots(tree)
      active = findNode(tree, STACK_ID)?.active
    } catch {
      // Keep recovery controls available when an external edit changes the owned structure.
    }
    return h_flex()
      .id("layout-manager-dock-controls")
      .size_full()
      .min_w(0)
      .px(6)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .border_b_1()
      .border_color(t.border)
      .child(
        h_flex()
          .id("layout-manager-dock-tabs")
          .flex_1()
          .min_w(0)
          .gap(3)
          .overflow_x_scrollbar()
          .children(
            slots.map((slot) =>
              this.button(`dock-${slot.id}`, slot.title, () =>
                run("layout.select", { stack: STACK_ID, child: slot.id }),
              )
                .max_w(160)
                .truncate()
                .h(27)
                .px(8)
                .bg(active === slot.id ? t.selected : t.chrome)
                .tooltip(`${slot.title} · ${slot.name}`),
            ),
          ),
      )
      .child(
        this.button("manage-layout", "Manage", () => run("mod.open", { name: MOD_NAME }))
          .h(27)
          .px(8),
      )
      .child(
        this.button("hide-dock", "Hide", () => run("layout.hide", { id: DOCK_ID }))
          .h(27)
          .px(8),
      )
  }

  inventory() {
    const t = colors()
    const query = this.query.trim().toLowerCase()
    const mods = this.mods.filter((mod) => `${mod.name} ${mod.title}`.toLowerCase().includes(query))
    return v_flex()
      .w(240)
      .h_full()
      .flex_none()
      .min_h(0)
      .bg(t.chrome)
      .border_r_1()
      .border_color(t.border)
      .p(12)
      .gap(10)
      .child(
        Input.new(this.search)
          .h(34)
          .px(9)
          .bg(t.surface)
          .rounded(6)
          .border_1()
          .border_color(t.input),
      )
      .child(label(`${mods.length} installed or saved mods`, 10, t.dim))
      .child(
        v_flex()
          .id("layout-manager-mod-list")
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            mods.slice(0, this.limit).map((mod) => {
              const managed = this.snapshot?.slots.some((slot) => slot.name === mod.name)
              const selected = mod.name === this.selected
              return v_flex()
                .id(`mod-${mod.name}`)
                .flex_none()
                .p(9)
                .gap(4)
                .rounded(6)
                .bg(selected ? t.selected : t.chrome)
                .cursor_pointer()
                .hover((style) => style.bg(t.hover))
                .on_click((_event, cx) => this.selectMod(mod.name, cx))
                .child(label(mod.title, 12).truncate())
                .child(
                  label(
                    !mod.available
                      ? "Unavailable"
                      : managed
                        ? "Managed panel"
                        : mod.shipped
                          ? "Herdr"
                          : "Installed",
                    10,
                    !mod.available ? t.blocked : t.dim,
                  ),
                )
            }),
          )
          .when(mods.length > this.limit, (element) =>
            element.child(
              this.button("more-mods", "Show more", (cx) => {
                this.limit += 100
                cx.notify()
              }),
            ),
          )
          .when(!this.loading && mods.length === 0, (element) =>
            element.child(label("No matching mods.", 12, t.muted)),
          ),
      )
  }

  detail() {
    const t = colors()
    const mod = this.mods.find((item) => item.name === this.selected)
    if (!mod)
      return label(
        this.loading ? "Reading installed mods…" : "Select an installed mod.",
        13,
        t.muted,
      )
    const slot = this.snapshot?.slots.find((item) => item.name === mod.name)
    const existing = this.snapshot
      ? references(this.snapshot.tree, mod.name).filter((item) => !item.managed)
      : []
    const blocked =
      this.loading || this.busy || !this.snapshot || this.snapshot.shipped || this.needsRefresh
    return v_flex()
      .gap(16)
      .child(label(mod.title, 22).font_semibold())
      .child(label(`mods/${mod.name}`, 11, t.dim))
      .when(Boolean(mod.error), (element) => element.child(label(mod.error, 12, t.blocked)))
      .child(
        label(
          slot
            ? "This mod has a managed right-panel slot."
            : "Add a separate copy to the managed right panel, or open it as an overlay.",
          12,
          t.muted,
        ),
      )
      .when(existing.length > 0, (element) =>
        element.child(
          v_flex()
            .gap(6)
            .p(12)
            .rounded(6)
            .bg(t.surface)
            .child(label("Existing integrations are kept unchanged", 12).font_medium())
            .children(
              existing.map((item, index) =>
                label(`${item.id || `placement-${index + 1}`} · ${item.role}`, 11, t.muted),
              ),
            )
            .child(
              label(
                "Adding a panel creates another view. It does not replace a tab bar, footer, or pane header.",
                11,
                t.dim,
              ),
            ),
        ),
      )
      .child(label("Props · JSON object", 12).font_medium())
      .child(
        Textarea.new(this.properties)
          .h(132)
          .p(10)
          .rounded(6)
          .bg(t.surface)
          .border_1()
          .border_color(t.input)
          .text_size(12),
      )
      .child(
        label(
          'Use props required by the mod, for example {"footer": true}. Layout Manager does not infer special modes.',
          11,
          t.dim,
        ),
      )
      .child(
        h_flex()
          .gap(8)
          .flex_wrap()
          .child(
            this.button(
              "save-panel",
              slot ? "Save panel props" : "Add to right panel",
              (cx) => this.apply(cx),
              { primary: true, disabled: blocked || !mod.available },
            ),
          )
          .when(Boolean(slot), (element) =>
            element.child(
              this.button("show-panel", "Show panel", (cx) => this.showSelected(cx), {
                disabled: this.loading || this.busy,
              }),
            ),
          )
          .child(
            this.button("open-overlay", "Open overlay", (cx) => this.openSelected(cx), {
              disabled: !mod.available || this.loading || this.busy,
            }),
          )
          .when(Boolean(slot), (element) =>
            element.child(
              this.button("remove-panel", "Remove from panel", (cx) => this.apply(cx, true), {
                disabled: blocked,
                danger: true,
              }),
            ),
          ),
      )
      .child(
        v_flex()
          .p(12)
          .gap(7)
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .child(label("Reinstall without editing the layout", 12).font_medium())
          .child(
            label(
              "Panel names and props stay in the personal layout. If a mod is removed, reinstall it with the same folder name to reuse its slot.",
              12,
              t.muted,
            ),
          )
          .child(
            label(
              "Remove from panel changes only this manager's placement. It does not uninstall a mod or guarantee that its programs stop.",
              11,
              t.dim,
            ),
          ),
      )
  }

  render(cx) {
    if (this.entry.mode === "dock") return this.dock()
    const current = this.io.currentName()
    if (current !== this.loadedName && !this.busy && !this.loading) this.refresh(cx)
    if (
      this.reveal &&
      current === this.reveal.name &&
      findNode(this.currentTree(), this.reveal.id)
    ) {
      const { id } = this.reveal
      this.reveal = null
      run("layout.select", { stack: STACK_ID, child: id })
      run("layout.show", { id: DOCK_ID })
    }
    const t = colors()
    return v_flex()
      .id("layout-manager")
      .size_full()
      .min_h(0)
      .bg(t.canvas)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(58)
          .flex_none()
          .px(20)
          .gap(12)
          .items_center()
          .bg(t.chrome)
          .border_b_1()
          .border_color(t.border)
          .child(label("Layout Manager", 17).font_semibold())
          .child(div().flex_1())
          .child(label(`Layout: ${current || "unavailable"}`, 12, t.muted))
          .child(
            this.button("refresh", "Refresh", (cx) => this.refresh(cx), {
              disabled: this.loading || this.busy,
            }),
          )
          .when(Boolean(this.entry.overlay), (element) =>
            element.child(
              this.button("close-layout-manager", "Close", () => closeOverlay(this.entry.overlay)),
            ),
          ),
      )
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .child(this.inventory())
          .child(
            v_flex()
              .flex_1()
              .h_full()
              .min_w(0)
              .min_h(0)
              .p(22)
              .gap(16)
              .id("layout-manager-detail")
              .overflow_y_scrollbar()
              .when(this.loading || this.busy, (element) =>
                element.child(
                  label(
                    this.busy ? "Saving layout…" : "Reading layout and installed mods…",
                    12,
                    t.working,
                  ),
                ),
              )
              .when(Boolean(this.error), (element) =>
                element.child(label(this.error, 12, t.blocked)),
              )
              .when(Boolean(this.notice), (element) =>
                element.child(label(this.notice, 12, t.done)),
              )
              .when(Boolean(this.snapshot?.shipped), (element) =>
                element.child(
                  v_flex()
                    .gap(10)
                    .p(12)
                    .rounded(6)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .child(label("Herdr's layouts are read-only", 14).font_medium())
                    .child(
                      label(
                        "Create a personal clone before adding or removing panels.",
                        12,
                        t.muted,
                      ),
                    )
                    .child(
                      Input.new(this.cloneName)
                        .h(32)
                        .px(9)
                        .bg(t.canvas)
                        .border_1()
                        .border_color(t.input)
                        .rounded(6),
                    )
                    .child(
                      this.button(
                        "clone-layout",
                        "Clone current layout",
                        (cx) => {
                          const name = this.cloneName.value().trim()
                          if (!validName(name)) {
                            this.error =
                              "Use letters, digits, dots, hyphens, or underscores for the clone name."
                            cx.notify()
                            return
                          }
                          run("layout.clone", { name: current, as: name })
                        },
                        { disabled: this.loading || this.busy },
                      ),
                    ),
                ),
              )
              .child(this.detail().flex_none()),
          ),
      )
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(16)
          .bg(t.chrome)
          .border_t_1()
          .border_color(t.border)
          .items_center()
          .child(
            label(
              "Only explicit actions change layouts. Mod files, keys, and credentials are not changed.",
              10,
              t.dim,
            ),
          ),
      )
  }
}
