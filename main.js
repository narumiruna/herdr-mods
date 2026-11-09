import { Button, h_flex, Input, InputState, Scrollbar, v_flex } from "gpui-base"
import { div, svg, View } from "gpui-kit"
import { closeOverlay, props, theme } from "herdr"
import { actionsFor, GALLERY_URL, PreviewSession } from "./preview.js"

/** @import { Color, Context, NativeElement } from "gpui-kit" */
/** @import { ModAction, PreviewMod, Source } from "./preview.js" */
/** @typedef {"installed" | "gallery"} LibrarySection */
/** @typedef {LibrarySection | "github"} Section */

function colors() {
  return /** @type {Record<string, Color>} */ (theme())
}

// Use shipped assets: Herdr blocks asset reads through external symbolic links.
/** @type {Record<string, string>} */
const ICONS = {
  package: "mods/workspace-chrome/layers.svg",
  github: "icons/gh.svg",
  terminal: "icons/shell.svg",
  search: "mods/workspace-chrome/search.svg",
  plus: "mods/workspace-chrome/plus.svg",
  minus: "mods/workspace-chrome/minus.svg",
  check: "mods/workspace-chrome/check.svg",
  close: "mods/workspace-chrome/x.svg",
  arrow: "mods/workspace-chrome/chevron-right.svg",
  grid: "mods/workspace-chrome/layers.svg",
  focus: "mods/workspace-chrome/square.svg",
  notes: "mods/workspace-chrome/file-text.svg",
  shield: "mods/workspace-chrome/circle-check.svg",
}

