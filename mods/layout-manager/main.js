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
  dockPosition,
  findNode,
  MOD_NAME,
  managedSlots,
  moveDock,
  parseProps,
  references,
  removePanel,
  reorderPanel,
  STACK_ID,
  validName,
} from "./model.js"
import { discoverMods, includeMissing, overlaySpec, readSnapshot, saveSnapshot } from "./runtime.js"
import { ordinaryNodes, placementError, placementValidator, placeNode } from "./tree.js"

const SIDES = ["left", "right", "top", "bottom"]
const sideTitle = (side) => side[0].toUpperCase() + side.slice(1)
const nodeTitle = (node) =>
  typeof node.content?.mod === "string"
    ? node.content.mod
    : node.content?.tab
      ? "Workspace"
      : node.type

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
    this.layoutDrafts = new Map()
    this.draftLayout = null
    this.propertiesBase = "{}"
    this.confirmClose = false
    this.needsRefresh = false
    this.undo = null
    /** @type {{kind: string, name?: string, id?: string, origin: {x: number, y: number}, active: boolean} | null} */
    this.drag = null
    this.dropTarget = null
    this.dropPlacement = null
    this.nodeSource = null
    this.nodeTarget = null
    this.focus = cx.focus_handle()
    this.search = InputState.new({ placeholder: "Search installed mods…" })
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value()
      this.limit = 100
      cx.notify()
    })
    this.properties = TextareaState.new({ value: "{}", rows: 6 })
    this.properties.on("change", (_event, cx) => {
      if (this.closed) return
      this.keepDraft()
      this.confirmClose = false
      cx.notify()
    })
    this.cloneName = InputState.new({ placeholder: "Personal layout name" })
    this.refresh(cx)
  }

  close() {
    this.drag = null
    this.dropTarget = null
    this.dropPlacement = null
    this.nodeSource = null
    this.nodeTarget = null
    this.closed = true
    this.undo = null
    this.search?.release()
    this.properties?.release()
    this.cloneName?.release()
    this.focus?.release()
  }

  refresh(cx) {
    if (this.busy || this.closed) return
    this.keepDraft()
    this.cancelDrag(cx)
    this.undo = null
    const name = this.io.currentName()
    if (name !== this.loadedName) {
      this.nodeSource = null
      this.nodeTarget = null
      this.reveal = null
    }
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
      this.keepDraft()
      this.drafts = this.layoutDrafts.get(name) ?? new Map()
      this.layoutDrafts.set(name, this.drafts)
      const selected = this.mods.some((mod) => mod.name === this.selected)
        ? this.selected
        : this.mods[0]?.name
      this.selectMod(selected, cx, true)
      this.reconcileNodes()
      this.cloneName.set_value(validName(name) ? `${name}-personal` : "my-layout")
      cx.notify()
    })
    cx.notify()
  }

  keepDraft() {
    if (!this.selected || this.draftLayout === null) return
    const drafts = this.layoutDrafts.get(this.draftLayout)
    const text = this.properties.value()
    if (text === this.propertiesBase) drafts?.delete(this.selected)
    else drafts?.set(this.selected, text)
  }

  hasDrafts() {
    return (
      (Boolean(this.selected) && this.properties.value() !== this.propertiesBase) ||
      [...this.layoutDrafts.values()].some((drafts) => drafts.size > 0)
    )
  }

  requestClose(cx) {
    if (this.busy || this.closed) return
    this.keepDraft()
    if (!this.hasDrafts()) return closeOverlay(this.entry.overlay)
    this.cancelDrag(cx)
    this.confirmClose = true
    cx.notify()
  }

  selectMod(name, cx, reset = false) {
    if (this.busy || this.closed || (this.loading && !reset)) return
    if (!reset) this.keepDraft()
    this.selected = name ?? null
    this.draftLayout = this.loadedName
    const slot = this.snapshot?.slots.find((item) => item.name === name)
    this.propertiesBase = JSON.stringify(slot?.props ?? {}, null, 2)
    this.properties.set_value(this.drafts.get(name) ?? this.propertiesBase)
    this.confirmClose = false
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
      .tab_stop(!disabled)
      .accessibility_label(text)
      .focus((style) => style.border_color(t.accent))
      .when(disabled, (element) => element.opacity(0.45))
      .hover((style) => style.opacity(0.85))
      .on_mouse_down("left", (event, cx) => {
        this.cancelDrag(cx)
        stop(event, cx)
      })
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
    const draftText = this.properties.value()
    this.keepDraft()
    this.saveChange(
      cx,
      (tree) =>
        remove
          ? removePanel(tree, mod.name)
          : addPanel(tree, { name: mod.name, title: mod.title, props: properties }),
      remove
        ? `Removed ${mod.title} from ${snapshot.name}. Mod files were not changed.`
        : `Saved ${mod.title} in ${snapshot.name}.`,
      remove ? null : mod.name,
      remove ? null : { name: mod.name, text: draftText },
    )
  }

  canEdit() {
    return Boolean(
      this.snapshot &&
        !this.snapshot.shipped &&
        !this.loading &&
        !this.busy &&
        !this.closed &&
        !this.needsRefresh,
    )
  }

  canUndo() {
    return Boolean(
      this.canEdit() &&
        this.undo?.after === this.snapshot &&
        this.io.currentName() === this.snapshot.name,
    )
  }

  undoLastChange(cx) {
    if (!this.canUndo()) return
    const before = this.undo.before
    this.keepDraft()
    this.saveChange(cx, () => before.tree, "Undid last layout change.", null, null, true)
  }

  /** Save one guarded layout change; reveal only when the action must show a mod. */
  saveChange(cx, transform, notice, reveal = null, savedDraft = null, undoing = false) {
    if (!this.canEdit()) return
    const snapshot = this.snapshot
    this.cancelDrag(cx)
    this.busy = true
    this.confirmClose = false
    this.error = ""
    this.notice = ""
    cx.notify()
    cx.spawn(async (cx) => {
      try {
        if (this.closed) return
        const next = await saveSnapshot(this.io, snapshot, transform)
        if (this.closed) return
        this.snapshot = next
        if (next !== snapshot) this.undo = undoing ? null : { before: snapshot, after: next }
        if (undoing) {
          this.reveal = null
          const slot = next.slots.find((item) => item.name === this.selected)
          this.propertiesBase = JSON.stringify(slot?.props ?? {}, null, 2)
          this.properties.set_value(this.drafts.get(this.selected) ?? this.propertiesBase)
        }
        if (savedDraft && this.selected === savedDraft.name) {
          this.propertiesBase = savedDraft.text
          this.keepDraft()
        }
        this.mods = includeMissing(
          this.mods.filter((item) => !item.missing),
          next,
        )
        this.notice = next === snapshot ? "No layout change." : notice
        this.reconcileNodes()
        if (this.io.currentName() !== next.name) {
          this.nodeSource = null
          this.nodeTarget = null
        }
        if (!this.mods.some((mod) => mod.name === this.selected)) {
          this.selected = null
          this.properties.set_value("{}")
        }
        if (reveal)
          this.reveal = {
            name: snapshot.name,
            id: next.slots.find((slot) => slot.name === reveal).id,
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

  reconcileNodes() {
    const entries = this.snapshot ? ordinaryNodes(this.snapshot.tree) : []
    if (
      this.nodeSource?.kind === "node" &&
      !entries.some(({ node, parent }) => parent && node.id === this.nodeSource.id)
    )
      this.nodeSource = null
    if (
      this.nodeSource?.kind === "new" &&
      !this.mods.some((mod) => mod.name === this.nodeSource.name && mod.available)
    )
      this.nodeSource = null
    if (!entries.some(({ node }) => node.id === this.nodeTarget))
      this.nodeTarget = entries[0]?.node.id ?? null
  }

  selectNodeSource(id, cx) {
    if (!this.canEdit()) return
    if (!ordinaryNodes(this.snapshot.tree).some(({ node, parent }) => parent && node.id === id))
      return
    this.cancelDrag(cx)
    this.nodeSource = { kind: "node", id }
    this.error = ""
    cx.notify()
  }

  selectNodeTarget(id, cx) {
    if (!this.canEdit()) return
    if (!ordinaryNodes(this.snapshot.tree).some(({ node }) => node.id === id)) return
    this.cancelDrag(cx)
    this.nodeTarget = id
    cx.notify()
  }

  selectNewView(name, cx) {
    if (!this.canEdit() || !this.mods.some((mod) => mod.name === name && mod.available)) return
    this.cancelDrag(cx)
    this.selectMod(name, cx)
    this.nodeSource = { kind: "new", name }
    this.error = ""
    cx.notify()
  }

  ordinarySource(source) {
    if (!source) throw new Error("Select an existing source or Add new view first.")
    if (source.kind !== "new") return { kind: source.kind, id: source.id }
    if (!this.mods.some((mod) => mod.name === source.name && mod.available))
      throw new Error("This mod is not available. Move its saved node from the outline instead.")
    const draft =
      source.name === this.selected
        ? this.properties.value()
        : (this.drafts.get(source.name) ??
          JSON.stringify(
            this.snapshot?.slots.find((slot) => slot.name === source.name)?.props ?? {},
          ))
    return { kind: "new", name: source.name, props: parseProps(draft) }
  }

  ordinaryError(source, id, side) {
    if (!this.snapshot) return "Refresh the layout first."
    try {
      return placementError(this.snapshot.tree, this.ordinarySource(source), id, side)
    } catch (error) {
      return message(error)
    }
  }

  placeOrdinary(cx, source, id, side) {
    if (!this.canEdit()) return
    const error = this.ordinaryError(source, id, side)
    if (error) {
      this.error = error
      cx.notify()
      return
    }
    const prepared = this.ordinarySource(source)
    const text = prepared.kind === "node" ? prepared.id : `new view of ${prepared.name}`
    this.saveChange(
      cx,
      (tree) => placeNode(tree, prepared, id, side),
      `Placed ${text} ${side} of ${id}.`,
    )
  }

  cancelDrag(cx) {
    if (!this.drag && !this.dropTarget && !this.dropPlacement) return
    this.drag = null
    this.dropTarget = null
    this.dropPlacement = null
    cx.notify()
  }

  startDrag(kind, name, event, cx) {
    if (!this.canEdit()) return
    if (!["node", "new", "mod", "dock"].includes(kind)) return
    if (kind === "dock" && !this.snapshot.slots.length) return
    if (kind === "node") {
      if (!ordinaryNodes(this.snapshot.tree).some(({ node, parent }) => parent && node.id === name))
        return
      this.selectNodeSource(name, cx)
    }
    if (kind === "new") {
      if (!this.mods.some((mod) => mod.name === name && mod.available)) return
      this.selectNewView(name, cx)
    }
    if (kind === "mod") {
      const mod = this.mods.find((item) => item.name === name)
      if (!mod || (!mod.available && !this.snapshot.slots.some((slot) => slot.name === name)))
        return
      this.selectMod(name, cx)
    }
    cx.stop_propagation()
    this.focus.focus()
    this.drag = {
      kind,
      ...(kind === "node" ? { id: name } : { name }),
      origin: event.position,
      active: false,
    }
    this.dropTarget = null
    this.dropPlacement = null
    cx.notify()
  }

  updateDrag(event, cx) {
    if (!this.drag || this.drag.active) return
    const dx = event.position.x - this.drag.origin.x
    const dy = event.position.y - this.drag.origin.y
    if (dx * dx + dy * dy < 25) return
    this.drag.active = true
    cx.notify()
  }

  acceptsDrop(target) {
    if (!this.canEdit() || !this.drag) return false
    if (this.drag.kind === "node" || this.drag.kind === "new")
      return target.kind === "node" && !this.ordinaryError(this.drag, target.id, target.position)
    if (target.kind === "edge") return true
    if (this.drag.kind !== "mod") return false
    return (
      target.kind === "tab" ||
      (target.kind === "remove" && this.snapshot.slots.some((slot) => slot.name === this.drag.name))
    )
  }

  hoverDrop(target, event, cx) {
    this.updateDrag(event, cx)
    // A child target, including an invalid one, must not fall through to an ancestor.
    if (target.kind === "node" && this.drag) cx.stop_propagation()
    if (!this.drag?.active || !this.acceptsDrop(target)) {
      if (this.dropTarget || this.dropPlacement) {
        this.dropTarget = null
        this.dropPlacement = null
        cx.notify()
      }
      return
    }
    if (this.dropTarget !== target.key) {
      this.dropTarget = target.key
      if (target.kind === "node") {
        this.nodeTarget = target.id
        this.dropPlacement = { id: target.id, side: target.position }
      }
      cx.notify()
    }
  }

  finishDrop(target, event, cx) {
    if (!this.drag) return
    this.updateDrag(event, cx)
    const drag = this.drag
    const accepted = drag.active && this.acceptsDrop(target)
    cx.stop_propagation()
    this.cancelDrag(cx)
    if (!accepted) return
    if (target.kind === "node") {
      this.placeOrdinary(cx, drag, target.id, target.position)
    } else if (drag.kind === "dock") {
      this.saveChange(
        cx,
        (tree) => moveDock(tree, target.position),
        `Moved the managed panel to ${target.position}.`,
      )
    } else if (target.kind === "remove") {
      this.saveChange(
        cx,
        (tree) => removePanel(tree, drag.name),
        `Removed ${drag.name} from the panel. Mod files were not changed.`,
      )
    } else {
      this.placeMod(
        cx,
        drag.name,
        target.position,
        target.kind === "tab" ? target.before : undefined,
      )
    }
  }

  /** Place a mod, or reorder its existing slot without changing the live active tab. */
  placeMod(cx, name, position, before = undefined) {
    if (!this.canEdit()) return
    const mod = this.mods.find((item) => item.name === name)
    const slot = this.snapshot.slots.find((item) => item.name === name)
    if (!mod || (!slot && !mod.available)) return
    let properties
    try {
      if (!slot) {
        properties = parseProps(
          name === this.selected ? this.properties.value() : (this.drafts.get(name) ?? "{}"),
        )
      }
    } catch (error) {
      this.error = message(error)
      cx.notify()
      return
    }
    this.saveChange(
      cx,
      (tree) => {
        let next = slot ? tree : addPanel(tree, { name, title: mod.title, props: properties })
        if (position) next = moveDock(next, position)
        if (before !== undefined) next = reorderPanel(next, name, before)
        return next
      },
      `Saved ${mod.title}${position ? ` in the ${position} panel` : " in the panel"}.`,
      slot && before !== undefined ? null : name,
    )
  }

  /** Move a managed tab one step (-1 or 1), without revealing it or reading draft props. */
  movePanel(cx, name, direction) {
    if (!this.canEdit()) return
    const slots = this.snapshot.slots
    const index = slots.findIndex((slot) => slot.name === name)
    const target = index + direction
    if (index < 0 || target < 0 || target >= slots.length) return
    const before = direction < 0 ? slots[target].name : (slots[target + 1]?.name ?? null)
    this.saveChange(
      cx,
      (tree) => reorderPanel(tree, name, before),
      `Moved ${slots[index].title} ${direction < 0 ? "earlier" : "later"} in the tab order.`,
    )
  }

  dropZone(element, target, enabled = this.acceptsDrop(target)) {
    const t = colors()
    return element
      .when(enabled && this.drag?.active, (item) => item.border_color(t.accent))
      .when(this.dropTarget === target.key, (item) =>
        item.bg(t.selected).when(target.kind === "tab", (card) => card.border_t_2()),
      )
      .on_mouse_move((event, cx) => this.hoverDrop(target, event, cx))
      .on_mouse_up("left", (event, cx) => this.finishDrop(target, event, cx))
      .on_hover((hovered, cx) => {
        if (!hovered && this.dropTarget === target.key) {
          this.dropTarget = null
          this.dropPlacement = null
          cx.notify()
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

  dragHandle(id, kind, name, text, movable = false) {
    const t = colors()
    const managed = this.snapshot?.slots.some((slot) => slot.name === name)
    const available = this.mods.some((mod) => mod.name === name && mod.available)
    const enabled =
      this.canEdit() &&
      (kind === "node"
        ? movable
        : kind === "new"
          ? available
          : kind === "dock" || managed || available)
    return div()
      .id(id)
      .flex_none()
      .px(6)
      .py(4)
      .rounded(4)
      .text_size(11)
      .text_color(enabled ? t.muted : t.dim)
      .child(text)
      .when(enabled, (element) => element.cursor_grab().hover((style) => style.bg(t.hover)))
      .tooltip(
        enabled
          ? kind === "new"
            ? "Add new view: drag beside a layout node"
            : "Drag to move this instance"
          : "Layout editing is unavailable for this source",
      )
      .on_mouse_down("left", (event, cx) => this.startDrag(kind, name, event, cx))
  }

  previewSize(node, sizes) {
    if (sizes.has(node.id)) return sizes.get(node.id)
    const children = (node.children ?? []).map((child) => this.previewSize(child, sizes))
    const horizontal = node.type === "row"
    const size = !children.length
      ? { width: 220, height: 88 }
      : {
          width: Math.max(
            220,
            12 +
              (horizontal
                ? children.reduce((sum, child) => sum + child.width + 6, -6)
                : Math.max(...children.map((child) => child.width))),
          ),
          height:
            68 +
            (horizontal
              ? Math.max(...children.map((child) => child.height))
              : children.reduce((sum, child) => sum + child.height + 6, -6)),
        }
    sizes.set(node.id, size)
    return size
  }

  nodeSideTarget(node, side, outline = false) {
    const t = colors()
    const key = `${outline ? "outline-node" : "node"}-${JSON.stringify([node.id, side])}`
    return this.dropZone(
      div()
        .id(`${outline ? "outline-" : ""}drop-node-${node.id}-${side}`)
        .h(24)
        .flex_1()
        .min_w(0)
        .rounded(4)
        .border_1()
        .border_color(t.border)
        .bg(t.chrome)
        .text_size(10)
        .text_color(t.muted)
        .flex()
        .items_center()
        .justify_center()
        .child(sideTitle(side))
        .tooltip(`Drop ${side} of ${node.id}`),
      { kind: "node", id: node.id, position: side, key },
      Boolean(this.renderTargets?.get(node.id)),
    )
  }

  previewNode(node, depth = 0, sizes = new Map()) {
    const t = colors()
    const children = node.children ?? []
    const size = this.previewSize(node, sizes)
    const source = this.nodeSource?.kind === "node" && this.nodeSource.id === node.id
    return v_flex()
      .id(`preview-node-${node.id}`)
      .w(size.width)
      .h(size.height)
      .flex_none()
      .p(6)
      .gap(4)
      .rounded(5)
      .border_1()
      .border_color(this.nodeTarget === node.id ? t.accent : t.border)
      .bg(source ? t.selected : depth % 2 ? t.canvas : t.surface)
      .child(
        h_flex()
          .h(24)
          .flex_none()
          .min_w(0)
          .gap(3)
          .items_center()
          .child(this.dragHandle(`drag-node-${node.id}`, "node", node.id, "⠿", depth > 0))
          .child(
            this.button(
              `canvas-source-${node.id}`,
              node.id,
              (cx) => this.selectNodeSource(node.id, cx),
              { disabled: !this.canEdit() || depth === 0 },
            )
              .h(24)
              .px(4)
              .flex_1()
              .min_w(0)
              .truncate()
              .tooltip(`${node.id} · ${nodeTitle(node)}${node.hidden ? " · hidden" : ""}`)
              .accessibility_label(`Select source ${node.id}`),
          )
          .child(
            this.button(
              `canvas-target-${node.id}`,
              "Target",
              (cx) => this.selectNodeTarget(node.id, cx),
              {
                disabled: !this.canEdit(),
              },
            )
              .h(24)
              .px(5)
              .accessibility_label(`Select destination ${node.id}`),
          ),
      )
      .child(
        h_flex()
          .gap(3)
          .children(SIDES.map((side) => this.nodeSideTarget(node, side))),
      )
      .when(!children.length, (element) =>
        element.child(label(`${nodeTitle(node)}${node.hidden ? " · hidden" : ""}`, 10, t.muted)),
      )
      .when(children.length > 0, (element) =>
        element.child(
          (node.type === "row" ? h_flex().items_start() : v_flex())
            .flex_none()
            .gap(6)
            .children(children.map((child) => this.previewNode(child, depth + 1, sizes))),
        ),
      )
  }

  nodeOutline(entries) {
    const t = colors()
    return v_flex()
      .id("layout-manager-outline")
      .w(240)
      .flex_none()
      .min_h(0)
      .gap(5)
      .p(6)
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .overflow_y_scrollbar()
      .child(label("Layout outline", 12).font_medium())
      .children(
        entries.map(({ node, parent, depth }) =>
          v_flex()
            .id(`outline-node-${node.id}`)
            .flex_none()
            .gap(3)
            .pl(Math.min(depth, 8) * 8)
            .child(
              h_flex()
                .gap(3)
                .min_w(0)
                .child(
                  this.button(
                    `source-node-${node.id}`,
                    `${node.id}${node.hidden ? " · hidden" : ""}`,
                    (cx) => this.selectNodeSource(node.id, cx),
                    { disabled: !this.canEdit() || !parent },
                  )
                    .h(26)
                    .px(5)
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .bg(
                      this.nodeSource?.kind === "node" && this.nodeSource.id === node.id
                        ? t.selected
                        : t.surface,
                    )
                    .tooltip(`${node.id} · ${nodeTitle(node)} · depth ${depth}`)
                    .accessibility_label(`Select source ${node.id}`),
                )
                .child(
                  this.button(
                    `target-node-${node.id}`,
                    "Target",
                    (cx) => this.selectNodeTarget(node.id, cx),
                    {
                      disabled: !this.canEdit(),
                    },
                  )
                    .h(26)
                    .px(5)
                    .border_color(this.nodeTarget === node.id ? t.accent : t.border)
                    .accessibility_label(`Select destination ${node.id}`),
                ),
            )
            .child(
              h_flex()
                .gap(2)
                .children(SIDES.map((side) => this.nodeSideTarget(node, side, true))),
            ),
        ),
      )
  }

  treeEditor() {
    const t = colors()
    const entries = ordinaryNodes(this.snapshot.tree)
    // Reuse structural eligibility across four sides and both views during this render only.
    // Mouse handlers and the saved transform still validate against the current snapshot.
    let dragged = null
    if (this.canEdit() && (this.drag?.kind === "node" || this.drag?.kind === "new")) {
      try {
        dragged = this.ordinarySource(this.drag)
      } catch {
        // Invalid new-view drafts have no eligible targets.
      }
    }
    const validator = dragged ? placementValidator(this.snapshot.tree, dragged) : null
    this.renderTargets = new Map(
      entries.map(({ node }) => [node.id, Boolean(validator && !validator.error(node.id, "left"))]),
    )
    const source = this.nodeSource
    const text =
      source?.kind === "node" ? source.id : source ? `Add new view · ${source.name}` : "none"
    const problem = this.ordinaryError(source, this.nodeTarget, "left")
    return v_flex()
      .flex_none()
      .gap(8)
      .child(label("Layout tree", 15).font_semibold())
      .child(
        label(
          "Move: select a node ID, choose Target, then a side to save. Or drag its grip. Add new view creates another instance.",
          11,
          t.muted,
        ),
      )
      .child(
        h_flex()
          .h(330)
          .flex_none()
          .min_w(0)
          .gap(8)
          .items_stretch()
          .child(
            div()
              .id("layout-manager-canvas")
              .flex_1()
              .min_w(0)
              .min_h(0)
              .p(8)
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .overflow_scrollbar()
              .child(this.previewNode(entries[0].node)),
          )
          .child(this.nodeOutline(entries)),
      )
      .child(label(`Source: ${text}`, 11).truncate().tooltip(text))
      .child(
        label(
          this.dropPlacement
            ? `Drop ${this.dropPlacement.side} of ${this.dropPlacement.id}`
            : `Destination: ${this.nodeTarget ?? "none"}`,
          11,
          t.accent,
        ).truncate(),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .child(
            this.button(
              "choose-new-view",
              "Add new view",
              (cx) => this.selectNewView(this.selected, cx),
              {
                disabled:
                  !this.canEdit() ||
                  !this.mods.some((mod) => mod.name === this.selected && mod.available),
              },
            ),
          )
          .children(
            SIDES.map((side) =>
              this.button(
                `place-node-${side}`,
                sideTitle(side),
                (cx) => this.placeOrdinary(cx, this.nodeSource, this.nodeTarget, side),
                {
                  disabled: !this.canEdit() || Boolean(problem),
                },
              )
                .accessibility_label(`Place ${text} ${side} of ${this.nodeTarget ?? "destination"}`)
                .tooltip(`Save ${side} of ${this.nodeTarget ?? "destination"}`),
            ),
          )
          .child(
            this.button(
              "clear-node-source",
              "Cancel",
              (cx) => {
                this.cancelDrag(cx)
                this.nodeSource = null
                cx.notify()
              },
              { disabled: !source || this.busy },
            ),
          ),
      )
      .child(
        label(
          problem || "Select a source, choose Target in the outline, then choose a side to save.",
          10,
          t.muted,
        ),
      )
      .child(
        label(
          "Schematic only. Pane headers and terminal splits move with their owning block; they are not separate targets.",
          10,
          t.dim,
        ),
      )
  }

  /** Native buttons let keyboard users reorder each card without selecting it first. */
  reorderControls(slot, index) {
    const t = colors()
    return h_flex()
      .gap(4)
      .px(4)
      .pb(4)
      .children(
        [
          { text: "Earlier", direction: -1 },
          { text: "Later", direction: 1 },
        ].map(({ text, direction }) => {
          const target = index + direction
          const disabled = !this.canEdit() || target < 0 || target >= this.snapshot.slots.length
          return this.button(
            `move-tab-${slot.name}-${text.toLowerCase()}`,
            text,
            (cx) => this.movePanel(cx, slot.name, direction),
            { disabled },
          )
            .h(24)
            .px(6)
            .text_size(10)
            .flex_1()
            .tab_stop(!disabled)
            .accessibility_label(`Move ${slot.title} tab ${text.toLowerCase()}`)
            .focus((style) => style.border_color(t.accent))
        }),
      )
  }

  panelPreview(position) {
    const t = colors()
    const slots = this.snapshot.slots
    const hidden = findNode(this.snapshot.tree, DOCK_ID)?.hidden
    return v_flex()
      .id("layout-manager-panel-preview")
      .flex_none()
      .min_h(0)
      .gap(4)
      .p(6)
      .rounded(6)
      .border_1()
      .border_color(t.accent)
      .bg(t.chrome)
      .when(position === "left" || position === "right", (element) => element.w(154))
      .when(position === "top" || position === "bottom", (element) => element.h(104))
      .child(
        this.dragHandle(
          "drag-dock",
          "dock",
          null,
          `⠿ Panel · ${position}${hidden ? " · hidden" : ""}`,
        ),
      )
      .child(
        v_flex()
          .id("layout-manager-preview-tabs")
          .flex_1()
          .min_h(0)
          .gap(3)
          .overflow_y_scrollbar()
          .children(
            slots.map((slot, index) =>
              this.dropZone(
                v_flex()
                  .id(`preview-tab-${slot.name}`)
                  .flex_none()
                  .min_w(0)
                  .gap(3)
                  .rounded(4)
                  .border_1()
                  .border_color(t.border)
                  .bg(this.selected === slot.name ? t.selected : t.surface)
                  .on_click((_event, cx) => this.selectMod(slot.name, cx))
                  .child(
                    h_flex()
                      .min_w(0)
                      .gap(3)
                      .items_center()
                      .child(this.dragHandle(`drag-tab-${slot.name}`, "mod", slot.name, "⠿"))
                      .child(label(slot.title, 10).truncate().tooltip(`Drop before ${slot.title}`)),
                  )
                  .child(this.reorderControls(slot, index)),
                { kind: "tab", before: slot.name, key: `tab-${slot.name}` },
              ),
            ),
          )
          .child(
            this.dropZone(
              div()
                .id("drop-tab-end")
                .h(26)
                .flex_none()
                .px(6)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .text_size(10)
                .text_color(t.muted)
                .child("Drop to append"),
              { kind: "tab", before: null, key: "append" },
            ),
          ),
      )
  }

  edgeTarget(position) {
    const t = colors()
    const current = this.snapshot && dockPosition(this.snapshot.tree)
    const target = { kind: "edge", position, key: `edge-${position}` }
    return this.dropZone(
      h_flex()
        .id(`drop-${position}`)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(5)
        .border_1()
        .border_color(current === position ? t.accent : t.border)
        .bg(t.chrome)
        .text_size(10)
        .text_color(t.muted)
        .when(position === "top" || position === "bottom", (element) => element.h(28))
        .when(position === "left" || position === "right", (element) => element.w(48))
        .child(position[0].toUpperCase() + position.slice(1))
        .tooltip(`Drop a mod or the panel here · ${position}`),
      target,
    )
  }

  editor() {
    if (!this.snapshot) return div()
    return v_flex().flex_none().gap(20).child(this.treeEditor())
  }

  legacyEditor() {
    const t = colors()
    const position = dockPosition(this.snapshot.tree)
    return v_flex()
      .flex_none()
      .gap(9)
      .child(label("Managed panel (legacy)", 14).font_semibold())
      .child(
        label("These controls move the whole added panel, not ordinary layout nodes.", 11, t.muted),
      )
      .child(
        h_flex()
          .gap(6)
          .children(SIDES.map((side) => this.edgeTarget(side).w(70).h(28))),
      )
      .when(Boolean(position), (element) =>
        element.child(this.panelPreview(position).w_full().h(140)),
      )
      .when(Boolean(this.selected), (element) =>
        element.child(
          this.dragHandle(
            `drag-mod-${this.selected}`,
            "mod",
            this.selected,
            "⠿ Add or move a managed tab",
          ),
        ),
      )
      .child(
        h_flex()
          .gap(8)
          .flex_wrap()
          .items_center()
          .child(label("Managed panel edge:", 11, t.muted))
          .children(
            ["left", "right", "top", "bottom"].map((edge) =>
              this.button(
                `place-${edge}`,
                edge[0].toUpperCase() + edge.slice(1),
                (cx) => this.placeMod(cx, this.selected, edge),
                {
                  disabled:
                    !this.canEdit() ||
                    !this.mods.some(
                      (mod) =>
                        mod.name === this.selected &&
                        (mod.available ||
                          this.snapshot.slots.some((slot) => slot.name === mod.name)),
                    ),
                },
              ),
            ),
          ),
      )
      .child(
        this.dropZone(
          h_flex()
            .id("drop-remove-panel")
            .h(32)
            .flex_none()
            .px(10)
            .items_center()
            .rounded(5)
            .border_1()
            .border_color(t.border)
            .child(label("Drop a managed card here to remove its placement", 10, t.muted)),
          { kind: "remove", key: "remove" },
        ),
      )
      .child(
        label(
          "Managed slots stay in this panel. Use the layout tree above to move existing ordinary nodes.",
          10,
          t.dim,
        ),
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
      .child(label("Inventory grips: Add new view", 10, t.muted))
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
                .when(
                  this.drag?.kind === "new" && this.drag.name === mod.name && this.drag.active,
                  (element) => element.opacity(0.5),
                )
                .child(
                  h_flex()
                    .min_w(0)
                    .gap(5)
                    .items_center()
                    .child(this.dragHandle(`drag-new-mod-${mod.name}`, "new", mod.name, "⠿"))
                    .child(
                      this.button(
                        `select-mod-${mod.name}`,
                        mod.title,
                        (cx) => this.selectMod(mod.name, cx),
                        { disabled: this.loading || this.busy },
                      )
                        .h(28)
                        .px(4)
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .accessibility_label(`Select mod ${mod.title}`)
                        .tooltip(mod.name),
                    ),
                )
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
    if (this.loading) return label("Reading installed mods…", 13, t.muted)
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
            ? `This mod has a managed ${dockPosition(this.snapshot.tree)}-panel slot.`
            : "Drag the inventory grip beside a layout node to add a new view, or open an overlay.",
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
            .child(label("Existing instances and integrations", 12).font_medium())
            .children(
              existing.map((item, index) =>
                label(`${item.id || `placement-${index + 1}`} · ${item.role}`, 11, t.muted),
              ),
            )
            .child(
              label(
                "Move an existing instance by node ID in the layout tree. Add new view creates another instance; embedded headers are not separate targets.",
                11,
                t.dim,
              ),
            ),
        ),
      )
      .child(label("Props · JSON object", 12).font_medium())
      .child(
        label(
          "Props drafts stay in this dialog across Refresh and layout changes. They are not saved when the dialog closes.",
          11,
          t.muted,
        ),
      )
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
              slot ? "Save managed panel props" : "Add to managed panel",
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
      .track_focus(this.focus)
      .on_mouse_down("left", (_event, cx) => this.cancelDrag(cx))
      .on_mouse_move((event, cx) => this.updateDrag(event, cx))
      .on_mouse_up("left", (_event, cx) => this.cancelDrag(cx))
      .on_mouse_down_out((_event, cx) => this.cancelDrag(cx))
      .on_hover((hovered, cx) => {
        if (!hovered) this.cancelDrag(cx)
      })
      .on_key_down((event, cx) => {
        if (event.key === "escape" && (this.drag || this.nodeSource)) {
          this.cancelDrag(cx)
          this.nodeSource = null
          cx.notify()
          cx.stop_propagation()
        }
      })
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
            this.button("undo-layout-change", "Undo last change", (cx) => this.undoLastChange(cx), {
              disabled: !this.canUndo(),
            }),
          )
          .child(
            this.button("refresh", "Refresh", (cx) => this.refresh(cx), {
              disabled: this.loading || this.busy,
            }),
          )
          .when(Boolean(this.entry.overlay), (element) =>
            element.child(
              this.button("close-layout-manager", "Close", (cx) => this.requestClose(cx), {
                disabled: this.busy,
              }),
            ),
          ),
      )
      .when(this.confirmClose, (element) =>
        element.child(
          v_flex()
            .flex_none()
            .p(12)
            .gap(8)
            .bg(t.chrome)
            .child(
              label("Unsaved props drafts will be lost when this dialog closes.", 12, t.blocked),
            )
            .child(
              h_flex()
                .gap(8)
                .child(
                  this.button("keep-editing", "Keep editing", (cx) => {
                    this.confirmClose = false
                    cx.notify()
                  }),
                )
                .child(
                  this.button(
                    "discard-drafts-close",
                    "Discard drafts and close",
                    () => closeOverlay(this.entry.overlay),
                    { danger: true },
                  ),
                ),
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
                        "Create a personal clone before changing layout structure, panel placement, or props.",
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
              .when(!this.loading, (element) =>
                element
                  .child(this.editor())
                  .child(this.detail().flex_none())
                  .when(Boolean(this.snapshot), (item) => item.child(this.legacyEditor())),
              ),
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
              this.drag
                ? this.drag.active
                  ? "Release on a highlighted target to save. Escape or leaving the dialog cancels."
                  : "Move the pointer to drag. A click does not change the layout."
                : "Drops save immediately to the personal layout. Mod files, keys, and credentials are not changed.",
              10,
              t.dim,
            ),
          ),
      )
  }
}
