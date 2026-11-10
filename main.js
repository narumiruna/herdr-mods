import { Button, h_flex, Input, InputState, Scrollbar, v_flex } from "gpui-base"
import { div, svg, View } from "gpui-kit"
import { closeOverlay, props, theme } from "herdr"
import { actionsFor, GALLERY_URL, ManagerSession } from "./manager.js"
import { createIO } from "./runtime.js"

/** @import { AsyncContext, Color, Context, NativeElement } from "gpui-kit" */
/** @import { ManagerMod, ModAction, Source } from "./manager.js" */
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
  close: "mods/workspace-chrome/x.svg",
  arrow: "mods/workspace-chrome/chevron-right.svg",
  grid: "mods/workspace-chrome/layers.svg",
  focus: "mods/workspace-chrome/square.svg",
  notes: "mods/workspace-chrome/file-text.svg",
  shield: "mods/workspace-chrome/circle-check.svg",
}
const ACTION_LABELS = { install: "Install", update: "Update", uninstall: "Uninstall" }
const ACTION_ICONS = { install: "plus", update: "arrow", uninstall: "close" }
const PROGRESS_LABELS = {
  install: "Installing mod…",
  update: "Updating mod…",
  uninstall: "Uninstalling mod…",
  "check-update": "Checking for updates…",
  migrate: "Migrating ownership…",
}
const INSTALL_WARNING =
  "Community mods run code and may load immediately. Review and trust the source before installation."
const PLACEMENT_POLICY =
  "Placement: omitted, none, left, right, top and bottom are accepted. A mod may dock immediately. The manager does not edit layouts or keybindings."
const SOURCE_LABELS = {
  all: "All sources",
  github: "GitHub",
  development: "Development",
  local: "Local",
  shipped: "Shipped",
}

