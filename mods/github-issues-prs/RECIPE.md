# GitHub Issues & PRs

Read GitHub issues and pull request descriptions in a Herdr side panel, tab, or
overlay. The panel follows the focused terminal's repository and machine, or
stays on a pinned repository. It does not change issues or pull requests.

![GitHub Issues & PRs preview](preview.png)

Use this brief to build the mod from an empty directory. The adjacent files
are one implementation. The preview shows the native list in a disposable
Herdr profile with a fictional repository, issues, and authors.

## What you see

- A view that fills its assigned block or tab, or opens in a 680 × 760 overlay.
  Use the theme background, a 1 px border, and 10 px rounded corners.
- A 56 px header shows the title, read-only repository name, and a 30 px refresh
  button. The repository tooltip shows where the data comes from.
- Below it, two 40 px tabs select Issues or Pull Requests. An accent underline
  marks the active tab. A 32 px search field, result count, and Open/Closed/All
  filters precede the scrolling list.
- Each row has an icon, 13 px wrapping title, and 11 px state, number, author,
  and update age. Use theme colors for states: green for Open, red for Closed,
  purple for Merged, and muted text for Draft. Keep the text labels in all themes.
- A detail view replaces the list and its controls. It has Back and Open on GitHub
  actions, a 16 px title, labels, Markdown description, and, for pull requests,
  source and target branches, review status, and change counts.
- Loading, no repository, no results, operational error, and retry states.
  Existing results remain visible after a background failure. Show machine-specific
  authentication recovery as wrapped visible text in list and detail errors, not
  only a hover tooltip. Generate help from the request's machine and CLI transport;
  do not treat CLI output as recovery instructions.
- A 28 px footer shows loading or update status and the machine and GitHub CLI
  transport in use.
- The optional workspace tab bar adds a GitHub panel button beside the available
  Files and Changes buttons. A working agent shows a spinning icon; blocked and
  done agents show a dot in the applicable theme color. Idle adds no indicator.

## How it behaves

- Determine the active space and tab, then use its focused or remembered terminal,
  first terminal, workspace terminal, or default folder. Read `origin` with Git.
  Accept github.com HTTPS and SSH origins; explain unsupported or missing origins.
- Debounce focus changes by 200 ms. Keep same-machine content while resolving the
  new origin. Keep same-repository results for up to two minutes. Clear old data
  on a machine/repository change; ignore stale list and detail responses.
- Query with `gh issue/pr list/view`, argv arrays, explicit repository and machine,
  and bounded command deadlines. Cache completed CLI discovery per machine.
- Refresh every two minutes or on request. Keep each type's independent state,
  applied search, and draft. Enter applies search. Show a hint for unapplied edits;
  Clear search resets the draft and applied query.
- Select a result to load its description. Back or Escape returns to the list.
  Open on GitHub opens an HTTPS github.com issue/PR URL only after activation.
  Markdown links allow only HTTP/HTTPS.
- Type tabs use unmodified Left/Right/Home/End. Buttons support keyboard activation.
  Do not install global shortcuts or consume modified navigation keys.
- In tab-bar mode, preserve tab selection, rename, close, reorder, new-tab menus,
  window controls, and panel toggling. Remember panel choice per space. Do not
  offer missing panel targets. Wheel tab changes apply only over the tab strip.
- On close, cancel timers and command watchdogs, release input/focus handles, and
  invalidate pending results. A child command can continue until its host timeout.

## Built from

- Create `mods/github-issues-prs/` with `mod.json` and `main.js`. Set the manifest
  title to `GitHub Issues & PRs`, `place` to `"none"`, and overlay `width` and
  `height` to `680` and `760`. Keep the runtime modules, icons, recipe, and PNG
  in the same mod root. There is no required companion mod.
- `main.js`: a `gpui-kit` View and `gpui-base` buttons, inputs, scrollbars, and
  Markdown. Herdr APIs include `spaces`, `panes`, `focused`, `exec`, `props`,
  `window`, `theme`, context timers/tasks, focus handles, and URL opening.
- `github.js`: normalize the `git remote get-url origin` result to `owner/repo`.
  Pass the selected machine as `on` to `exec`. Probe `gh --version` with a 10 s
  timeout (15 s for WSL). Allow 10 s for Git and 45 s for each GitHub query.
  Bound unsettled promises with a view timer 2 s beyond each command timeout.
  Read number, title, URL, state, author, update time, and labels in JSON.
  Request the body only for details and include draft, branch, review, and change
  fields for pull requests. Validate the shape and item number before rendering.
