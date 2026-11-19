# GitHub Issues & PRs

Read Issues and Pull Requests inside Herdr. The panel follows the focused
terminal's GitHub `origin`. It supports github.com. This mod remains read-only.
[RECIPE.md](RECIPE.md) is the rebuild brief. An inspected actual native
`preview.png` is included. The bundle remains incomplete until the required
disposable-profile interaction checks pass.

## Share on Herdr Gallery

Copy this prompt into your coding agent. Review the files before you approve
publication.

```text
Source repository: https://github.com/narumiruna/herdr-mods

Read ~/.config/herdr-app/AGENTS.md, then write a RECIPE.md for my github-issues-prs mod the
way it describes: a brief another agent could build it from with an empty folder.
Put the mods/github-issues-prs/ folder, any keys.json snippet, the recipe and
a screenshot named preview.png in one folder, without a layouts/ folder, push it
to a public GitHub repo and add the topic herdr-mod.
```

## Interface

- **Header:** GitHub Issues & PRs and the current repository. Repository text is read-only.
  Hover it to see the source machine, folder, and GitHub CLI transport. The footer
  shows the machine and CLI used for the displayed data. The refresh icon reloads data.
- **Tabs:** Issues and Pull Requests.
  - Each tab keeps its own status filter, applied search, and search draft.
  - Left/Right, Home, and End select tabs. Enter/Space activate buttons.
- **Search:** enter a title or GitHub qualifiers, then press Enter or select
  the search icon. Examples: `label:bug`, `author:@me`, `assignee:@me`,
  `review-requested:@me` for Pull Requests. A hint identifies the applied search
  when the draft changes. Clear search resets both the draft and applied query.
- **Status:** Open, Closed, or All. Closed Pull Requests include merged ones.
- **List:** select a row to read its description. Titles wrap; metadata shows
  state, number, author, and update time.
- **Detail:** the back button or Escape returns to the list. The external-link
  icon opens the item on GitHub. List search and filters are hidden while reading.
- **Empty states:** a non-Git folder or non-GitHub origin shows a neutral
  explanation, not a fatal error. Operational failures show Retry. CLI list and
  detail errors show generated machine, CLI, and login help as wrapped text.
  Hover the summary to see the redacted diagnostic and help (at most 1,600 characters).
  Help is not taken from CLI output. Recovery labels use at most 160 characters
  of the redacted machine name before JSON quoting; command routing uses the full name.

There is no repository input, Use button, or Auto button. A layout or pane
may still pass `props: {"repo":"owner/repo"}` to pin a repository explicitly.
This also pins the active workspace's machine when the view starts. Later
workspace changes do not change that repository or machine.

## Repository following and refresh

- Auto detection uses the focused terminal in the active tab.
  - Clicking the GitHub Issues & PRs panel keeps the last terminal in that tab.
  - With no focused or remembered terminal, it uses the active tab's first
    terminal, then the workspace's first terminal, then its default folder.
- Rapid focus changes are combined into one lookup after 200 ms.
- During origin lookup on the same machine, existing content stays visible.
  - A different or unavailable origin clears the old content.
  - Same-repository folders and worktrees on that machine keep the list and
    preview. A fresh result is reused for up to two minutes.
  - If a same-repository background query fails, existing content stays visible.
- A machine change clears the old repository, list, and preview before origin
  lookup. The same repository on another machine needs a new query.
  - CLI discovery is cached separately for each machine.
  - Late responses from a previous workspace do not replace the current data.
- Automatic refresh runs every two minutes. The refresh icon always queries again.
- Each command has a native deadline even if its transport promise does not settle.
  - A timeout ends Loading and shows Retry.
  - A new request does not reuse unfinished CLI discovery.
- Malformed CLI data produces a retry error instead of entering native rendering.
  External item buttons accept only HTTPS github.com issue or PR URLs.
- Closing a copy cancels its timers and command watchdogs, releases retained input
  and focus handles, and ignores late results. This does not terminate a running
  child command early; the host's command timeout still applies.

The list contains at most 100 results. Descriptions are limited to 80,000
characters. Comments, diffs, and CI checks are not shown.

## Requirements and access

The mod runs `git remote get-url origin` and `gh issue/pr list/view` on the
workspace's machine. Each machine's CLI configuration controls its account and
private-repository permissions. A pinned repository uses its captured machine.