/** @param {string} name */
function icon(name, size = 16) {
  return svg(ICONS[name] || ICONS.package)
    .size(size)
    .flex_none()
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
  /** @type {ManagerSession} */
  session
  /** @type {Section} */
  section = "gallery"
  /** @type {Record<LibrarySection, Source>} */
  sources = { gallery: "all", installed: "all" }
  queries = { gallery: "", installed: "" }
  shown = { gallery: 50, installed: 50 }
  notice = ""
  noticeError = false
  closed = false
  loadStarted = false
  operationQueued = false
  queuedProgress = "Working…"
  /** @type {Record<LibrarySection, import("gpui-base").InputState>} */
  searches
  /** @type {import("gpui-base").InputState} */
  repository

  /** @param {(ms: number) => Promise<void>} wait */
  createSession(wait) {
    return new ManagerSession(createIO(undefined, wait))
  }

  /** @param {import("gpui-shell").Props | undefined} _props @param {AsyncContext} cx */
  init(_props, cx) {
    if (!this.session) this.session = this.createSession((ms) => cx.sleep(ms))
    if (!this.searches) {
      this.searches = {
        gallery: InputState.new({ placeholder: "Search available mods…" }),
        installed: InputState.new({ placeholder: "Search installed mods…" }),
      }
      for (const section of /** @type {LibrarySection[]} */ (["gallery", "installed"])) {
        this.searches[section].on("change", (_event, cx) => {
          if (this.closed || this.confirming()) return
          this.queries[section] = this.searches[section].value()
          this.shown[section] = 50
          cx.notify()
        })
      }
      this.repository = InputState.new({ placeholder: "https://github.com/owner/repository" })
    }
    if (!this.loadStarted) {
      this.loadStarted = true
      this.load(cx, true)
    }
  }

  close() {
    // A committed backend transaction must finish or reconcile on the next open.
    this.closed = true
  }

  /** @param {Context} cx @param {boolean} [initial] @param {LibrarySection} [section] */
  load(cx, initial = false, section = this.section === "github" ? "installed" : this.section) {
    if (this.closed || this.confirming() || this.session.pending || this.operationQueued) return
    if (
      !initial &&
      (section === "gallery" ? this.session.galleryStatus : this.session.discoveryStatus) ===
        "loading"
    )
      return
    this.notice = ""
    cx.spawn(async (cx) => {
      try {
        const changed = () => {
          if (!this.closed) cx.notify()
        }
        await (initial
          ? this.session.load(changed)
          : section === "gallery"
            ? this.session.refreshGallery(changed)
            : this.session.refreshInstalled(changed))
      } catch (error) {
        this.reportError(error)
      } finally {
        if (!this.closed) cx.notify()
      }
    })
    cx.notify()
  }

  /** @param {Section} section @param {Context} cx */
  navigate(section, cx) {
    if (this.closed || this.confirming()) return
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
      .on_click((_event, cx) => {
        if (!disabled && !this.closed) action(cx)
      })
      .child(icon(glyph, 13))
      .child(label)
  }

  /** @param {unknown} error */
  reportError(error) {
    this.notice = error instanceof Error ? error.message : "The operation failed. Try again."
    this.noticeError = true
  }

  /** @param {() => Promise<{message?: string}>} start @param {Context} cx */
  perform(start, cx, confirming = false, progress = "Working…") {
    if (this.closed || (this.confirming() && !confirming)) return
    if (
      this.session.pending ||
      this.operationQueued ||
      this.session.discoveryStatus === "loading"
    ) {
      this.reportError(new Error("Another operation is in progress. Wait for it to finish."))
      cx.notify()
      return
    }
    if (this.session.discoveryStatus !== "ready") {
      this.reportError(
        new Error("Installed-mod discovery must finish successfully before changes."),
      )
      cx.notify()
      return
    }
    // Reserve the view gate now, but start host work only inside the unowned task.
    this.operationQueued = true
    this.queuedProgress = progress
    this.notice = `${progress} Do not edit these mods or quit Herdr until the operation finishes.`
    this.noticeError = false
    let finish = () => {}
    const completed = new Promise((resolve) => {
      finish = () => resolve(undefined)
    })
    cx.spawn(
      async () => {
        try {
          const result = await start()
          this.notice =
            result.message || "File operation verified. Runtime reload is not confirmed."
          this.noticeError = false
        } catch (error) {
          this.reportError(error)
        } finally {
          this.operationQueued = false
          finish()
        }
      },
      { owner: null },
    )
    cx.spawn(async (cx) => {
      await completed
      if (!this.closed) cx.notify()
    })
    cx.notify()
  }

  /** @param {ModAction} action @param {string} id @param {Context} cx */
  act(action, id, cx) {
    if (this.closed || this.confirming()) return
    if (action !== "uninstall") {
      this.perform(() => this.session.perform(action, id), cx, false, PROGRESS_LABELS[action])
      return
    }
    if (this.busy()) return
    try {
      if (this.session.discoveryStatus !== "ready") {
        throw new Error("Installed-mod discovery must finish successfully before changes.")
      }
      this.session.requestUninstall(id)
      this.notice = ""
    } catch (error) {
      this.reportError(error)
    }
    cx.notify()
  }

  /** @param {Context} cx */
  checkUpdates(cx) {
    if (this.closed || this.confirming() || this.busy()) return
    this.perform(
      async () => {
        await this.session.checkUpdates()
        return { message: "Update check complete. See each mod for results." }
      },
      cx,
      false,
      PROGRESS_LABELS["check-update"],
    )
  }

  confirming() {
    return Boolean(this.session.confirmation || this.session.migrationConfirmation)
  }

  mutationBlocked() {
    return Boolean(this.session.migration?.required || this.session.migration?.blocked)
  }

  busy() {
    // Gallery loading never gates local discovery or local file operations.
    return Boolean(
      this.session.pending || this.operationQueued || this.session.discoveryStatus === "loading",
    )
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
            .disabled(this.confirming())
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
              .child(text("Protected operations", 11).font_medium()),
          )
          .child(text("Only verified, eligible targets can change.", 10, t.muted)),
      )
      .child(text("MOD MANAGER  /  0.0.0", 9, t.dim).px(3).pt(10))
  }

  /** @param {ManagerMod} mod */
  modCard(mod) {
    const t = colors()
    const pending = this.session.pending
    const busy = pending?.id === mod.id
    const reason =
      mod.protectedReason ||
      (this.session.discoveryStatus !== "ready" ? "Installed-mod discovery is not ready." : "") ||
      (mod.state === "available" && this.session.galleryStatus !== "ready"
        ? "The Gallery must load successfully before installation."
        : "")
    const locked = Boolean(this.busy() || this.confirming() || this.mutationBlocked() || reason)
    const updateError = this.session.updateErrors[mod.id]
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
              .text_color(mod.source === "development" ? t.accent : t.foreground)
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
                    element.child(text(`Version ${mod.version}`, 10, t.dim).flex_none()),
                  ),
              )
              .child(text(mod.description || "No description provided.", 11, t.muted)),
          )
          .child(
            badge(
              busy
                ? PROGRESS_LABELS[pending.action]
                : mod.state === "installed"
                  ? "Installed"
                  : "Not installed",
              mod.state === "installed" ? t.accent : t.muted,
            ),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .child(
                text(mod.repository || mod.path || "Repository not recorded", 10, t.dim).truncate(),
              )
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(badge(SOURCE_LABELS[mod.source]))
                  .when(mod.state === "installed", (element) =>
                    element.child(badge(mod.managed ? "Manager-owned" : "Not manager-owned")),
                  )
                  .when(Boolean(mod.updateCommit), (element) =>
                    element.child(badge("Update available", t.accent)),
                  ),
              ),
          )
          .children(
            actionsFor(mod).map((action) =>
              this.button(
                `action-${action}-${mod.id}`,
                ACTION_LABELS[action],
                ACTION_ICONS[action],
                (cx) => this.act(action, mod.id, cx),
                locked,
              ).tooltip(reason || `Verify and ${action} this mod.`),
            ),
          ),
      )
      .when(mod.state === "available", (element) =>
        element
          .child(text(INSTALL_WARNING, 11, t.blocked))
          .child(text(PLACEMENT_POLICY, 11, t.muted)),
      )
      .when(Boolean(mod.recipePath), (element) =>
        element.child(text(`Recipe: ${mod.recipePath} · Mod: ${mod.modName}`, 10, t.dim)),
      )
      .when(Boolean(mod.commit), (element) =>
        element.child(
          text(
            `${mod.state === "installed" ? "Installed" : "Gallery"} commit: ${mod.commit.slice(0, 12)}`,
            10,
            t.dim,
          ),
        ),
      )
      .when(Boolean(reason), (element) => element.child(text(reason, 11, t.muted)))
      .when(Boolean(updateError), (element) =>
        element.child(text(`Update check failed: ${updateError}`, 11, t.blocked)),
      )
  }

  /** @param {LibrarySection} section */
  library(section) {
    const t = colors()
    const gallery = section === "gallery"
    const status = gallery ? this.session.galleryStatus : this.session.discoveryStatus
    const mods = this.session.list(section, this.queries[section], this.sources[section])
    const loading = status === "idle" || status === "loading"
    return v_flex()
      .size_full()
      .gap(12)
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .justify_between()
          .flex_none()
          .child(
            v_flex()
              .gap(6)
              .flex_1()
              .child(text(gallery ? "Herdr Gallery" : "Installed mods", 23).font_semibold())
              .child(
                text(
                  gallery
                    ? "Browse community mods and manage installations."
                    : "Verified local inventory and installation sources.",
                  12,
                  t.muted,
                ),
              ),
          )
          .child(
            this.button(
              "refresh-library",
              "Refresh",
              "arrow",
              (cx) => this.load(cx, false, section),
              Boolean(this.session.pending || this.operationQueued || this.confirming() || loading),
            ),
          )
          .child(
            gallery
              ? this.button("open-gallery", "Website", "arrow", (cx) => this.openGallery(cx))
              : this.button("install-github", "From GitHub", "plus", (cx) =>
                  this.navigate("github", cx),
                ),
          ),
      )
      .when(gallery, (element) => element.child(text(GALLERY_URL, 10, t.dim).flex_none()))
      .when(!gallery, (element) =>
        element.child(
          this.button(
            "check-updates",
            "Check updates",
            "arrow",
            (cx) => this.checkUpdates(cx),
            this.busy() || this.mutationBlocked() || this.confirming() || status !== "ready",
          ),
        ),
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
          .children(
            /** @type {Source[]} */ (["all", "github", "development", "local", "shipped"]).map(
              (source) =>
                Button.new(`filter-${source}`)
                  .px(10)
                  .py(6)
                  .rounded(6)
                  .text_size(11)
                  .text_color(this.sources[section] === source ? t.foreground : t.muted)
                  .when(this.sources[section] === source, (element) => element.bg(t.selected))
                  .hover((style) => style.bg(t.hover))
                  .cursor_pointer()
                  .on_click((_event, cx) => {
                    if (this.closed || this.confirming()) return
                    this.sources[section] = source
                    this.shown[section] = 50
                    cx.notify()
                  })
                  .child(SOURCE_LABELS[source]),
            ),
          )
          .child(div().flex_1())
          .child(text(`${mods.length} ${mods.length === 1 ? "mod" : "mods"}`, 10, t.dim)),
      )
      .when(loading, (element) =>
        element.child(
          text(gallery ? "Loading Gallery…" : "Discovering installed mods…", 12, t.accent).id(
            "library-loading",
          ),
        ),
      )
      .child(
        scrollArea(
          `${section}-list`,
          v_flex()
            .gap(10)
            .children(mods.slice(0, this.shown[section]).map((mod) => this.modCard(mod)))
            .when(mods.length > this.shown[section], (element) =>
              element.child(
                this.button(
                  `show-more-${section}`,
                  `Show more (${this.shown[section]} of ${mods.length})`,
                  "plus",
                  (cx) => {
                    if (this.confirming()) return
                    this.shown[section] += 50
                    cx.notify()
                  },
                  this.busy(),
                ),
              ),
            )
            .when(mods.length === 0 && status === "ready", (element) =>
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
          .child(text("Install a mod from a public GitHub repository.", 12, t.muted)),
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
                .child(
                  text(
                    "Use https://github.com/owner/repository. Ambiguous bundles are rejected; select a Gallery mod instead.",
                    11,
                    t.muted,
                  ),
                )
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
                        "install-repository",
                        "Install",
                        "plus",
                        (cx) => {
                          // Read the native input while its view is open, not inside the durable task.
                          const input = this.repository.value()
                          this.perform(
                            () => this.session.installRepository(input),
                            cx,
                            false,
                            PROGRESS_LABELS.install,
                          )
                        },
                        this.busy() ||
                          this.confirming() ||
                          this.mutationBlocked() ||
                          this.session.discoveryStatus !== "ready",
                      ),
                    ),
                ),
            )
            .child(text(INSTALL_WARNING, 12, t.blocked))
            .child(text(PLACEMENT_POLICY, 12, t.muted))
            .child(
              text(
                "No repository install scripts are run. Structural checks do not prove code safety.",
                12,
                t.muted,
              ),
            ),
        ),
      )
  }

  /** @param {Context} cx */
  openGallery(cx) {
    if (this.closed || this.confirming()) return
    try {
      cx.open_url(GALLERY_URL)
      this.noticeError = false
      this.notice = "Gallery link sent to your browser."
    } catch {
      this.noticeError = true
      this.notice = `Could not open the browser. Use the Gallery URL: ${GALLERY_URL}`
    }
    cx.notify()
  }

  migrationStatus() {
    const t = colors()
    const migration = this.session.migration
    return v_flex()
      .id("migration-status")
      .gap(8)
      .flex_none()
      .child(
        text(
          migration?.blocked
            ? "Ownership migration is blocked."
            : "Ownership migration is required.",
          13,
          t.blocked,
        ),
      )
      .child(
        text(
          migration?.reason ||
            "Browsing is read-only until you explicitly confirm ownership migration. No migration runs on load.",
          11,
          t.muted,
        ),
      )
      .child(
        this.button(
          "review-migration",
          "Review migration",
          "shield",
          (cx) => {
            if (this.busy() || this.confirming()) return
            try {
              this.session.requestMigration()
              this.notice = ""
            } catch (error) {
              this.reportError(error)
            }
            cx.notify()
          },
          this.busy() || this.confirming() || Boolean(migration?.blocked) || !migration?.required,
        ),
      )
  }

  migrationConfirmation() {
    const t = colors()
    const target = this.session.migrationConfirmation
    const pending = this.busy()
    return scrollArea(
      "migration-confirmation-content",
      v_flex()
        .gap(16)
        .child(text("Confirm ownership migration", 22).font_semibold())
        .child(
          text(
            "This changes manager ownership metadata and locking. Mod files, existing Git checkouts and history are retained. Do not run an older manager against migrated data.",
            12,
            t.blocked,
          ),
        )
        .child(
          text(
            "Review every target. Cancel makes no changes. Migration does not prove that running copies have stopped.",
            12,
            t.muted,
          ),
        )
        .children(
          target.summary.targets.map((item) =>
            v_flex()
              .gap(5)
              .p(12)
              .bg(t.surface)
              .child(
                text(
                  `Name: ${this.session.list("installed").find((mod) => mod.modName === item.id)?.name || item.id}`,
                  13,
                ),
              )
              .child(text(`Folder: ${item.id}`, 11))
              .child(text(`Path: ${item.path}`, 11))
              .child(text(`Source: ${item.repository || "Unknown"}`, 11))
              .child(text(`Kind: ${item.kind}`, 11)),
          ),
        )
        .when(Boolean(this.session.migration?.reason), (element) =>
          element.child(text(this.session.migration.reason, 11, t.blocked)),
        )
        .child(
          h_flex()
            .gap(10)
            .child(
              this.button(
                "cancel-migration",
                "Cancel",
                "arrow",
                (cx) => {
                  if (this.busy() || this.session.migrationConfirmation !== target) return
                  this.session.cancelMigration()
                  this.notice = ""
                  cx.notify()
                },
                pending,
              ),
            )
            .child(
              this.button(
                "confirm-migration",
                "Confirm migration",
                "shield",
                (cx) => {
                  if (this.session.migrationConfirmation !== target) return
                  this.perform(
                    () => this.session.confirmMigration(),
                    cx,
                    true,
                    PROGRESS_LABELS.migrate,
                  )
                },
                pending || Boolean(this.session.migration?.blocked),
              ),
            ),
        ),
    ).id("migration-confirmation")
  }

  confirmation() {
    const t = colors()
    const target = this.session.confirmation
    const pending = this.busy()
    const archive = target.kind === "git"
    return scrollArea(
      "confirmation-content",
      v_flex()
        .gap(18)
        .py(20)
        .child(badge("CONFIRM FILE REMOVAL", t.blocked))
        .child(text(`Uninstall ${target.name}?`, 22).font_semibold())
        .child(
          text(
            archive
              ? "This removes the checkout from mods and archives the complete Git checkout and history. The archive is retained, not deleted."
              : "This permanently removes the verified mod folder. This operation is irreversible and is not automatically undone.",
            12,
            t.blocked,
          ),
        )
        .child(
          v_flex()
            .p(18)
            .gap(10)
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(text(target.name, 14).font_semibold())
            .child(text(`Verified absolute path: ${target.path}`, 12))
            .when(archive, (element) =>
              element.child(text(`Retained Git archive: ${target.archivePath}`, 12, t.blocked)),
            )
            .when(Boolean(target.commit), (element) =>
              element.child(text(`Installed commit: ${target.commit}`, 11, t.muted)),
            ),
        )
        .child(
          text(
            "The manager checks the target again before removal. Removing files does not prove that running copies have stopped.",
            12,
            t.muted,
          ),
        )
        .child(
          h_flex()
            .gap(10)
            .justify_end()
            .child(
              this.button(
                "cancel-uninstall",
                "Cancel",
                "arrow",
                (cx) => {
                  if (this.busy() || this.session.confirmation !== target) return
                  this.session.cancelUninstall()
                  this.notice = ""
                  cx.notify()
                },
                pending,
              ),
            )
            .child(
              this.button(
                "confirm-uninstall",
                "Uninstall",
                "close",
                (cx) => {
                  if (this.session.confirmation !== target) return
                  this.perform(
                    () => this.session.confirmUninstall(),
                    cx,
                    true,
                    PROGRESS_LABELS.uninstall,
                  )
                },
                pending,
              ).text_color(t.blocked),
            ),
        ),
    ).id("uninstall-confirmation")
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
          .child(div().flex_1())
          .child(text("Herdr extensions, in one place.", 11, t.dim))
          .when(Boolean(overlay), (element) =>
            element.child(
              this.button("close-manager", "Close", "close", () => {
                this.close()
                closeOverlay(overlay)
              }),
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
              .when(Boolean(this.session.pending || this.operationQueued), (element) =>
                element.child(
                  text(
                    this.session.pending
                      ? PROGRESS_LABELS[this.session.pending.action]
                      : this.queuedProgress,
                    12,
                    t.accent,
                  )
                    .id("operation-progress")
                    .flex_none(),
                ),
              )
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
              .when(Boolean(this.session.galleryError), (element) =>
                element.child(
                  text(`Gallery error: ${this.session.galleryError}`, 11, t.blocked)
                    .id("gallery-error")
                    .flex_none(),
                ),
              )
              .when(Boolean(this.session.discoveryError), (element) =>
                element.child(
                  text(
                    `Installed-mod discovery error: ${this.session.discoveryError}`,
                    11,
                    t.blocked,
                  )
                    .id("discovery-error")
                    .flex_none(),
                ),
              )
              .when(this.mutationBlocked(), (element) => element.child(this.migrationStatus()))
              .children(
                this.session.warnings.map((warning) => text(warning, 11, t.blocked).flex_none()),
              )
              .child(
                this.session.confirmation
                  ? this.confirmation()
                  : this.session.migrationConfirmation
                    ? this.migrationConfirmation()
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
          .child(
            text("Installation state does not indicate whether a mod is running.", 10, t.muted),
          )
          .child(div().flex_1()),
      )
  }
}
