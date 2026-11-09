import { h_flex, Input, InputState, Scrollbar, v_flex } from "gpui-base"
import { div, svg, View } from "gpui-kit"
import { appHome, closeOverlay, exec, props, readTextFile, theme, writeTextFile } from "herdr"
import { createManager, errorMessage, filterMods, GALLERY_URL } from "./manager.js"
import { createRuntime } from "./runtime.js"

/** @import { Color, Context, NativeElement } from "gpui-kit" */
/** @import { Mod, Source } from "./manager.js" */
/** @typedef {"installed" | "github" | "gallery"} Section */

function colors() {
  return /** @type {Record<string, Color>} */ (theme())
}

// Herdr blocks asset reads through symbolic links outside its app folder.
// Use the shipped icons so this development checkout needs no asset copies.
/** @type {Record<string, string>} */
const ICONS = {
  package: "mods/workspace-chrome/layers.svg",
  github: "icons/gh.svg",
  terminal: "icons/shell.svg",
  search: "mods/workspace-chrome/search.svg",
  plus: "mods/workspace-chrome/plus.svg",
  close: "mods/workspace-chrome/x.svg",
  arrow: "mods/workspace-chrome/chevron-right.svg",
  grid: "mods/workspace-chrome/layers.svg",
  focus: "mods/workspace-chrome/square.svg",
  notes: "mods/workspace-chrome/file-text.svg",
  shield: "mods/workspace-chrome/circle-check.svg",
}

/** @param {string} name */
function icon(name, size = 16) {
  return svg(ICONS[name]).size(size).flex_none()
}

/** @param {string} value */
function text(value, size = 13, color = colors().foreground) {
  return div().text_size(size).text_color(color).child(value)
}

/** @param {string} value */
function badge(value, color = colors().muted) {
  return text(value, 10, color).px(7).py(3).rounded(5).bg(colors().selected).flex_none()
}

/**
 * @param {string} id
 * @param {NativeElement} content
 */
function scrollArea(id, content) {
  return div()
    .flex_1()
    .min_h(0)
    .relative()
    .child(content.id(id).absolute().inset_0().overflow_y_scroll())
    .child(Scrollbar.vertical(id).absolute().inset_0())
}

export default class ModManager extends View {
  /** @type {Section} */
  section = "installed"
  /** @type {Source} */
  source = "all"
  query = ""
  notice = ""
  failed = false
  loading = false
  busy = false
  closed = false
  /** @type {Mod[]} */
  mods = []
  /** @type {ReturnType<typeof createManager>} */
  manager
  /** @type {import("gpui-base").InputState} */
  search
  /** @type {import("gpui-base").InputState} */
  repository