const ACTION_LABELS = {
  install: "Install",
  enable: "Enable",
  disable: "Disable",
  uninstall: "Uninstall",
}
const ACTION_ICONS = { install: "plus", enable: "check", disable: "minus", uninstall: "close" }
const PROGRESS_LABELS = {
  install: "Simulating installation…",
  enable: "Simulating enable…",
  disable: "Simulating disable…",
  uninstall: "Simulating uninstall…",
}
const RESULT_LABELS = {
  install: "installed",
  enable: "enabled",
  disable: "disabled",
  uninstall: "uninstalled",
}
const STATE_LABELS = {
  available: "Not installed",
  enabled: "Installed · Enabled",
  disabled: "Installed · Disabled",
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

/** @param {string} id @param {NativeElement} content */
function scrollArea(id, content) {
  return div()
    .flex_1()
    .min_h(0)
    .relative()
    .child(content.id(id).absolute().inset_0().overflow_y_scroll())
    .child(Scrollbar.vertical(id).absolute().inset_0())
}

export default class ModManager extends View {
  session = new PreviewSession()
  /** @type {Section} */
  section = "gallery"
  /** @type {Source} */
  source = "all"
  queries = { gallery: "", installed: "" }
  notice = ""
  noticeError = false
  /** @type {Record<LibrarySection, import("gpui-base").InputState>} */
  searches
  /** @type {import("gpui-base").InputState} */
  repository

  init() {
    this.searches = {
      gallery: InputState.new({ placeholder: "Search available mods…" }),
      installed: InputState.new({ placeholder: "Search installed samples…" }),
    }
    for (const section of /** @type {LibrarySection[]} */ (["gallery", "installed"])) {
      this.searches[section].on("change", (_event, cx) => {
        this.queries[section] = this.searches[section].value()
        cx.notify()
      })
    }
    this.repository = InputState.new({ placeholder: "https://github.com/owner/repository" })
  }

  /** @param {Section} section @param {Context} cx */
  navigate(section, cx) {
    if (this.session.uninstallId) return
    this.section = section
    if (!this.session.pending) this.notice = ""
    cx.notify()
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} glyph
   * @param {(cx: Context) => void} action
   */
  button(id, label, glyph, action, disabled = false) {
    const t = colors()
    return Button.new(id)
      .h(30)
      .px(10)
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(6)
      .bg(t.selected)
      .text_color(t.foreground)
      .text_size(11)
      .font_medium()
      .flex_none()
      .disabled(disabled)
      .opacity(disabled ? 0.45 : 1)
      .when(!disabled, (element) => element.cursor_pointer().hover((style) => style.bg(t.hover)))
      .on_click((_event, cx) => action(cx))
      .child(icon(glyph, 13))
      .child(label)
  }

  /** @param {unknown} error */
  reportError(error) {
    this.notice = error instanceof Error ? error.message : "The preview action failed. Try again."
    this.noticeError = true
  }

  /** @param {() => void} start @param {Context} cx */
  perform(start, cx) {
    try {
      start()
    } catch (error) {
      this.reportError(error)
      cx.notify()
      return
    }
    this.notice = PROGRESS_LABELS[this.session.pending.action]
    this.noticeError = false
    cx.notify()
    cx.spawn(async (cx) => {
      try {
        // One bounded delay makes the in-memory operation's progress visible.
        await cx.sleep(250)
        const { action, mod } = this.session.complete()
        this.notice = `Simulated: ${mod.name} ${RESULT_LABELS[action]}. No files were changed.`
        this.noticeError = false
      } catch (error) {
        this.session.fail()
        this.reportError(error)
      }
      cx.notify()
    })
  }

  /** @param {ModAction} action @param {string} id @param {Context} cx */
  act(action, id, cx) {
    if (action !== "uninstall") {
      this.perform(() => this.session.start(action, id), cx)
      return
    }
    try {
      this.session.requestUninstall(id)
      this.notice = ""
    } catch (error) {
      this.reportError(error)
    }
    cx.notify()
  }

  sidebar() {
    const t = colors()
    /** @type {Array<[Section, string, string]>} */
    const items = [
      ["gallery", "Gallery", "grid"],
      ["installed", "Installed", "package"],
      ["github", "From GitHub", "github"],
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
      .child(text("MODS", 10, t.dim).font_semibold().px(10).pt(8).pb(12))
      .children(
        items.map(([section, label, glyph]) =>
          Button.new(`nav-${section}`)
            .h(38)
            .px(10)
            .gap(10)
            .items_center()
            .rounded(7)
            .text_color(this.section === section ? t.foreground : t.muted)
            .when(this.section === section, (element) => element.bg(t.selected))
            .hover((style) => style.bg(t.hover))
            .cursor_pointer()
            .disabled(Boolean(this.session.uninstallId))
            .on_click((_event, cx) => this.navigate(section, cx))
            .child(icon(glyph))
            .child(text(label, 12, this.section === section ? t.foreground : t.muted).flex_1())
            .when(section === "installed", (element) =>
              element.child(text(String(this.session.list("installed").length), 11, t.dim)),
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
              .child(text("Interactive preview", 11).font_medium()),
          )
          .child(text("Sample actions only. Resets when closed.", 10, t.muted)),
      )
      .child(text("MOD MANAGER  /  0.0.0", 9, t.dim).px(3).pt(10))
  }

  /** @param {PreviewMod} mod */
  modCard(mod) {
    const t = colors()
    const development = mod.source === "development"
    const busy = this.session.pending?.mod.id === mod.id
    const locked = Boolean(this.session.pending || mod.protectedReason)
    return v_flex()
      .id(`mod-${mod.id}`)
      .w_full()
      .flex_none()
      .p(15)
      .gap(12)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(
            h_flex()
              .size(38)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(8)
              .bg(t.selected)
              .text_color(development ? t.accent : t.foreground)
              .child(icon(mod.icon, 21)),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(text(mod.name, 14).font_semibold().truncate())
                  .when(Boolean(mod.version), (element) =>
                    element.child(text(`v${mod.version}`, 10, t.dim).flex_none()),
                  ),
              )
              .child(text(mod.description, 11, t.muted).truncate()),
          )
          .child(
            badge(
              busy ? PROGRESS_LABELS[this.session.pending.action] : STATE_LABELS[mod.state],
              mod.state === "enabled" ? t.accent : t.muted,
            ),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .items_center()
              .text_color(t.dim)
              .child(icon(development ? "terminal" : "github", 11))
              .child(text(mod.repository, 10, t.dim).truncate())
              .child(badge(development ? "Development" : "GitHub")),
          )
          .children(
            actionsFor(mod).map((action) =>
              this.button(
                `action-${action}-${mod.id}`,
                ACTION_LABELS[action],
                ACTION_ICONS[action],
                (cx) => this.act(action, mod.id, cx),
                locked,
              ).tooltip(mod.protectedReason || "Simulated action. No real mods are changed."),
            ),
          ),
      )
      .when(Boolean(mod.protectedReason), (element) =>
        element.child(text(mod.protectedReason, 10, t.muted)),
      )
  }

  /** @param {LibrarySection} section */
  library(section) {
    const t = colors()
    const gallery = section === "gallery"
    const mods = this.session.list(section, this.queries[section], gallery ? "all" : this.source)
    /** @type {Array<[Source, string]>} */
    const filters = [
      ["all", "All sources"],
      ["github", "GitHub"],
      ["development", "Development"],
    ]
    return v_flex()
      .size_full()
      .gap(12)
      .child(
        h_flex()
          .gap(16)
          .items_center()
          .justify_between()
          .flex_none()
          .child(
            v_flex()
              .gap(6)
              .child(text(gallery ? "Herdr Gallery" : "Installed mods", 23).font_semibold())
              .child(
                text(
                  gallery
                    ? "Browse mods and try installing a sample."
                    : "Enable, disable, or uninstall your installed samples.",
                  12,
                  t.muted,
                ),
              ),
          )
          .child(
            gallery
              ? this.button("open-gallery", "Website", "arrow", (cx) => cx.open_url(GALLERY_URL))
              : this.button("install-github", "From GitHub", "plus", (cx) =>
                  this.navigate("github", cx),
                ),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .flex_none()
          .child(badge("SAMPLE LIBRARY", t.accent))
          .child(text("Illustrative data, not a live feed or your installed mods.", 11, t.muted)),
      )
      .child(
        h_flex()
          .h(36)
          .px(11)
          .gap(8)
          .items_center()
          .rounded(7)
          .border_1()
          .border_color(t.input)
          .bg(t.surface)
          .flex_none()
          .child(icon("search", 15).text_color(t.dim))
          .child(
            Input.new(this.searches[section])
              .flex_1()
              .h_full()
              .text_size(12)
              .text_color(t.foreground),
          ),
      )
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .flex_none()
          .when(!gallery, (element) =>
            element.children(
              filters.map(([source, label]) =>
                Button.new(`filter-${source}`)
                  .px(10)
                  .py(6)
                  .rounded(6)
                  .text_size(11)
                  .text_color(this.source === source ? t.foreground : t.muted)
                  .when(this.source === source, (element) => element.bg(t.selected))
                  .hover((style) => style.bg(t.hover))
                  .cursor_pointer()
                  .on_click((_event, cx) => {
                    this.source = source
                    cx.notify()
                  })
                  .child(label),
              ),
            ),
          )
          .when(gallery, (element) =>
            element.child(text("Available community samples", 11, t.muted)),
          )
          .child(div().flex_1())
          .child(text(`${mods.length} ${mods.length === 1 ? "mod" : "mods"}`, 10, t.dim)),
      )
      .child(
        scrollArea(
          `${section}-list`,
          v_flex()
            .gap(10)
            .children(mods.map((mod) => this.modCard(mod)))
            .when(mods.length === 0, (element) =>
              element.child(
                v_flex()
                  .py(40)
                  .items_center()
                  .gap(10)
                  .child(icon("search", 26).text_color(t.dim))
                  .child(text("No matching mods", 14).font_medium())
                  .child(text("Try another search or source filter.", 12, t.muted)),
              ),
            ),
        ),
      )
  }

  github() {
    const t = colors()
    return v_flex()
      .size_full()
      .gap(20)
      .child(
        v_flex()
          .gap(7)
          .flex_none()
          .child(text("From GitHub", 23).font_semibold())
          .child(text("Try adding a repository to your sample library.", 12, t.muted)),
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
                .child(badge("SIMULATED INSTALLATION", t.accent))
                .child(text("Start with a repository", 16).font_semibold())
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
                )
                .child(text("URL format only. No repository is fetched or checked.", 11, t.muted))
                .child(
                  h_flex()
                    .gap(10)
                    .justify_between()
                    .items_center()
                    .child(
                      this.button("view-installed", "View installed", "package", (cx) =>
                        this.navigate("installed", cx),
                      ),
                    )
                    .child(
                      this.button(
                        "preview-install",
                        "Simulate install",
                        "plus",
                        (cx) =>
                          this.perform(
                            () => this.session.installRepository(this.repository.value()),
                            cx,
                          ),
                        Boolean(this.session.pending),
                      ),
                    ),
                ),
            )
            .child(
              text(
                "Valid URLs add in-memory samples to Installed. Existing Gallery samples keep their identity. Close the manager to reset.",
                12,
                t.muted,
              ),
            ),
        ),
      )
  }

  confirmation() {
    const t = colors()
    const mod = this.session.mod(this.session.uninstallId)
    return v_flex()
      .id("uninstall-confirmation")
      .size_full()
      .justify_center()
      .gap(18)
      .child(badge("SIMULATED UNINSTALL", t.accent))
      .child(text(`Uninstall ${mod.name}?`, 22).font_semibold())
      .child(
        text("This removes the sample from Installed. It can be installed again.", 12, t.muted),
      )
      .child(
        v_flex()
          .p(18)
          .gap(10)
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .child(text(mod.name, 14).font_semibold())
          .child(text(mod.repository, 11, t.muted))
          .child(text(`Sample path: /preview/mods/${mod.id}`, 11, t.muted)),
      )
      .child(text("Preview only. No files will be removed from your computer.", 12, t.accent))
      .child(
        h_flex()
          .gap(10)
          .justify_end()
          .child(
            this.button("cancel-uninstall", "Cancel", "arrow", (cx) => {
              this.session.cancelUninstall()
              cx.notify()
            }),
          )
          .child(
            this.button("confirm-uninstall", "Uninstall sample", "close", (cx) =>
              this.perform(() => this.session.start("uninstall", mod.id), cx),
            ).text_color(t.blocked),
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
          .h(65)
          .flex_none()
          .px(24)
          .gap(12)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .bg(t.chrome)
          .child(icon("package", 24).text_color(t.accent))
          .child(text("Mod Manager", 16).font_semibold())
          .child(badge("PREVIEW", t.accent))
          .child(div().flex_1())
          .child(text("Herdr extensions, in one place.", 11, t.dim))
          .when(Boolean(overlay), (element) =>
            element.child(
              this.button("close-manager", "Close", "close", () => closeOverlay(overlay)),
            ),
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
              .gap(12)
              .when(Boolean(this.notice), (element) =>
                element.child(
                  text(this.notice, 11, this.noticeError ? t.blocked : t.accent)
                    .id("operation-notice")
                    .flex_none()
                    .p(10)
                    .rounded(6)
                    .bg(t.selected),
                ),
              )
              .child(
                this.session.uninstallId
                  ? this.confirmation()
                  : this.section === "github"
                    ? this.github()
                    : this.library(this.section),
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
            text("Simulated actions only. No installed mods are read or changed.", 10, t.muted),
          )
          .child(div().flex_1())
          .child(text("Close to reset", 10, t.dim)),
      )
  }
}
