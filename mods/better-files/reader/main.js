// Derived from Markdown Reader; modified for direct in-pane opening only.
// The file/root form and Open control are intentionally not included.
import {
  Button,
  Editor,
  EditorState,
  h_flex,
  Scrollbar,
  ScrollHandle,
  TextView,
  v_flex,
} from "gpui-base"
import { div, image, View } from "gpui-kit"
import { closeOverlay, nextCommand, props, run, settings, theme, watchFolder, window } from "herdr"
import { ReaderSession } from "./model.js"
import { createIO } from "./runtime.js"

const colors = () => /** @type {Record<string, import("gpui-kit").Color>} */ (theme())
const message = (error) => String(error?.message || error)

export default class MarkdownReader extends View {
  createIO() {
    return createIO()
  }

  init(initialProps, cx) {
    this.ownerCx = cx
    const owner = this
    // Share native state through the class closure, never through entity props.
    this.BlockView = class extends View {
      init(props) {
        this.update(props)
      }
      update(props) {
        this.block = props.block
      }
      render() {
        return owner.block(this.block)
      }
    }
    this.blocks = new Map()
    this.blockOwners = new Map()
    this.blockEntities = []
    this.entry = initialProps || props() || {}
    this.initialFragment = typeof this.entry.fragment === "string" ? this.entry.fragment : null
    this.io = this.createIO()
    this.closed = false
    this.navigation = Promise.resolve()
    this.width = 800
    this.dark = settings().dark
    this.palette = ""
    this.zoom = new Map()
    this.sources = new Set()
    this.editors = new Map()
    this.editorSpecs = new Map()
    this.raw = false
    this.error = ""
    this.watching = false
    // Linux can accept a watch while omitting Git-ignored directories.
    this.fallback = window()?.platform === "linux"
    this.refreshTask = null
    this.scroll = ScrollHandle.new()
    this.focus = cx.focus_handle()
    try {
      this.session = new ReaderSession(this.io, this.entry)
    } catch (error) {
      this.error = message(error)
    }
    if (this.session) this.refresh(cx)
    cx.timer.every(10000, (cx) => {
      if (this.closed || !this.session) return
      cx.spawn(async () => {
        await this.session.heartbeat()
      })
      if (
        (this.fallback ||
          !this.session.manifest ||
          this.session.manifest.unresolvedImages ||
          this.session.manifest.unresolvedLinks) &&
        !this.session.busy
      )
        this.schedule(cx)
    })
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand()
        if (this.closed) return
        if (command === "focus") this.focus.focus()
        else if (command === "refresh" && this.session) this.schedule(cx)
      }
    })
  }

  back() {
    run("pane.go", { direction: "left" })
  }

  renderOptions() {
    const t = colors()
    return {
      width: this.width,
      dark: settings().dark,
      foreground: t.foreground,
      background: t.background,
      accent: t.accent,
    }
  }

  schedule(cx) {
    if (this.closed || !this.session) return
    this.palette = JSON.stringify(this.renderOptions())
    this.refreshTask?.cancel()
    this.refreshTask = cx.timer.after(250, (cx) => this.refresh(cx))
  }

  refresh(cx) {
    if (!this.session || this.closed) return
    const session = this.session
    const options = this.renderOptions()
    this.palette = JSON.stringify(options)
    cx.spawn(async (cx) => {
      try {
        await this.navigation
      } catch {
        return
      }
      if (this.closed || session !== this.session) return
      const work = session.refresh(options)
      this.watch(cx)
      const serial = session.serial
      const changed = await work
      if (this.closed || session !== this.session || session.serial !== serial) return
      if (session.manifest && (changed || this.editorPalette !== this.palette)) {
        this.prepareEditors(session.manifest)
        this.prepareBlocks(session.manifest, cx)
      }
      if (changed) {
        this.watch(cx)
        if (this.initialFragment !== null) {
          this.reveal(this.initialFragment)
          this.initialFragment = null
        }
      }
      cx.notify()
    })
    cx.notify()
  }

  watch(cx) {
    const session = this.session
    if (!session || this.watchSession === session) return
    this.watchSession = session
    this.watching = true
    const root = session.entry.root
    cx.spawn(async (cx) => {
      try {
        while (!this.closed && this.session === session) {
          const paths = await watchFolder(root)
          if (this.closed || this.session !== session) return
          const dependencies = [session.entry.file, ...(session.manifest?.dependencies || [])]
          if (
            paths.includes(root) ||
            paths.some((path) =>
              dependencies.some((file) => {
                const changed = path.replace(/\\/g, "/").replace(/\/$/, "")
                const dependency = file.replace(/\\/g, "/")
                return dependency === changed || dependency.startsWith(`${changed}/`)
              }),
            )
          )
            this.schedule(cx)
        }
      } catch {
        if (!this.closed && this.session === session) {
          this.fallback = true
          cx.notify()
        }
      } finally {
        if (this.watchSession === session) {
          this.watchSession = null
          this.watching = false
        }
      }
    })
  }

  clearEditors() {
    for (const state of this.editors.values()) state.release()
    this.editors.clear()
    this.editorSpecs.clear()
  }

  clearBlocks() {
    for (const { entity } of this.blocks.values()) entity.release()
    this.blocks.clear()
    this.blockOwners.clear()
    this.blockEntities = []
  }

  blockSpec(block) {
    const state = []
    const collect = (child) => {
      state.push([child.id, this.sources.has(child.id), this.zoom.get(child.id) || 1])
      if (child.type === "graphic") state.push(this.width)
      for (const nested of child.children || []) collect(nested)
    }
    collect(block)
    return JSON.stringify([block, colors(), state])
  }

  prepareBlocks(manifest, cx = this.ownerCx) {
    const active = new Set()
    this.blockOwners.clear()
    this.blockEntities = manifest.blocks.map((block) => {
      active.add(block.id)
      const spec = this.blockSpec(block)
      let retained = this.blocks.get(block.id)
      if (!retained) {
        retained = { entity: cx.new(this.BlockView, { block }), block, spec }
        this.blocks.set(block.id, retained)
      } else {
        retained.block = block
        if (retained.spec !== spec) {
          retained.spec = spec
          retained.entity.set_props({ block })
        }
      }
      const collect = (child) => {
        this.blockOwners.set(child.id, retained)
        for (const nested of child.children || []) collect(nested)
      }
      collect(block)
      return retained.entity
    })
    for (const [id, retained] of this.blocks) {
      if (active.has(id)) continue
      retained.entity.release()
      this.blocks.delete(id)
    }
  }

  redrawBlock(id) {
    const retained = this.blockOwners.get(id)
    if (!retained || this.closed) return
    retained.spec = this.blockSpec(retained.block)
    this.ownerCx.notify(retained.entity)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.refreshTask?.cancel()
    this.clearBlocks()
    this.clearEditors()
    this.scroll.release()
    this.focus.release()
    // The link task reports navigation errors. Do not throw them again during teardown.
    await Promise.all([this.session?.close(), this.navigation.catch(() => {})])
  }

  button(id, text, action, disabled = false) {
    const t = colors()
    return Button.new(id)
      .h(28)
      .px(9)
      .flex_none()
      .rounded(5)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(11)
      .cursor_pointer()
      .disabled(disabled)
      .on_click(() => {
        if (!this.closed) action(this.ownerCx)
      })
      .child(text)
  }

  prepareEditors(manifest) {
    this.editorPalette = this.palette
    const active = new Set()
    const prepare = (block) => {
      if (["code", "error"].includes(block.type) || this.sources.has(block.id)) {
        active.add(block.id)
        this.ensureEditor(block.id, block.source || "", block.language || "text")
      }
      for (const child of block.children || []) prepare(child)
    }
    for (const block of manifest.blocks) prepare(block)
    if (this.raw) {
      active.add("document-source")
      this.ensureEditor("document-source", manifest.source, "markdown")
    }
    for (const [id, state] of this.editors) {
      if (active.has(id)) continue
      state.release()
      this.editors.delete(id)
      this.editorSpecs.delete(id)
    }
    const ids = new Set()
    const collect = (block) => {
      ids.add(block.id)
      for (const child of block.children || []) collect(child)
    }
    manifest.blocks.forEach(collect)
    for (const id of this.sources) if (!ids.has(id)) this.sources.delete(id)
    for (const id of this.zoom.keys()) if (!ids.has(id)) this.zoom.delete(id)
  }

  ensureEditor(id, source, language = "text") {
    let state = this.editors.get(id)
    const t = colors()
    const spec = JSON.stringify([source, language, t])
    if (this.editorSpecs.get(id) !== spec) {
      state?.release()
      state = EditorState.new({
        value: source,
        language,
        readonly: true,
        font_size: 13,
        syntax: {
          keyword: t.ansi5,
          string: t.ansi2,
          comment: t.dim,
          function: t.ansi4,
          type: t.ansi3,
          number: t.ansi1,
          constant: t.ansi6,
        },
      })
      this.editors.set(id, state)
      this.editorSpecs.set(id, spec)
    }
    return state
  }

  code(id, source, _language = "text", full = false) {
    const state = this.editors.get(id)
    if (!state) throw new Error(`Code view was not prepared: ${id}`)
    return full
      ? Editor.new(state).flex_1().min_h(0)
      : Editor.new(state)
          .h(Math.min(400, Math.max(90, (source.split("\n").length + 1) * 20)))
          .w_full()
  }

  reveal(fragment) {
    const index = fragment === "" ? 0 : this.session?.manifest?.anchors[fragment]
    if (Number.isInteger(index)) {
      this.error = ""
      this.scroll.scroll_to_item(index)
    } else this.error = `Heading not found: ${fragment}`
  }

  link(url, cx) {
    const target = this.session?.manifest?.links[url]
    if (!target) {
      this.error = "Unknown or blocked link"
      cx.notify()
      return
    }
    if (target.kind === "fragment") {
      this.reveal(target.fragment)
      cx.notify()
      return
    }
    if (target.kind === "local") {
      const manifest = this.session.manifest
      if (target.file === manifest.file) {
        this.reveal(target.fragment)
        cx.notify()
        return
      }
      const previous = this.session
      const entry = { file: target.file, root: manifest.root, on: previous.entry.on }
      const next = new ReaderSession(this.io, entry)
      next.busy = true
      this.refreshTask?.cancel()
      this.session = next
      this.entry = entry
      this.initialFragment = target.fragment || ""
      this.clearBlocks()
      this.clearEditors()
      this.sources.clear()
      this.zoom.clear()
      this.raw = false
      this.error = ""
      const navigation = Promise.all([this.navigation, previous.close()])
      this.navigation = navigation
      cx.spawn(async (cx) => {
        try {
          await navigation
          if (!this.closed && this.session === next) this.refresh(cx)
        } catch (error) {
          if (!this.closed && this.session === next) {
            next.busy = false
            this.error = message(error)
            cx.notify()
          }
        }
      })
      cx.notify()
      return
    }
    cx.spawn(async (cx) => {
      try {
        await this.io.openExternal(target.url)
      } catch (error) {
        if (!this.closed) {
          this.error = message(error)
          cx.notify()
        }
      }
    })
  }

  block(block) {
    const t = colors()
    if (block.type === "html")
      return TextView.html(`text-${block.id}`, block.html)
        .selectable(true)
        .scrollable(false)
        .w_full()
        .text_size(16)
        .text_color(t.foreground)
        .on_link_click((url) => {
          if (!this.closed) this.link(url, this.ownerCx)
        })
    if (block.type === "container") {
      const content = v_flex()
        .w_full()
        .min_w(0)
        .gap(8)
        .children(block.children.map((child) => this.block(child)))
      if (block.kind === "blockquote") return content.pl(14).border_l(3).border_color(t.border)
      if (block.prefix)
        return h_flex()
          .items_start()
          .gap(8)
          .w_full()
          .child(div().w(24).flex_none().text_size(16).text_color(t.muted).child(block.prefix))
          .child(content.flex_1())
      return content
    }
    const source = block.source || ""
    const sourceView = block.type === "code" || this.sources.has(block.id)
    const toolbar = h_flex()
      .h(32)
      .gap(6)
      .items_center()
      .child(
        div()
          .flex_1()
          .text_size(11)
          .text_color(t.muted)
          .child(block.language || block.kind || "Code"),
      )
      .child(this.button(`copy-${block.id}`, "Copy source", (cx) => cx.write_to_clipboard(source)))
    if (block.type === "graphic")
      toolbar.child(
        this.button(`source-${block.id}`, sourceView ? "Render" : "Source", () => {
          if (sourceView) this.sources.delete(block.id)
          else {
            this.sources.add(block.id)
            this.ensureEditor(block.id, source, block.language || "text")
          }
          this.redrawBlock(block.id)
        }),
      )
    const card = v_flex()
      .id(block.id)
      .w_full()
      .min_w(0)
      .gap(6)
      .p(10)
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
    if (sourceView || block.type === "error") {
      card.child(toolbar)
      if (block.type === "error")
        card.child(div().text_size(12).text_color(t.blocked).child(block.error))
      return card.child(this.code(block.id, source, block.language || "text"))
    }
    const zoom = this.zoom.get(block.id) || 1
    const scale = Math.min(1, Math.max(160, this.width - 40) / block.width) * zoom
    toolbar
      .child(
        this.button(`less-${block.id}`, "−", () => {
          this.zoom.set(block.id, Math.max(0.25, zoom / 1.25))
          this.redrawBlock(block.id)
        }),
      )
      .child(
        this.button(`fit-${block.id}`, "Fit", () => {
          this.zoom.delete(block.id)
          this.redrawBlock(block.id)
        }),
      )
      .child(
        this.button(`more-${block.id}`, "+", () => {
          this.zoom.set(block.id, Math.min(4, zoom * 1.25))
          this.redrawBlock(block.id)
        }),
      )
    card.child(toolbar)
    if (block.alt) card.child(div().text_size(12).text_color(t.muted).child(block.alt))
    return card.child(
      div()
        .id(`graphic-${block.id}`)
        .w_full()
        .overflow_x_scroll()
        .child(
          image(block.asset)
            .w(block.width * scale)
            .h(block.height * scale)
            .flex_none(),
        ),
    )
  }

  render(cx) {
    const t = colors()
    if (this.session && this.palette !== JSON.stringify(this.renderOptions())) this.schedule(cx)
    const manifest = this.session?.manifest
    const error = this.error || this.session?.error
    const header = h_flex()
      .h(44)
      .px(12)
      .gap(8)
      .items_center()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .font_semibold()
          .text_size(13)
          .child(
            manifest?.file || this.session?.entry.file || this.entry.file || "Markdown Reader",
          ),
      )
      .child(
        this.button(
          "reader-refresh",
          this.session?.busy ? "Reading…" : "Reload",
          (cx) => this.schedule(cx),
          !this.session,
        ),
      )
      .child(
        this.button(
          "reader-source",
          this.raw ? "Read" : "Source",
          (cx) => {
            this.raw = !this.raw
            if (this.raw) this.ensureEditor("document-source", manifest.source, "markdown")
            cx.notify()
          },
          !manifest,
        ),
      )
    if (this.entry.overlay)
      header.child(this.button("reader-close", "Close", () => closeOverlay(this.entry.overlay)))
    const root = v_flex()
      .id("markdown-reader")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((event) => {
        if (event.key !== "escape" && event.keystroke !== "backspace") return
        if (this.entry.overlay) closeOverlay(this.entry.overlay)
        else this.back()
      })
      .on_size_change((size, cx) => {
        const width = Math.max(160, Math.min(2048, Math.floor((size.width - 48) / 80) * 80))
        if (width !== this.width) {
          this.width = width
          this.schedule(cx)
        }
      })
      .child(header)
    if (error) root.child(div().px(14).py(8).text_size(12).text_color(t.blocked).child(error))
    if (!manifest)
      return root.child(
        div()
          .p(20)
          .text_size(14)
          .text_color(t.muted)
          .child(
            this.session?.busy
              ? "Reading Markdown…"
              : this.session
                ? "The file could not be read. Restore it and use Reload."
                : "Cannot open this Markdown file. Go back to Files and try again.",
          ),
      )
    for (const warning of manifest.warnings || [])
      root.child(div().px(14).py(5).text_size(11).text_color(t.muted).child(warning))
    if (this.raw) return root.child(this.code("document-source", manifest.source, "markdown", true))
    return root.child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .child(
          v_flex()
            .id("reader-scroll")
            .absolute()
            .inset_0()
            .p(18)
            .gap(14)
            .overflow_y_scroll()
            .track_scroll(this.scroll)
            .children(this.blockEntities),
        )
        .child(Scrollbar.vertical("reader-scroll").absolute().inset_0()),
    )
  }
}
