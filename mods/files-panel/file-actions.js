import { h_flex, v_flex } from "gpui-base"
import { div } from "gpui-kit"
import { closeOverlay, exec, notify, openOverlay, theme, window } from "herdr"

/** @typedef {{root: string, path: string, on?: (string|null)}} Target */
/** @typedef {import('gpui-kit').Context} Context */

const MOD = "files-panel"

// Resolve the parent without following symlinks outside the displayed tree.
// Leave the final component alone: a symlink itself can go to the Trash.
const TRASH = `
cd -P -- "$1" || exit 1
if [ -n "$2" ]; then
  expected="\${PWD%/}/$2"
  cd -P -- "./$2" || exit 1
  if [ "$PWD" != "$expected" ]; then
    printf '%s\\n' 'Cannot trash items inside a symlinked folder.' >&2
    exit 1
  fi
fi
exec /usr/bin/trash "\${PWD%/}/$3"
`

/** @param {Target} target */
function filePaths({ root, path, on }) {
  if ((!on && window()?.platform === "windows") || /^[a-z]:[\\/]|^\\\\/i.test(root)) {
    const relative = path.replaceAll("/", "\\")
    return { relative, absolute: `${root.replace(/[\\/]+$/, "")}\\${relative}` }
  }
  return { relative: path, absolute: `${root.replace(/\/+$/, "")}/${path}` }
}

/** @param {Target} target */
function canUseFinder({ root, path, on }) {
  return (
    !on &&
    window()?.platform === "macos" &&
    root.startsWith("/") &&
    !/[\0\uFFFD]/.test(root + path) &&
    path.split("/").every((part) => part && ![".", "..", ".git"].includes(part))
  )
}

/** @param {Target} target */
export function openFileMenu(target) {
  openOverlay({ mod: MOD, kind: "popup", width: 228, props: { fileAction: "menu", target } })
}

export class FileActions {
  /**
   * @param {{fileAction: 'menu'|'trash', target: Target, overlay: string}} props
   * @param {Context} cx
   */
  constructor({ fileAction, target, overlay }, cx) {
    this.mode = fileAction
    this.target = target
    this.overlay = overlay
    this.name = target.path.slice(target.path.lastIndexOf("/") + 1)
    this.paths = filePaths(target)
    this.local = canUseFinder(target)
    this.selected = 0
    this.busy = false
    this.focus = cx.focus_handle()
    this.focus.focus()
  }

  close() {
    closeOverlay(this.overlay)
  }

  /** @param {string} value @param {Context} cx */
  copy(value, cx) {
    cx.write_to_clipboard(value)
    this.close()
  }

  /**
   * @param {Context} cx
   * @param {() => Promise<import('herdr').ExecResult>} operation
   * @param {string} failure
   * @param {string=} success
   */
  perform(cx, operation, failure, success) {
    if (this.busy) {
      return
    }
    this.busy = true
    cx.notify()
    cx.spawn(async (cx) => {
      try {
        const result = await operation()
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "The item may no longer exist.")
        }
        if (success) {
          notify({ title: success, body: this.name, level: "success" })
        }
        this.close()
      } catch (error) {
        notify({ title: failure, body: String(error), level: "error" })
        this.busy = false
        cx.notify()
      }
    })
  }

  /** @param {Context} cx */
  trash(cx) {
    if (!canUseFinder(this.target)) {
      return
    }
    const { root, path } = this.target
    const slash = path.lastIndexOf("/")
    const parent = slash === -1 ? "" : path.slice(0, slash)
    this.perform(
      cx,
      () => exec("/bin/sh", ["-c", TRASH, MOD, root, parent, this.name]),
      "Could not move to Trash",
      "Moved to Trash",
    )
  }

  render() {
    return this.mode === "trash" ? this.confirmation() : this.menu()
  }

  menu() {
    const t = /** @type {Record<string, import('gpui-kit').Color>} */ (theme())
    const { relative, absolute } = this.paths
    /** @type {{label: string, run: (cx: Context) => void, danger?: boolean}[]} */
    const items = [
      { label: "Copy Name", run: (cx) => this.copy(this.name, cx) },
      { label: "Copy Relative Path", run: (cx) => this.copy(relative, cx) },
      { label: "Copy Absolute Path", run: (cx) => this.copy(absolute, cx) },
    ]
    if (this.local) {
      items.push({
        label: "Show in Finder",
        run: (cx) =>
          this.perform(
            cx,
            () => exec("/usr/bin/open", ["-R", absolute]),
            "Could not show in Finder",
          ),
      })
      items.push({
        label: "Move to Trash…",
        danger: true,
        run: () => {
          this.close()
          openOverlay({
            mod: MOD,
            kind: "dialog",
            width: 410,
            height: 176,
            props: { fileAction: "trash", target: this.target },
          })
        },
      })
    }
    return v_flex()
      .id("files-panel-menu")
      .role("menu")
      .track_focus(this.focus)
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .child(div().px(8).py(5).truncate().text_size(11).text_color(t.dim).child(this.name))
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.close()
        } else if (!this.busy && (e.key === "down" || e.key === "up")) {
          const step = e.key === "down" ? 1 : -1
          this.selected = (this.selected + step + items.length) % items.length
          cx.notify()
        } else if (!this.busy && e.key === "enter") {
          items[this.selected].run(cx)
        } else {
          return
        }
        cx.stop_propagation()
      })
      .children(
        items.map(({ label, run, danger }, i) =>
          v_flex()
            .when(Boolean(danger), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`files-action-${i}`)
                .role("menu_item")
                .h(29)
                .px(8)
                .rounded(6)
                .items_center()
                .cursor_pointer()
                .text_color(danger ? t.ansi1 : t.foreground)
                .when(i === this.selected, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  if (!this.busy) {
                    run(cx)
                  }
                })
                .child(label),
            ),
        ),
      )
  }

  confirmation() {
    const t = /** @type {Record<string, import('gpui-kit').Color>} */ (theme())
    return v_flex()
      .id("files-trash-confirmation")
      .track_focus(this.focus)
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("Move to Trash?"))
      .child(
        v_flex()
          .id("files-trash-path")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(5)
          .text_color(t.muted)
          .child(this.paths.absolute)
          .child("You can restore this item from the Trash."),
      )
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(
            h_flex()
              .id("files-trash-cancel")
              .role("button")
              .h(30)
              .px(10)
              .items_center()
              .rounded(6)
              .text_color(t.foreground)
              .bg(t.raised)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                if (!this.busy) {
                  this.close()
                }
              })
              .child("Cancel"),
          )
          .child(
            h_flex()
              .id("files-trash-confirm")
              .role("button")
              .h(30)
              .px(10)
              .items_center()
              .rounded(6)
              .bg(t.raised)
              .text_color(t.ansi1)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.trash(cx))
              .child(this.busy ? "Moving…" : "Move to Trash"),
          ),
      )
  }
}