- `tabs.js`: `layout`, `shared`, `settings`, local storage, `run`, and `openOverlay`.
  Tab context and new-tab menus require Herdr's shipped `menu` and `new-menu`.
  Program icons are host-provided; fixed icons are inside this bundle.
- Install this root as `<app-home>/mods/github-issues-prs/`. Do not copy development
  dependencies, caches, or generated SDK declarations. Keep the LICENSE notice.
- Use the default view with `mod.open` or `tab.new`, or add a `github` block to the
  existing `panel-body` stack. For the optional tab bar, set the existing `tabs`
  block's mod to `github-issues-prs` and props to `{ "tabs": true }`. Keep the
  existing `panel`/`panel-body` IDs and unrelated layout nodes. See the exact
  block examples in [README.md](README.md). Do not distribute a layout.
- Optional `repo: "owner/repo"` pins the repository and captures its initial
  workspace machine. No keybinding snippet is required. Preserve existing keys.
- Runtime dependencies: Herdr, Git, and GitHub CLI on the selected machine. Local
  Windows may use `wsl.exe --exec gh` only if native CLI discovery fails. Remote
  machines never fall back locally. Authenticate manually on the selected machine.
- Native entry, fixture, and preview checks used Herdr App 0.1.16 on macOS.
  The source repository supplies Vitest, TypeScript, and Biome for development.
  The runtime mod does not need npm dependencies.

## Watch out

- Commands read local/remote Git configuration and access GitHub over the network.
  The CLI's account, permissions, and environment control authentication. This mod
  does not read tokens, log in, modify repositories, or write to GitHub.
- CLI and Git diagnostics redact common credential formats. Limit each complete
  error, including generated recovery, to 1,600 characters. Reserve space for
  recovery before truncating the diagnostic. Redact and limit the recovery's
  machine name to 160 characters before JSON quoting; use the full name for routing.
  Do not share private diagnostics or screenshots without inspection.
- Return at most 100 items. Render at most 80,000 description characters. Comments,
  diffs, CI checks, GitHub Enterprise, and repository mutation are not supported.
- Tab-bar mode explicitly replaces a layout block and writes only per-space panel
  preferences to mod local storage. Revert that block before uninstalling it;
  remove the `github` block or other references before removing the mod folder.
- Disabling the mod does not delete CLI credentials or change repository files.

## Done when

Completed local checks:

1. `npm run test --workspace herdr-github-issues-prs` passes mocked regression tests
   for repository/machine selection, authentication routing, deadlines, races,
   malformed responses, search drafts, tab controls, and close cleanup.
2. `npm run check:mod --workspace herdr-github-issues-prs` passes the default native
   load and nine eager native descriptions in disposable profiles. Fixtures use
   no GitHub account or network. This is not physical interaction evidence.
3. `npm run check:types --workspace herdr-github-issues-prs` and
   `npm run check --workspace herdr-github-issues-prs` pass after SDK generation.
4. Bundle structure, JSON, runtime imports, local links, and `git diff --check` pass.
5. The list and list-error screenshots rendered without native runtime errors in
   disposable profiles. `preview.png` is the inspected 680 × 501 list screenshot
   after resizing and metadata removal. The screenshot does not prove pointer,
   keyboard, or authenticated behavior.

Still required before sharing:

1. In a disposable profile, load both views at narrow and wide sizes in light and
   dark themes. Titles must remain readable and controls usable. Enter applies
   the search, Clear restores all results for the active filter, and switching
   type restores its draft and filter. Open a result and press Escape to return.
   Normal terminal input and existing shortcuts must remain unchanged.
2. Verify physical tab select/reorder/rename/close/new-tab and window controls,
   panel switching, and per-space restore. Remove the panel target and confirm
   its button disappears. Close the mod during a pending request without errors.
3. With approved test accounts and repositories, verify that local and remote
   terminals show results from their own machines. A missing origin must show a
   neutral message. Failed authentication and timeouts must show Retry without
   switching machines. Move focus quickly and confirm that late results cannot
   replace the current list. Do not change accounts or write to GitHub to test this.
4. Repeat preview inspection after UI changes. Keep private content out of the
   image, confirm it matches that version, and check all recipe links.
