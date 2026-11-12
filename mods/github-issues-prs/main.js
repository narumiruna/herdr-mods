import { Button, h_flex, Input, InputState, Scrollbar, TextView, v_flex } from "gpui-base"
import { div, svg, View } from "gpui-kit"
import { exec, focused, panes, props, spaces, theme, window } from "herdr"
import {
  age,
  checkedItem,
  checkedList,
  createGitHub,
  detailArgs,
  LIMIT,
  listArgs,
  repositoryFromRemote,
  repositoryName,
  safeFailure,
  stateLabel,
  withDeadline,
} from "./github.js"
import { TabBar } from "./tabs.js"

const workspaceId = () => spaces().find((space) => space.active)?.id ?? null

export default class GitHubIssuesPRs extends View {
  init(initialProps, cx) {
    const options = initialProps ?? props()
    this.closed = false
    if (options?.tabs === true) {
      this.tabBar = new TabBar()
      return
    }
    this.platform = window()?.platform || ""
    this.clients = new Map()
    this.repository = ""
    this.pinned = Boolean(options?.repo)
    this.pendingCommands = new Set()
    this.panelHandle = cx.focus_handle()
    this.tabHandles = { issue: cx.focus_handle(), pr: cx.focus_handle() }
    this.lastTerminals = new Map()
    this.pendingContext = null
    this.followTimer = null
    this.resultKey = null
    this.resultAt = 0
    this.kind = "issue"
    this.state = "open"
    this.search = ""
    this.filters = {
      issue: { state: "open", search: "", draft: "" },
      pr: { state: "open", search: "", draft: "" },
    }
    this.items = []
    this.selected = null
    this.detail = null
    this.detailPending = false
    this.error = ""
    this.errorRecovery = ""
    this.notice = ""
    this.detailError = ""
    this.detailRecovery = ""
    this.loading = false
    this.phase = ""
    this.request = 0
    this.detailRequest = 0
    this.searchInput = InputState.new({ placeholder: "Search…" })
    this.searchInput.on("submit", (_event, cx) => this.submitSearch(cx))
    this.searchInput.on("change", (_event, cx) => cx.notify())
    this.pinnedMachine = this.pinned ? this.location().on : null
    this.queryMachine = this.cliMachine()
    this.client = this.clientFor(this.queryMachine)
    if (this.pinned) {
      try {
        this.repository = repositoryName(options.repo)
      } catch (error) {
        this.error = error.message
        this.loadedContext = this.context()
        return
      }
    }
    this.refresh(cx)
    this.refreshTimer = cx.timer.every(120000, (cx) => {
      if (!this.closed && !this.loading) this.refresh(cx, false)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.tabBar) return
    this.request++
    this.detailRequest++
    this.cancelFollow()
    this.refreshTimer?.cancel()
    for (const cancel of this.pendingCommands) cancel()
    this.searchInput.release()
    this.panelHandle.release()
    for (const handle of Object.values(this.tabHandles)) handle.release()
    this.clients.clear()
    this.lastTerminals.clear()
  }

  location() {
    const space = spaces().find((space) => space.active)
    const focus = focused()
    const tabs = space?.tabs ?? []
    const ids = new Set(tabs.map((tab) => tab.id))
    const tab =
      tabs.find((tab) => tab.active)?.id ?? (ids.has(focus?.tab) ? focus.tab : tabs[0]?.id)
    const terminals = panes().filter((pane) => ids.has(pane.tab) && pane.cwd && !pane.mod)
    const inTab = terminals.filter((pane) => pane.tab === tab)
    const pane =
      inTab.find(
        (pane) =>
          pane.pane === focus?.pane || (focus?.terminal && pane.terminal === focus.terminal),
      ) ||
      inTab.find((pane) => pane.focused) ||
      inTab.find((pane) => pane.pane === this.lastTerminals.get(tab)) ||
      inTab[0] ||
      terminals[0]
    if (pane?.pane) this.lastTerminals.set(pane.tab, pane.pane)
    return { cwd: pane?.cwd || space?.folder || "", on: space?.machine ?? null }
  }

  cliMachine() {
    return this.pinned ? this.pinnedMachine : this.location().on
  }

  clientFor(machine) {
    if (!this.clients.has(machine))
      this.clients.set(machine, createGitHub(exec, this.platform, machine))
    return this.clients.get(machine)
  }

  context() {
    return this.pinned
      ? JSON.stringify([null, this.repository, this.pinnedMachine])
      : JSON.stringify([workspaceId(), this.location()])
  }

  cancelFollow() {
    this.followTimer?.cancel()
    this.followTimer = null
    this.pendingContext = null
  }

  follow(cx) {
    if (this.closed) return
    const context = this.context()
    if (context === this.loadedContext) {
      this.cancelFollow()
      if (
        !this.loading &&
        this.selected &&
        !this.detail &&
        !this.detailError &&
        !this.detailPending
      )
        this.pick(this.selected, cx, true)
      return
    }
    if (context === this.pendingContext) return
    this.cancelFollow()
    this.pendingContext = context
    this.followTimer = cx.timer.after(200, (cx) => {
      this.followTimer = null
      this.pendingContext = null
      this.refresh(cx, false, true)
      cx.notify()
    })
  }

  clearData() {
    this.updated = null
    this.items = []
    this.selected = null
    this.detail = null
    this.detailPending = false
    this.detailError = ""
    this.detailRecovery = ""
    this.resultKey = null
  }

  selectKind(kind, cx) {
    if (this.kind === kind) return
    this.filters[this.kind] = {
      state: this.state,
      search: this.search,
      draft: this.searchInput.value(),
    }
    this.kind = kind
    const filter = this.filters[kind]
    this.state = filter.state
    this.search = filter.search
    this.searchInput.set_value(filter.draft)
    this.refresh(cx)
  }

  selectState(state, cx) {
    if (this.state === state) return
    this.state = state
    this.refresh(cx)
  }

  submitSearch(cx) {
    this.search = this.searchInput.value().trim()
    this.refresh(cx)
  }

  clearSearch(cx) {
    this.searchInput.set_value("")
    this.search = ""
    this.refresh(cx)
  }

  noRepository(message) {
    this.clearData()
    this.repository = ""
    this.notice = message
  }

  back(cx) {
    this.detailRequest++
    this.detailPending = false
    this.selected = null
    this.detail = null
    this.detailError = ""
    this.detailRecovery = ""
    cx.notify()
  }

  execute(command, args, options, cx) {
    const target = options.on || "this computer"
    return withDeadline(
      cx.timer,
      options.timeout + 2000,
      () => {
        if (this.closed) throw new Error("Request cancelled.")
        return exec(command, args, options)
      },
      `${command} timed out on ${target}. Check the connection and select Refresh.`,
      this.pendingCommands,
    )
  }

  read(args, cx, current, machine = this.queryMachine) {
    const client = this.clientFor(machine)
    const target = machine || "this computer"
    return client.read(args, (command, argv, options) => {
      if (!current()) throw new Error("Request replaced.")
      const transport = command === "wsl.exe" ? "WSL gh" : "gh"
      this.phase = argv.includes("--version")
        ? `Finding GitHub CLI on ${target} with ${transport}…`
        : `Loading from GitHub with ${client.transport} on ${target}…`
      cx.notify()
      return this.execute(command, argv, options, cx)
    })
  }

  refresh(cx, clear = true, follow = false) {
    if (this.closed) return
    this.cancelFollow()
    const machine = this.cliMachine()
    if (machine !== this.queryMachine) {
      clear = true
      if (!this.pinned) this.repository = ""
    }
    this.queryMachine = machine
    this.client = this.clientFor(machine)
    const context = this.context()
    const contextChanged = context !== this.loadedContext
    if (contextChanged && !follow) clear = true
    this.loadedContext = context
    const request = ++this.request
    const detailRequest = clear || contextChanged ? ++this.detailRequest : this.detailRequest
    if (clear || contextChanged) this.detailPending = false
    const kind = this.kind
    const state = this.state
    const search = this.search
    const place = this.location()
    const pinned = this.pinned
    let repository = this.repository
    let resolved = pinned
    this.loading = true
    this.phase = pinned
      ? "Loading from GitHub with " +
        this.client.transport +
        " on " +
        (machine || "this computer") +
        "…"
      : `Reading origin on ${place.on || "this machine"}…`
    this.error = ""
    this.errorRecovery = ""
    this.notice = ""
    if (clear) this.clearData()
    const current = () => !this.closed && request === this.request && context === this.context()
    cx.spawn(async (cx) => {
      try {
        if (!current()) return
        cx.notify()
        if (!pinned) {
          if (!place.cwd) {
            this.noRepository("No terminal folder is available.")
            return
          }
          const result = await this.execute(
            "git",
            ["remote", "get-url", "origin"],
            { ...place, timeout: 10000 },
            cx,
          )
          if (!current()) return
          if (result.code !== 0) {
            const message = (result.stderr || result.stdout || "No origin remote.").trim()
            if (/not a git repository|no such remote|no origin remote/i.test(message)) {
              this.noRepository("The focused terminal folder has no GitHub origin.")
              return
            }
            throw new Error(
              "Cannot read origin on " +
                (place.on || "this computer") +
                ": " +
                message.slice(0, 1000),
            )
          }
          try {
            repository = repositoryFromRemote(result.stdout)
          } catch (error) {
            this.noRepository(error.message)
            return
          }
          resolved = true
        }
        if (!current()) return
        if (repository.toLowerCase() !== this.repository.toLowerCase()) {
          this.detailRequest++
          this.clearData()
        }
        this.repository = repository
        const key = JSON.stringify([machine, repository.toLowerCase(), kind, state, search])
        if (follow && key === this.resultKey && Date.now() - this.resultAt < 120000) {
          if (this.selected && !this.detail) this.pick(this.selected, cx, true)
          return
        }
        this.phase =
          "Loading from GitHub with " +
          this.client.transport +
          " on " +
          (machine || "this computer") +
          "…"
        cx.notify()
        const items = await this.read(
          listArgs(repository, kind, state, search),
          cx,
          current,
          machine,
        )
        if (!current()) return
        this.items = checkedList(items)
        this.resultKey = key
        this.resultAt = Date.now()
        const now = new Date()
        this.updated = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
        if (this.selected && !items.some((item) => item.number === this.selected.number)) {
          this.detailRequest++
          this.detailPending = false
          this.detailError = ""
          this.detailRecovery = ""
          this.selected = null
          this.detail = null
        } else if (this.selected && detailRequest === this.detailRequest) {
          this.pick(
            items.find((item) => item.number === this.selected.number),
            cx,
            true,
          )
        }
      } catch (error) {
        if (current()) {
          if (contextChanged && !resolved) {
            this.clearData()
            if (!pinned) this.repository = ""
          }
          const failure = safeFailure(error)
          this.error = failure.message
          this.errorRecovery = failure.recovery
        }
      } finally {
        if (!this.closed && request === this.request) {
          this.loading = false
          if (context !== this.context()) this.loadedContext = null
          cx.notify()
        }
      }
    })
  }

  pick(item, cx, background = false) {
    if (this.closed) return
    const request = ++this.detailRequest
    const context = this.context()
    const repository = this.repository
    const kind = this.kind
    const machine = this.queryMachine
    this.selected = item
    this.detailPending = true
    if (!background) this.detail = null
    this.detailError = ""
    this.detailRecovery = ""
    const current = () =>
      !this.closed && request === this.detailRequest && context === this.context()
    cx.spawn(async (cx) => {
      try {
        const detail = await this.read(
          detailArgs(repository, kind, item.number),
          cx,
          current,
          machine,
        )
        if (current()) this.detail = checkedItem(detail, item.number)
      } catch (error) {
        if (current()) {
          const failure = safeFailure(error)
          this.detailError = failure.message
          this.detailRecovery = failure.recovery
        }
      } finally {
        if (!this.closed && request === this.detailRequest) {
          this.detailPending = false
          cx.notify()
        }
      }
    })
    if (!background) cx.notify()
  }

  icon(name, size = 16) {
    return svg(`mods/github-issues-prs/icons/${name}.svg`).size(size).flex_none()
  }

  button(id, content, active, action, t) {
    return Button.new(id)
      .tab_stop(true)
      .h(28)
      .px(9)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color("#00000000")
      .focus((style) => style.border_color(t.accent))
      .bg(active ? t.selected : "#00000000")
      .text_color(active ? t.foreground : t.muted)
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => action(cx))
      .child(content)
  }