  /** @param {unknown} _props @param {Context} cx */
  init(_props, cx) {
    this.manager = createManager(
      createRuntime({ exec, read: readTextFile, write: writeTextFile, home: appHome() }),
    )
    this.search = InputState.new({ placeholder: "Search installed mods…" })
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value()
      cx.notify()
    })
    this.repository = InputState.new({ placeholder: "https://github.com/owner/repository" })
    this.refresh(cx)
  }

  close() {
    this.closed = true
  }

  /** @param {Context} cx */
  refresh(cx) {
    if (this.busy || this.loading) return
    this.loading = true
    this.failed = false
    this.notice = ""
    cx.spawn(async (cx) => {
      try {
        this.mods = await this.manager.list()
      } catch (error) {
        this.failed = true
        this.notice = errorMessage(error)
      } finally {
        this.loading = false
        if (!this.closed) cx.notify()
      }
    })
  }

  /** @param {Context} cx @param {() => Promise<string>} operation */
  perform(cx, operation) {
    if (this.busy || this.loading) return
    this.busy = true
    this.failed = false
    this.notice = "Working… Do not edit this checkout or quit Herdr until the operation finishes."
    cx.notify()
    let finish = () => {}
    const completed = new Promise((resolve) => {
      finish = () => resolve(undefined)
    })
    // The unowned transaction never uses a view context. A separate owned task redraws the view.
    cx.spawn(
      async () => {
        try {
          this.notice = await operation()
          if (!this.closed) {
            try {
              this.mods = await this.manager.list()
            } catch (error) {
              this.failed = true
              this.notice += ` Refresh failed: ${errorMessage(error)}`
            }
          }
        } catch (error) {
          this.failed = true
          this.notice = errorMessage(error)
        } finally {
          this.busy = false
          finish()
        }
      },
      { owner: null },
    )
    cx.spawn(async (cx) => {
      await completed
      if (!this.closed) cx.notify()
    })
  }

  /**
   * @param {Section} section
   * @param {Context} cx
   */
  navigate(section, cx) {
    this.section = section
    cx.notify()
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} glyph
   * @param {(cx: Context) => void} action
   */
  button(id, label, glyph, action) {
    const t = colors()
    return h_flex()
      .id(id)
      .h(35)
      .px(12)
      .gap(7)
      .items_center()
      .justify_center()
      .rounded(7)
      .bg(t.solid)
      .text_color(t.solid_foreground)
      .text_size(12)
      .font_medium()
      .cursor_pointer()
      .hover((style) => style.opacity(0.85))
      .on_click((_event, cx) => action(cx))
      .child(icon(glyph, 14))
      .child(label)
  }

  sidebar() {
    const t = colors()
    /** @type {Array<[Section, string, string]>} */
    const items = [
      ["installed", "Installed", "package"],
      ["github", "From GitHub", "github"],
      ["gallery", "Gallery", "grid"],
    ]
    return v_flex()
      .w(176)
      .flex_none()
      .h_full()
      .p(14)
      .gap(5)
      .bg(t.chrome)
      .border_r_1()
      .border_color(t.border)
      .child(text("WORKSPACE", 10, t.dim).font_semibold().px(10).pt(8).pb(12))
      .children(
        items.map(([section, label, glyph]) =>
          h_flex()
            .id(`nav-${section}`)
            .h(38)
            .px(10)
            .gap(10)
            .items_center()
            .rounded(7)
            .text_color(this.section === section ? t.foreground : t.muted)
            .when(this.section === section, (element) => element.bg(t.selected))
            .hover((style) => style.bg(t.hover))
            .cursor_pointer()
            .on_click((_event, cx) => this.navigate(section, cx))
            .child(icon(glyph))
            .child(text(label, 12, this.section === section ? t.foreground : t.muted).flex_1())
            .when(section === "installed", (element) =>
              element.child(text(String(this.mods.length), 11, t.dim)),
            ),
        ),
      )
      .child(div().flex_1())
      .child(
        v_flex()
          .p(11)
          .gap(7)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_color(t.accent)
              .child(icon("shield", 13))
              .child(text("Safe Git updates", 11, t.foreground).font_medium()),
          )
          .child(text("Local changes are protected.", 10, t.muted)),
      )
      .child(text("MOD MANAGER  /  0.0.0", 9, t.dim).px(3).pt(10))
  }

  /** @param {Mod} mod */
  modCard(mod) {
    const t = colors()
    const development = mod.source === "development"
    const sourceLabel = development ? "Development" : mod.source === "github" ? "GitHub" : "Local"
    return h_flex()
      .id(`mod-${mod.id}`)
      .w_full()
      .min_h(104)
      .flex_none()
      .p(17)
      .gap(15)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .size(44)
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(10)
          .bg(t.selected)
          .text_color(development ? t.accent : t.foreground)
          .child(icon(mod.icon, 23)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(7)
          .child(
            h_flex()
              .gap(9)
              .items_center()
              .child(text(mod.name, 14).font_semibold())
              .when(Boolean(mod.version), (element) => element.child(text(mod.version, 10, t.dim))),
          )
          .child(text(mod.description, 11, t.muted))
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .text_color(t.dim)
              .child(icon(development ? "terminal" : "github", 11))
              .child(text(mod.repository, 10, t.dim).truncate()),
          )
          .when(Boolean(mod.problem), (element) => element.child(text(mod.problem, 10, t.blocked))),
      )
      .child(badge(sourceLabel, development ? t.accent : t.muted))
      .child(
        mod.managed
          ? this.button(`update-${mod.id}`, this.busy ? "Working…" : "Update", "arrow", (cx) =>
              this.perform(cx, () => this.manager.update(mod.id)),
            )
          : badge("Read only"),
      )
  }

  installed() {
    const t = colors()
    const mods = filterMods(this.mods, this.query, this.source)
    /** @type {Array<[Source, string]>} */
    const filters = [
      ["all", "All mods"],
      ["github", "GitHub"],
      ["development", "Development"],
      ["local", "Local"],
    ]
    return v_flex()
      .size_full()
      .gap(18)
      .child(
        h_flex()
          .gap(16)
          .items_center()
          .justify_between()
          .flex_none()
          .child(
            v_flex()
              .gap(6)
              .child(text("Installed mods", 23).font_semibold())
              .child(text("Manage extensions for your Herdr workspace.", 12, t.muted)),
          )
          .child(
            h_flex()
              .gap(8)
              .child(this.button("refresh-mods", "Refresh", "search", (cx) => this.refresh(cx)))
              .child(
                this.button("install-github", "Install from GitHub", "plus", (cx) =>
                  this.navigate("github", cx),
                ),
              ),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .flex_none()
          .child(badge("LOCAL LIBRARY", t.accent))
          .child(text("Only manager-installed GitHub checkouts can be updated.", 11, t.muted)),
      )
      .child(
        h_flex()
          .h(38)
          .px(11)
          .gap(8)
          .items_center()
          .rounded(7)
          .border_1()
          .border_color(t.input)
          .bg(t.surface)
          .flex_none()
          .child(icon("search", 15).text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .flex_none()
          .children(
            filters.map(([source, label]) =>
              text(label, 11, this.source === source ? t.foreground : t.muted)
                .id(`filter-${source}`)
                .px(10)
                .py(6)
                .rounded(6)
                .cursor_pointer()
                .when(this.source === source, (element) => element.bg(t.selected))
                .hover((style) => style.bg(t.hover))
                .on_click((_event, cx) => {
                  this.source = source
                  cx.notify()
                }),
            ),
          )
          .child(div().flex_1())
          .child(text(`${mods.length} ${mods.length === 1 ? "mod" : "mods"}`, 10, t.dim)),
      )
      .child(
        scrollArea(
          "mod-list",
          v_flex()
            .gap(10)
            .children(mods.map((mod) => this.modCard(mod)))
            .when(this.loading || mods.length === 0, (element) =>
              element.child(
                v_flex()
                  .py(50)
                  .items_center()
                  .gap(10)
                  .child(icon("search", 26).text_color(t.dim))
                  .child(
                    text(
                      this.loading ? "Reading installed mods…" : "No matching mods",
                      14,
                    ).font_medium(),
                  )
                  .child(
                    text("Use Refresh, change the filter, or install from GitHub.", 12, t.muted),
                  ),
              ),
            ),
        ),
      )
  }

  github() {
    const t = colors()
    return v_flex()
      .size_full()
      .gap(22)
      .child(
        v_flex()
          .gap(7)
          .flex_none()
          .child(text("From GitHub", 23).font_semibold())
          .child(text("Install a trusted mod from a public GitHub repository.", 12, t.muted)),
      )
      .child(
        scrollArea(
          "github-content",
          v_flex()
            .gap(20)
            .child(
              v_flex()
                .p(24)
                .gap(20)
                .rounded(11)
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  h_flex()
                    .gap(12)
                    .items_center()
                    .child(icon("github", 27).text_color(t.foreground))
                    .child(
                      v_flex()
                        .gap(5)
                        .child(text("Start with a repository", 16).font_semibold())
                        .child(text("Paste the GitHub URL of a Herdr mod.", 12, t.muted)),
                    ),
                )
                .child(
                  v_flex()
                    .gap(8)
                    .child(text("Repository URL", 11).font_medium())
                    .child(
                      Input.new(this.repository)
                        .h(40)
                        .px(12)
                        .rounded(7)
                        .border_1()
                        .border_color(t.input)
                        .bg(t.background)
                        .text_color(t.foreground)
                        .text_size(12),
                    ),
                )
                .child(
                  h_flex()
                    .justify_between()
                    .items_center()
                    .child(text("Installing can immediately run trusted mod code.", 11, t.muted))
                    .child(
                      this.button(
                        "install-mod",
                        this.busy ? "Working…" : "Install trusted mod",
                        "plus",
                        (cx) => {
                          const url = this.repository.value()
                          this.perform(cx, () => this.manager.install(url))
                        },
                      ),
                    ),
                ),
            )
            .child(
              v_flex()
                .p(20)
                .gap(10)
                .child(
                  h_flex()
                    .gap(8)
                    .items_center()
                    .text_color(t.accent)
                    .child(icon("shield", 17))
                    .child(text("Installation checks", 13).font_medium()),
                )
                .child(
                  text(
                    "Requires root mod.json and main.js. Existing paths, symbolic links, and submodules are refused.",
                    12,
                    t.muted,
                  ),
                )
                .child(
                  text(
                    "No install scripts or Git hooks run. Structural checks do not prove a mod is safe.",
                    12,
                    t.muted,
                  ),
                ),
            ),
        ),
      )
  }

  /** @param {Context} cx */
  openGallery(cx) {
    try {
      cx.open_url(GALLERY_URL)
      this.failed = false
      this.notice = "Gallery link sent to your browser."
    } catch {
      this.failed = true
      this.notice = "Could not open the browser. Use the Gallery URL below."
    }
    cx.notify()
  }

  gallery() {
    const t = colors()
    return v_flex()
      .size_full()
      .gap(22)
      .child(
        v_flex()
          .gap(7)
          .flex_none()
          .child(text("Herdr Gallery", 23).font_semibold())
          .child(text("Browse extensions for your workspace.", 12, t.muted)),
      )
      .child(
        scrollArea(
          "gallery-content",
          v_flex()
            .gap(18)
            .child(
              v_flex()
                .p(30)
                .gap(18)
                .rounded(12)
                .border_1()
                .border_color(t.border)
                .bg(t.surface)
                .child(
                  h_flex()
                    .size(54)
                    .items_center()
                    .justify_center()
                    .rounded(12)
                    .bg(t.selected)
                    .text_color(t.accent)
                    .child(icon("grid", 27)),
                )
                .child(text("Explore community mods.", 22).font_semibold())
                .child(text("Explore community mods in the Herdr Gallery.", 13, t.muted))
                .child(text("Browse in your browser. Keep your workspace right here.", 12, t.muted))
                .child(
                  h_flex()
                    .pt(8)
                    .child(
                      this.button("open-gallery", "Open Herdr Gallery", "arrow", (cx) =>
                        this.openGallery(cx),
                      ),
                    ),
                )
                .child(text(GALLERY_URL, 11, t.dim)),
            )
            .child(
              text(
                "Gallery browsing uses the website; no supported feed is configured.",
                11,
                t.muted,
              ),
            ),
        ),
      )
  }

  render() {
    const t = colors()
    const overlay = props()?.overlay
    return v_flex()
      .id("mod-manager")
      .size_full()
      .min_h(0)
      .rounded(12)
      .overflow_hidden()
      .bg(t.canvas)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(73)
          .flex_none()
          .px(24)
          .gap(12)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .size(33)
              .items_center()
              .justify_center()
              .rounded(8)
              .bg(t.selected)
              .text_color(t.accent)
              .child(icon("package", 21)),
          )
          .child(text("Mod Manager", 16).font_semibold())
          .child(badge("GITHUB MODS", t.accent))
          .child(div().flex_1())
          .child(text("Herdr extensions, in one place.", 11, t.dim))
          .when(Boolean(overlay), (element) =>
            element.child(
              h_flex()
                .id("close-manager")
                .size(28)
                .ml(8)
                .items_center()
                .justify_center()
                .rounded(6)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((style) => style.bg(t.hover))
                .on_click(() => closeOverlay(overlay))
                .child(icon("close", 15)),
            ),
          ),
      )
      .when(Boolean(this.notice), (element) =>
        element.child(
          text(this.notice, 12, this.failed ? t.blocked : t.accent)
            .px(20)
            .py(10)
            .flex_none(),
        ),
      )
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .child(this.sidebar())
          .child(
            v_flex()
              .h_full()
              .flex_1()
              .min_w(0)
              .min_h(0)
              .p(26)
              .child(
                this.section === "installed"
                  ? this.installed()
                  : this.section === "github"
                    ? this.github()
                    : this.gallery(),
              ),
          ),
      )
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(20)
          .gap(7)
          .items_center()
          .border_t_1()
          .border_color(t.border)
          .bg(t.chrome)
          .child(div().size(5).rounded(3).bg(t.accent))
          .child(
            text(
              this.busy
                ? "Operation continues if this dialog closes."
                : "Git · uv · Python 3 required. Updates never reset local changes.",
              10,
              t.muted,
            ),
          )
          .child(div().flex_1())
          .child(text("Esc to close", 10, t.dim)),
      )
  }
}