Install GitHub CLI (`gh`) and run `gh auth login` on the machine that needs access.
Resolve remote installation, connection, and login errors on that remote machine,
then select Refresh. The mod does not change credentials or automatically fall
back to another machine, local `gh`, or local WSL for a remote workspace.

Local Windows discovery is unchanged: use native `gh` first. If it is unavailable,
use `wsl.exe --exec gh` in the default WSL distribution. Authenticate there with
`wsl.exe --exec gh auth login`. An authentication failure does not trigger a
fallback or account change.

These commands access GitHub over the network. The `github-issues-prs` mod does
not read tokens or write to GitHub. Links open only after a click.

## Installation and placement

Install this directory as `<app-home>/mods/github-issues-prs/`. One installation
provides two independent views. Without `tabs: true`, it shows the Issues and
Pull Requests panel. With `props: { "tabs": true }`, it shows the workspace tab
bar. The tab-bar copy does not create GitHub clients, inputs, tasks, or timers.
Keep both copies in the layout; the tab bar does not contain the panel.

To use the tab bar, change the existing `tabs` block in a personal layout:

```json
{
  "id": "tabs",
  "type": "block",
  "content": {
    "mod": "github-issues-prs",
    "props": { "tabs": true }
  }
}
```

Add this block beside Files and Changes in the existing `panel-body` stack:

```json
{
  "id": "github",
  "type": "block",
  "content": { "mod": "github-issues-prs" }
}
```

Keep the containing panel ID as `panel`, its stack ID as `panel-body`, and the
GitHub block ID as `github`. Keep the layout's existing sizes, Files and Changes
blocks, and window settings. The tab-bar button selects that block and shows the
shared right panel; clicking it again closes the panel. Each space remembers its
panel choice in local storage. The tab bar keeps terminal tab actions and window
controls. Panel buttons appear only when their target exists in `panel-body`.
Controls are keyboard focusable. Vertical wheel navigation applies only over the
tab strip, not panel or window buttons. All fixed icons are included in `icons/`;
program icons still come from Herdr. The tab menu and new-tab popup use Herdr's
shipped `menu` and `new-menu` mods.

`main.js` selects the mode once when each copy starts. `tabs.js` contains the
tab-bar controller, based on the shipped Tabs mod from Herdr App 0.1.14. This
mod bundle does not include a layout or change the live profile or bindings.

For an existing `github-tabs` installation, change the tab-bar node to the first
example, and change the old `github` panel's `content.mod` to `github-issues-prs`.
Keep the panel node ID unchanged. Saved choices from the separate mod are not
migrated; each space records its choice again. Remove the old installation only
after all personal layout references have been changed and the new views work.

The panel can also open without a custom tab bar:

```sh
herdr-app do mod.open --name github-issues-prs
herdr-app do tab.new --name "GitHub Issues & PRs" --mod github-issues-prs
```

## Checks

From the repository root:

```sh
npm run test --workspace herdr-github-issues-prs
npm run check:mod --workspace herdr-github-issues-prs
npm run check:types --workspace herdr-github-issues-prs
npm run check --workspace herdr-github-issues-prs
```

Unit tests cover both entry-point modes, search drafts, malformed responses,
request ordering, cleanup, and the layout examples above. `check:mod` uses a
disposable profile, checks this mod, then checks nine native descriptions with
fixture data and no GitHub access. It generates ignored SDK declarations needed
by `check:types`; do not put these declarations or `node_modules/` in a bundle.
These checks passed with Herdr App 0.1.16 on macOS. Eager native checks do not
prove painting or physical interaction.
The profile owner must verify in a disposable profile:

1. Both views load from one installation; the tab-bar copy makes no GitHub calls.
2. GitHub, Files, and Changes switch the right panel, and each space remembers its
   choice after switching away and back.
3. Tab select, reorder, rename, close, new-tab, and window controls still work.
4. The default panel follows local and remote repositories, searches and previews
   items, and handles failed commands without changing accounts.

The bundled screenshot shows the native Issues list with fictional data. No
live-profile migration, physical interaction test, or authenticated GitHub test
was performed. The interaction checks above are still required before sharing.
No `keys.json` is needed. Existing app shortcuts remain in place; modified arrow
keys are not handled by the panel's type tabs.
