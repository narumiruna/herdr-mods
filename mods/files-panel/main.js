// A lazy file browser for the focused pane's folder, with bounded read-only previews.

import { Editor, EditorState, h_flex, v_flex } from "gpui-base"
import { div, svg, View } from "gpui-kit"
import {
  exec,
  focused,
  panes,
  props,
  readTextFile,
  settings,
  spaces,
  theme,
  watchFolder,
  window,
} from "herdr"
import { FileActions, openFileMenu } from "./file-actions.js"

/** @typedef {import('gpui-kit').Context} Context */
/** @typedef {{key: string, cwd: string | null | undefined, on: string | null}} LocationContext */
/** @typedef {{name: string, dir: boolean}} Entry */
/** @typedef {Record<string, import('gpui-kit').Color>} Palette */

function location() {
  const space = spaces().find((s) => s.active)
  const f = focused()
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null)
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id }
}
const key = () => JSON.stringify(location())
/** @type {Record<string, string>} */
const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
}
const PER_FOLDER = 500
const TOTAL = 5000

/** @param {string} path @param {string | null} on @returns {Promise<Entry[]>} */
async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" +
          path.replace(/['‘’‚‛]/g, "$&$&") +
          "'",
      ],
      { on },
    )
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder")
    const result = JSON.parse(r.stdout || "[]")
    return Array.isArray(result) ? result : [result]
  }
  if (!on && window()?.platform === "windows") return windowsDirectory()
  const script = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"`
  let r
  try {
    r = await exec("sh", ["-c", script, "files", path], { on })
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory()
    throw e
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder")
  const fields = r.stdout.split("\0")
  const out = []
  for (let i = 0; i + 1 < fields.length; i += 2)
    out.push({ name: fields[i + 1], dir: fields[i] === "d" })
  return out
}

export default class Files extends View {
  /** @param {import('gpui-shell').Props} _props @param {import('gpui-kit').AsyncContext} cx */
  init(_props, cx) {
    const p = props()
    this.actions = null
    if (p?.target && (p.fileAction === "menu" || p.fileAction === "trash")) {
      this.actions = new FileActions(p, cx)
      return
    }
    this.saved = new Map()
    /** @type {Map<string, Entry[]>} */
    this.entries = new Map()
    /** @type {Set<string>} */
    this.folders = new Set()
    this.pending = new Set()
    /** @type {import('herdr').FolderWatch | null} */
    this.folderWatch = null
    this.previewRequest = 0
    /** @type {Record<string, string>} */
    this.marks = {}
    this.refresh(cx)
    cx.timer.every(10000, (cx) => this.refresh(cx))
  }

  /** @param {string} root @param {Context} cx */
  watch(root, cx) {
    if (this.on || this.watched === root) return
    /** @type {string | null} */
    this.watched = root
    const context = this.context
    cx.spawn(async (cx) => {
      try {
        while (this.current(context)) {
          this.folderWatch = watchFolder(root)
          await this.folderWatch
          if (!this.current(context)) return
          this.folderWatch = null
          this.refresh(cx)
        }
      } catch {
        // The refresh timer still runs if the watch fails.
      } finally {
        if (this.context === context) {
          this.folderWatch = null
          this.watched = null
        }
      }
    })
  }

  /** @param {LocationContext} context */
  current(context) {
    return this.context === context && key() === context.key
  }

