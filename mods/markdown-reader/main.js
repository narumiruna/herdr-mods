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
    this.entry = initialProps || props() || {}
    this.initialFragment = typeof this.entry.fragment === "string" ? this.entry.fragment : null
    this.io = this.createIO()
    this.closed = false
    this.width = 800
    this.dark = settings().dark
    this.palette = ""
    this.zoom = new Map()
    this.sources = new Set()
    this.editors = new Map()
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
      if ((this.fallback || this.session.manifest?.unresolvedImages) && !this.session.busy)
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
    this.palette = JSON.stringify(this.renderOptions())
    this.refreshTask?.cancel()
    this.refreshTask = cx.timer.after(250, (cx) => this.refresh(cx))
  }

  refresh(cx) {
    if (!this.session || this.closed) return
    this.palette = JSON.stringify(this.renderOptions())
    cx.spawn(async (cx) => {
      const changed = await this.session.refresh(this.renderOptions())
      if (this.closed) return
      if (this.session.manifest && (changed || this.editorPalette !== this.palette)) {
        this.clearEditors()
        this.prepareEditors(this.session.manifest)
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
    if (this.watching || !this.session?.manifest) return
    this.watching = true
    const root = this.session.manifest.root
    cx.spawn(async (cx) => {
      try {
        while (!this.closed) {
          const paths = await watchFolder(root)
          if (this.closed) return
          const manifest = this.session.manifest
          if (
            paths.includes(root) ||
            paths.some((path) =>
              manifest.dependencies.some((file) => {
                const changed = path.replace(/\\/g, "/").replace(/\/$/, "")
                const dependency = file.replace(/\\/g, "/")
                return dependency === changed || dependency.startsWith(`${changed}/`)
              }),
            )
          )
            this.schedule(cx)
        }
      } catch {
        this.watching = false
        this.fallback = true
        if (!this.closed) cx.notify()
      }
    })
  }

  clearEditors() {
    for (const state of this.editors.values()) state.release()
    this.editors.clear()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.refreshTask?.cancel()
    this.clearEditors()
    this.scroll.release()
    this.focus.release()
    await this.session?.close()
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
      .on_click((_event, cx) => action(cx))
      .child(text)
  }

  prepareEditors(manifest) {
    this.editorPalette = this.palette
    const prepare = (block) => {
      if (["code", "error"].includes(block.type) || this.sources.has(block.id))
        this.ensureEditor(block.id, block.source || "", block.language || "text")
      for (const child of block.children || []) prepare(child)
    }
    for (const block of manifest.blocks) prepare(block)
    if (this.raw) this.ensureEditor("document-source", manifest.source, "markdown")
  }

  ensureEditor(id, source, language = "text") {
    let state = this.editors.get(id)
    if (!state) {
      const t = colors()
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
      run("tab.new", {
        name: target.file.split(/[\\/]/).pop(),
        mod: "markdown-reader",
        props: { file: target.file, root: manifest.root, on: null, fragment: target.fragment },
      })
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
        .on_link_click((url, cx) => this.link(url, cx))
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
    if (block.type !== "code")
      toolbar.child(
        this.button(`source-${block.id}`, sourceView ? "Render" : "Source", (cx) => {
          if (sourceView) this.sources.delete(block.id)
          else {
            this.sources.add(block.id)
            this.ensureEditor(block.id, source, block.language || "text")
          }
          cx.notify()
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
        this.button(`less-${block.id}`, "−", (cx) => {
          this.zoom.set(block.id, Math.max(0.25, zoom / 1.25))
          cx.notify()
        }),
      )
      .child(
        this.button(`fit-${block.id}`, "Fit", (cx) => {
          this.zoom.delete(block.id)
          cx.notify()
        }),
      )
      .child(
        this.button(`more-${block.id}`, "+", (cx) => {
          this.zoom.set(block.id, Math.min(4, zoom * 1.25))
          cx.notify()
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
          .child(manifest?.file || this.entry.file || "Markdown Reader"),
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
      .on_click(() => this.focus.focus())
      .on_key_down((event) => {
        if (event.key === "escape") run("pane.go", { direction: "left" })
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
              : "Open a .md or .markdown file from your personal Files panel. Pass explicit file and root props; remote files are not supported.",
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
            .children(manifest.blocks.map((block) => this.block(block))),
        )
        .child(Scrollbar.vertical("reader-scroll").absolute().inset_0()),
    )
  }
}