  iconButton(id, name, label, action, t) {
    return this.button(id, this.icon(name), false, action, t)
      .w(30)
      .h(30)
      .px(0)
      .accessibility_label(label)
      .tooltip(label)
  }

  statusColor(item, t) {
    const state = stateLabel(item)
    return state === "Merged"
      ? t.ansi5
      : state === "Closed"
        ? t.ansi1
        : state === "Draft"
          ? t.dim
          : t.ansi2
  }

  status(item, t) {
    return div()
      .flex_none()
      .px(6)
      .py(1)
      .rounded(4)
      .bg(t.raised)
      .text_size(11)
      .text_color(this.statusColor(item, t))
      .child(stateLabel(item))
  }

  typeLabel() {
    return this.kind === "pr" ? "Pull Requests" : "Issues"
  }

  updatedLabel(date) {
    const time = age(date)
    return time === "now" ? "Updated just now" : time ? `Updated ${time} ago` : "Updated recently"
  }

  header(t) {
    const place = this.location()
    const source = this.pinned
      ? `Pinned repository on ${this.pinnedMachine || "this computer"}`
      : `Follows the focused terminal on ${place.on || "this computer"}\n${place.cwd}`
    const cli = `${this.client.transport} on ${this.queryMachine || "this computer"}`
    return h_flex()
      .h(56)
      .flex_none()
      .px(14)
      .gap(12)
      .items_center()
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().font_semibold().text_size(14).child("GitHub Issues & PRs"))
          .child(
            div()
              .id("github-repo")
              .w_full()
              .truncate()
              .text_size(11)
              .text_color(t.muted)
              .tooltip(
                `${(this.repository ? `${this.repository}\n` : "") + source}\nGitHub CLI: ${cli}`,
              )
              .child(this.repository || "Follows the focused terminal"),
          ),
      )
      .child(
        this.button(
          "github-refresh",
          this.icon("refresh").when(this.loading, (icon) => icon.spin(900)),
          false,
          (cx) => this.refresh(cx, false),
          t,
        )
          .w(30)
          .h(30)
          .px(0)
          .disabled(this.loading)
          .accessibility_label("Refresh")
          .tooltip("Refresh · automatic refresh every 2 minutes"),
      )
  }

  tabs(t) {
    return h_flex()
      .id("github-tabs")
      .role("tab_list")
      .accessibility_label("GitHub item type")
      .h(40)
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .px(8)
      .gap(4)
      .children(
        [
          ["issue", "Issues"],
          ["pr", "Pull Requests"],
        ].map(([kind, label], index) => {
          const active = this.kind === kind
          return Button.new(`github-tab-${kind}`)
            .role("tab")
            .selected(active)
            .set_position(index + 1, 2)
            .accessibility_label(label)
            .track_focus(this.tabHandles[kind])
            .tab_stop(active)
            .flex_1()
            .min_w(0)
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .gap(7)
            .px(10)
            .text_size(12)
            .font_medium()
            .text_color(active ? t.foreground : t.muted)
            .border_b(2)
            .border_color(active ? t.accent : "#00000000")
            .cursor_pointer()
            .hover((style) => style.bg(t.hover))
            .focus((style) => style.bg(t.hover))
            .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
            .on_click((_event, cx) => this.selectKind(kind, cx))
            .on_key_down((event, cx) => {
              if (
                Object.values(event.modifiers ?? {}).some(Boolean) ||
                !["left", "right", "home", "end"].includes(event.key)
              )
                return
              const next =
                event.key === "home"
                  ? "issue"
                  : event.key === "end"
                    ? "pr"
                    : kind === "issue"
                      ? "pr"
                      : "issue"
              this.selectKind(next, cx)
              this.tabHandles[next].focus()
              cx.stop_propagation()
            })
            .child(this.icon(kind === "pr" ? "pull-request" : "issue", 15))
            .child(label)
        }),
      )
  }

  controls(t) {
    const noun = this.kind === "pr" ? "pull requests" : "issues"
    const count = this.resultKey
      ? `${this.items.length + (this.items.length >= LIMIT ? "+" : "")} ${noun}`
      : ""
    return v_flex()
      .flex_none()
      .px(12)
      .pt(10)
      .pb(8)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .id("github-search")
              .h(32)
              .flex_1()
              .min_w(0)
              .px(10)
              .flex()
              .items_center()
              .tooltip(
                "Press Enter to search. Supports label:bug, author:@me, and other GitHub qualifiers.",
              )
              .bg(t.canvas)
              .rounded(7)
              .border_1()
              .border_color(t.input)
              .cursor_text()
              .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
              .child(
                Input.new(this.searchInput)
                  .h_full()
                  .w_full()
                  .text_size(12)
                  .text_color(t.foreground)
                  .accessibility_label(`Search ${noun}`),
              ),
          )
          .when(Boolean(this.search || this.searchInput.value()), (element) =>
            element.child(
              this.iconButton(
                "github-reset-search",
                "win-close",
                "Clear search",
                (cx) => this.clearSearch(cx),
                t,
              ),
            ),
          )
          .child(
            this.iconButton(
              "github-find",
              "search",
              `Search ${noun} (Enter)`,
              (cx) => this.submitSearch(cx),
              t,
            ),
          ),
      )
      .when(this.searchInput.value().trim() !== this.search, (element) =>
        element.child(
          div()
            .id("github-search-draft")
            .text_size(11)
            .text_color(t.muted)
            .truncate()
            .tooltip(`Applied search: ${this.search || "all items"}`)
            .child(`Showing: ${this.search || "all items"}. Press Enter to apply search.`),
        ),
      )
      .child(
        h_flex()
          .h(26)
          .gap(6)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(count))
          .children(
            ["open", "closed", "all"].map((state) =>
              this.button(
                `github-state-${state}`,
                state[0].toUpperCase() + state.slice(1),
                state === this.state,
                (cx) => this.selectState(state, cx),
                t,
              )
                .h(26)
                .px(8)
                .text_size(11)
                .selected(state === this.state)
                .tooltip(
                  state === "closed" && this.kind === "pr"
                    ? "Closed and merged pull requests"
                    : state[0].toUpperCase() + state.slice(1),
                ),
            ),
          ),
      )
  }

  list(t) {
    return div()
      .flex_1()
      .min_h(0)
      .relative()
      .child(
        v_flex()
          .id("github-list")
          .absolute()
          .inset_0()
          .overflow_y_scroll()
          .children(
            this.items.map((item) =>
              Button.new(`github-item-${item.number}`)
                .tab_stop(true)
                .w_full()
                .min_w(0)
                .flex_none()
                .flex()
                .items_start()
                .text_left()
                .px(14)
                .py(12)
                .gap(10)
                .border_b(1)
                .border_color(t.border)
                .cursor_pointer()
                .hover((style) => style.bg(t.hover))
                .focus((style) => style.bg(t.selected))
                .accessibility_label(`${item.title}, ${stateLabel(item)}, number ${item.number}`)
                .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
                .on_click((_event, cx) => this.pick(item, cx))
                .child(
                  this.icon(this.kind === "pr" ? "pull-request" : "issue", 16)
                    .mt(2)
                    .text_color(this.statusColor(item, t)),
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(7)
                    .child(div().w_full().min_w(0).text_size(13).font_medium().child(item.title))
                    .child(
                      h_flex()
                        .w_full()
                        .gap(7)
                        .items_center()
                        .text_size(11)
                        .text_color(t.muted)
                        .child(this.status(item, t))
                        .child(div().flex_none().text_color(t.dim).child(`#${item.number}`))
                        .child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .child(item.author?.login || "ghost"),
                        )
                        .child(
                          div()
                            .flex_none()
                            .text_color(t.dim)
                            .tooltip(item.updatedAt || "")
                            .child(age(item.updatedAt)),
                        ),
                    ),
                ),
            ),
          )
          .when(this.items.length >= LIMIT, (element) =>
            element.child(
              div()
                .p(14)
                .text_size(11)
                .text_color(t.dim)
                .child("Showing up to 100 results. Narrow the search to find more."),
            ),
          ),
      )
      .child(Scrollbar.vertical("github-list").absolute().inset_0())
  }

  recoveryView(id, recovery, t) {
    return div()
      .id(id)
      .w_full()
      .whitespace_normal()
      .text_size(11)
      .text_color(t.muted)
      .child(recovery)
  }

  errorView(t, compact = false) {
    const title = `Could not load ${this.typeLabel().toLowerCase()}`
    const message = this.error.split("\n")[0]
    const recovery = this.errorRecovery
    const recoveryView = () =>
      this.recoveryView(compact ? "github-recovery-compact" : "github-recovery-help", recovery, t)
    if (compact)
      return h_flex()
        .flex_none()
        .p(10)
        .gap(8)
        .items_center()
        .bg(t.raised)
        .border_b(1)
        .border_color(t.border)
        .child(this.icon("alert").text_color(t.blocked))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(3)
            .child(div().font_medium().text_size(12).child(title))
            .child(
              div().truncate().text_size(11).text_color(t.muted).tooltip(this.error).child(message),
            )
            .when(Boolean(recovery), (element) => element.child(recoveryView())),
        )
        .child(this.button("github-retry", "Retry", false, (cx) => this.refresh(cx, false), t))
    return v_flex()
      .id("github-empty-error")
      .flex_1()
      .min_h(0)
      .p(24)
      .gap(10)
      .items_center()
      .justify_center()
      .child(this.icon("alert", 28).text_color(t.blocked))
      .child(div().font_semibold().text_size(14).text_center().child(title))
      .child(
        div()
          .w_full()
          .max_w(340)
          .text_size(12)
          .text_color(t.muted)
          .text_center()
          .child("Check GitHub CLI access, then retry."),
      )
      .child(
        div()
          .w_full()
          .max_w(340)
          .truncate()
          .text_size(11)
          .text_color(t.dim)
          .tooltip(this.error)
          .child(message),
      )
      .when(Boolean(recovery), (element) => element.child(recoveryView().max_w(340)))
      .child(
        this.button("github-retry", "Retry", false, (cx) => this.refresh(cx, false), t)
          .mt(6)
          .bg(t.raised),
      )
  }

  empty(t) {
    if (this.error) return this.errorView(t)
    const noun = this.kind === "pr" ? "pull requests" : "issues"
    const title = this.loading
      ? `Loading ${noun}…`
      : this.notice
        ? "No GitHub repository"
        : this.search
          ? `No matching ${noun}`
          : `No ${this.state === "all" ? "" : `${this.state} `}${noun}`
    const description = this.loading
      ? this.phase
      : this.notice
        ? `${this.notice} Focus a terminal in a GitHub repository to continue.`
        : this.search
          ? "Try a different search or state filter."
          : `There are no ${noun} to display for this filter.`
    return v_flex()
      .id("github-empty")
      .flex_1()
      .min_h(0)
      .p(24)
      .gap(10)
      .items_center()
      .justify_center()
      .child(
        this.icon(
          this.loading
            ? "refresh"
            : this.notice
              ? "repository"
              : this.kind === "pr"
                ? "pull-request"
                : "issue",
          28,
        )
          .text_color(t.dim)
          .when(this.loading, (icon) => icon.spin(900)),
      )
      .child(div().text_size(14).font_semibold().text_center().child(title))
      .child(
        div()
          .w_full()
          .max_w(330)
          .text_size(12)
          .text_color(t.muted)
          .text_center()
          .child(description),
      )
      .when(Boolean(this.search && !this.loading && !this.notice), (element) =>
        element.child(
          this.button("github-clear-search", "Clear search", false, (cx) => this.clearSearch(cx), t)
            .mt(6)
            .bg(t.raised),
        ),
      )
  }

  preview(t) {
    const item = this.detail || this.selected
    const body = this.detail?.body || "_No description._"
    const branch = `${item.headRefName || "?"} → ${item.baseRefName || "?"}`
    const review =
      {
        APPROVED: "Approved",
        CHANGES_REQUESTED: "Changes requested",
        REVIEW_REQUIRED: "Review required",
      }[item.reviewDecision] || "Not reviewed"
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .flex_none()
          .px(10)
          .py(6)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            this.button(
              "github-back",
              h_flex()
                .gap(7)
                .items_center()
                .child(this.icon("arrow-left", 14))
                .child(this.typeLabel()),
              false,
              (cx) => this.back(cx),
              t,
            ).accessibility_label(`Back to ${this.typeLabel().toLowerCase()}`),
          )
          .child(div().flex_1())
          .child(
            this.iconButton(
              "github-open-browser",
              "external",
              "Open on GitHub",
              (cx) => cx.open_url(item.url),
              t,
            ),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            v_flex()
              .id(`github-detail-${item.number}`)
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(16)
              .gap(12)
              .child(div().w_full().min_w(0).font_semibold().text_size(16).child(item.title))
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(this.status(item, t))
                  .child(div().text_size(12).text_color(t.dim).child(`#${item.number}`))
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(12)
                      .text_color(t.muted)
                      .child(`by ${item.author?.login || "ghost"}`),
                  ),
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .tooltip(item.updatedAt || "")
                  .child(this.updatedLabel(item.updatedAt)),
              )
              .when(Boolean(item.labels?.length), (element) =>
                element.child(
                  h_flex()
                    .flex_wrap()
                    .gap(5)
                    .children(
                      item.labels.map((label) =>
                        div()
                          .px(7)
                          .py(3)
                          .rounded(5)
                          .bg(t.raised)
                          .text_size(11)
                          .text_color(t.muted)
                          .child(label.name),
                      ),
                    ),
                ),
              )
              .when(this.kind === "pr", (element) =>
                element.child(
                  v_flex()
                    .gap(8)
                    .p(10)
                    .rounded(7)
                    .bg(t.canvas)
                    .child(
                      div()
                        .truncate()
                        .tooltip(branch)
                        .text_size(12)
                        .text_color(t.accent)
                        .child(branch),
                    )
                    .child(div().text_size(11).text_color(t.muted).child(review))
                    .when(Boolean(this.detail), (content) =>
                      content.child(
                        h_flex()
                          .gap(9)
                          .text_size(11)
                          .child(div().text_color(t.muted).child(`${item.changedFiles} files`))
                          .child(div().text_color(t.ansi2).child(`+${item.additions}`))
                          .child(div().text_color(t.ansi1).child(`−${item.deletions}`)),
                      ),
                    ),
                ),
              )
              .when(Boolean(this.detailError), (element) =>
                element.child(
                  v_flex()
                    .gap(8)
                    .p(10)
                    .rounded(7)
                    .bg(t.raised)
                    .child(
                      div()
                        .text_size(12)
                        .text_color(t.blocked)
                        .child("Could not load the description"),
                    )
                    .child(
                      div()
                        .truncate()
                        .text_size(11)
                        .text_color(t.muted)
                        .tooltip(this.detailError)
                        .child(this.detailError.split("\n")[0]),
                    )
                    .when(Boolean(this.detailRecovery), (element) =>
                      element.child(
                        this.recoveryView("github-detail-recovery", this.detailRecovery, t),
                      ),
                    )
                    .child(
                      this.button(
                        "github-detail-retry",
                        "Retry description",
                        false,
                        (cx) => this.pick(this.selected, cx),
                        t,
                      ),
                    ),
                ),
              )
              .when(!this.detail && !this.detailError, (element) =>
                element.child(
                  h_flex()
                    .gap(8)
                    .items_center()
                    .py(12)
                    .text_color(t.muted)
                    .child(this.icon("refresh", 14).spin(900))
                    .child(div().child("Loading description…")),
                ),
              )
              .when(Boolean(this.detail), (element) =>
                element
                  .child(
                    TextView.markdown(`github-body-${item.number}`, body.slice(0, 80000))
                      .w_full()
                      .scrollable(false)
                      .selectable(true)
                      .on_link_click((url, cx) => {
                        if (/^https?:\/\//i.test(url)) cx.open_url(url)
                      }),
                  )
                  .when(body.length > 80000, (content) =>
                    content.child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child("Description truncated. Open on GitHub for the full text."),
                    ),
                  ),
              ),
          )
          .child(Scrollbar.vertical(`github-detail-${item.number}`).absolute().inset_0()),
      )
  }

  footer(t) {
    const status = this.loading
      ? this.phase
      : this.detailPending
        ? "Loading description…"
        : this.updated
          ? `Updated ${this.updated}`
          : this.pinned
            ? "Pinned repository"
            : "Follows the focused terminal"
    return h_flex()
      .id("github-status")
      .role("status")
      .h(28)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(10)
      .text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(status))
      .child(
        div()
          .flex_none()
          .tooltip(
            "Automatic refresh every 2 minutes · " +
              this.client.transport +
              " on " +
              (this.queryMachine || "this computer"),
          )
          .child(`${this.client.transport} on ${this.queryMachine || "this computer"}`),
      )
  }

  render(cx) {
    if (this.tabBar) return this.tabBar.render()
    this.follow(cx)
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme())
    return v_flex()
      .id("github")
      .size_full()
      .min_w(0)
      .min_h(0)
      .overflow_hidden()
      .rounded(10)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      .track_focus(this.panelHandle)
      .on_key_down((event, cx) => {
        if (event.key === "escape" && this.selected) {
          this.back(cx)
          cx.stop_propagation()
        }
      })
      .child(this.header(t))
      .child(this.tabs(t))
      .when(!this.selected && !this.notice, (element) => element.child(this.controls(t)))
      .when(Boolean(this.error && (this.items.length || this.selected)), (element) =>
        element.child(this.errorView(t, true)),
      )
      .child(this.selected ? this.preview(t) : this.items.length ? this.list(t) : this.empty(t))
      .child(this.footer(t))
  }
}