  /** @param {string} path @param {LocationContext} context */
  async loadFolder(path, context) {
    const { on, cwd: root } = context
    const entries = await directory(path ? `${root}/${path}` : root, on)
    if (!this.current(context) || (path && !this.folders.has(path))) return
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0)
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    )
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true
  }

  /** @param {Context} cx */
  refresh(cx) {
    const { cwd, on } = location()
    const next = key()
    if (next !== this.context?.key) {
      this.folderWatch?.cancel()
      this.folderWatch = null
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file })
      const saved = this.saved.get(next)
      /** @type {LocationContext} */
      this.context = { key: next, cwd, on }
      this.root = cwd
      this.on = on
      this.entries = new Map()
      this.folders = new Set(saved?.folders)
      this.pending = new Set()
      this.marks = {}
      this.show(null)
      this.watched = null
      this.error = null
      this.limited = false
      this.loading = false
      if (saved?.file) this.show(saved.file, cx)
    }
    if (!cwd || this.loading) return
    const context = this.context
    this.loading = true
    this.limited = false
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return
          if (path) {
            const slash = path.lastIndexOf("/")
            const parent = slash === -1 ? "" : path.slice(0, slash)
            const name = path.slice(slash + 1)
            // A folder moved to the Trash can still be in the expanded set.
            if (!this.entries.get(parent)?.some((entry) => entry.dir && entry.name === name)) {
              this.folders.delete(path)
              this.entries.delete(path)
              continue
            }
          }
          await this.loadFolder(path, context)
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(
          () => /** @type {null} */ (null),
        )
        /** @type {Record<string, string>} */
        const marks = {}
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "status",
              "--porcelain=v1",
              "-z",
              "--no-renames",
              "--untracked-files=all",
            ],
            { cwd, on },
          ).catch(() => /** @type {null} */ (null))
          if (status?.code === 0)
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2)
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                xy === "??" || xy.includes("A")
                  ? "A"
                  : xy.includes("U")
                    ? "U"
                    : xy.includes("D")
                      ? "D"
                      : "M"
            }
        }
        if (!this.current(context)) return
        this.marks = marks
        this.error = null
        this.watch(cwd, cx)
      } catch (e) {
        if (this.current(context)) this.error = String(e)
      } finally {
        if (this.context === context) this.loading = false
        cx.notify()
      }
    })
  }

  /** @param {string} path @param {Context} cx */
  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders])
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder)
          this.entries.delete(folder)
        }
    } else {
      this.folders.add(path)
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context
        this.pending.add(path)
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context)
          } catch (e) {
            if (this.current(context)) this.error = String(e)
          } finally {
            if (this.context === context) this.pending.delete(path)
            cx.notify()
          }
        })
      }
    }
    cx.notify()
  }

  /** @param {string | null} path @param {Context} [cx] */
  show(path, cx) {
    const request = ++this.previewRequest
    this.code?.release()
    this.code = null
    this.file = path
    this.fileError = null
    if (!path || !cx) return
    const context = this.context
    const root = this.root
    const on = this.on
    const isCurrent = () => request === this.previewRequest && this.current(context)
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on })
        if (!isCurrent()) return
        if (text === null) {
          this.fileError = "This file is no longer available"
          return
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview"
          return
        }
        const t = theme()
        const ext = path.includes(".") ? path.split(".").pop() : "txt"
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: text.length > 400000 ? `${text.slice(0, 400000)}\n… (file truncated)` : text,
          font_family: /** @type {string} */ (settings().font_family),
          font_size: 12,
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
      } catch {
        if (isCurrent())
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)"
      } finally {
        if (isCurrent()) cx.notify()
      }
    })
  }

  /** @param {string} prefix @param {number} depth @param {import('gpui-kit').Element[]} out @param {Palette} t */
  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out
    const context = this.context
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const open = this.folders.has(path)
      const mark = this.marks[`${this.root}/${path}`]
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation()
            if (context.cwd && this.current(context)) {
              openFileMenu({ root: context.cwd, path, on: context.on ?? null })
            }
          })
          .child(
            entry.dir
              ? svg(`mods/files-panel/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(
            svg(`mods/files-panel/${entry.dir ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(t.muted),
          )
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(
                  mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked,
                )
                .child(mark),
            ),
          ),
      )
      if (entry.dir && open) this.rows(path, depth + 1, out, t)
    }
    return out
  }

  /** @param {Context} cx */
  render(cx) {
    if (this.actions) {
      return this.actions.render()
    }
    if (key() !== this.context?.key) this.refresh(cx)
    const t = /** @type {Palette} */ (theme())
    return v_flex()
      .id("files")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.file), (el) =>
            el.child(
              div()
                .id("files-back")
                .w(20)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  this.show(null)
                  cx.notify()
                })
                .child("←"),
            ),
          )
          .child(div().font_semibold().child("Files"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(12)
              .text_color(t.dim)
              .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""),
          ),
      )
      .when(!this.file, (el) =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(
                    this.error ||
                      (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"),
                  ),
              ),
            )
            .when(this.limited, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(11)
                  .text_color(t.dim)
                  .child("File list limited to 500 entries per folder and 5,000 total"),
              ),
            ),
        ),
      )
      .when(Boolean(this.file), (el) =>
        el.child(
          this.code
            ? Editor.new(this.code).flex_1().min_h(0)
            : div()
                .p(12)
                .text_color(t.dim)
                .child(this.fileError || "Loading file…"),
        ),
      )
  }
}
