# Herdr Mod Manager

## Goal

Build a Herdr App mod manager with an in-app [Herdr Gallery](https://herdr.dev/gallery/?type=mods). Users can browse and search available mods, install them, see which are installed, and update or uninstall eligible installed mods.

Current revision: update planning and related documentation only. The planned live scope is Gallery browsing, installed-mod discovery, installation, updates and confirmed uninstall. Enable/disable is excluded. Follow Herdr's direct JavaScript convention without `src`, `dist`, or a build step. Do not patch or fork upstream Herdr, replace its binary, manually edit its generated SDK, or change shipped mods, layouts or keybindings. Use temporary fixtures for lifecycle validation; do not change the user's installed mods.

## Context

- The initial preview used a TypeScript template; Herdr's shipped mods use JavaScript files directly.
- Installed Herdr App mods use `mod.json` and `main.js`.
- Development link: `~/.config/herdr-app/mods/mod-manager` → `/Users/narumi/src/herdr-mod-manager`.
- `main.js` now opens an in-app sample Gallery. `preview.js` owns shared session state for simulated installation, enable/disable, and confirmed uninstall. Model and view-handler tests cover the preview workflow.

## Requirements

### Gallery

- Show real available mods inside Mod Manager. An external Gallery link is optional and does not meet this requirement by itself.
- Search by mod name, description and repository, without case sensitivity. An empty search shows all available mods.
- Show each mod's name, description, source and version when the data source provides it.
- Show whether each Gallery mod is installed.
- Provide actions based on installation and ownership:
  - Not installed: `Install`.
  - Installed: `Uninstall` when the target is safe.
  - An update is available for a manager-installed mod: also offer `Update`.
  - An action is unsafe or unsupported: block it and show the reason.
- Show loading, no-results and data-fetch errors. A fetch error must not appear as an empty Gallery.

### Installed Mods

- List actual installed mods, including mods that are not in the Gallery. Show their source and installation ownership.
- Support search and retain installation-source filters. Keep `Install from GitHub` and eligible update actions.
- Confirm uninstall with the mod name and verified target path before removing files. Cancel must leave the mod unchanged.
- Protect shipped mods, the running manager, active layout and runtime dependencies, symbolic-link targets, unsafe paths and local changes from unsupported mutation.
- Do not edit layouts or keybindings to detach a mod. If dependency or runtime safety cannot be established, block the affected operation and show the reason.
- Explain any verified reload or full app restart requirement for updates or removal. Do not equate a file change with successful unload.

### Shared State and Operations

- Use one installed-mod state and one set of install, update and uninstall operations for both pages.
- Match Gallery entries to local mods by verified identity and normalized repository source, not display name alone. Recipe paths and bundled mod folders are part of identity.
- After a successful operation, refresh both pages from actual local state. Uninstall restores the Gallery's `Install` action and removes the Installed entry.
- Prevent duplicate or conflicting operations on the same mod, including across manager views. Show progress and failures; do not report success before file and ownership changes are verified.
- Keep sample fixtures separate from live data. Installation membership does not establish whether a mod is enabled or running.

### Non-Goals

- No enable/disable controls, persistent enabled-state discovery, disabled-mod store, folder parking or restart-pending toggle mechanism.
- No upstream Herdr changes or dependency on a new upstream lifecycle API.
- No automatic layout or keybinding changes, repository install scripts, or execution of downloaded code as a validation shortcut.
- Do not silently add a required runtime dependency or claim native support on unverified platforms.

The completed preview records below describe historical simulations, not requirements to implement those actions in the live manager.

## Visual Preview

- [x] Verify the native UI APIs and the mod build and open commands against the installed SDK and shipped mods. The ESM entry, development link, and `mod.open` work.
- [x] Build a theme-aware preview with a sample mod list, search, a GitHub form, and Gallery access. Installed mods are not read or changed.
- [x] Run formatting, tests, type checks, and `herdr-app check`; open the preview and inspect a screenshot. Biome, five JavaScript tests, and no-emit JavaScript type checks pass. All three initial views pass native checks. The direct JavaScript dialog has no reported errors; its screenshot is `/tmp/herdr-mod-manager-javascript-ui.png`. Remaining manual review is documented in `README.md`.

## Preview Revision

The review findings are resolved for the fixture-only preview. `main.js` renders an in-app Gallery and shared management actions. `preview.js` owns each view's in-memory `PreviewSession`; Installed and its count are derived from this state.

All lifecycle actions are marked as simulated. They do not discover installed mods, fetch repositories, use persistent storage, or change mod files. Closing the manager discards its session. Real data and lifecycle operations remain in the open Plan tasks below.

- [x] Extend the shared preview model with available, installed-enabled, installed-disabled, and protected sample mods. Stable IDs, list membership, count changes, session isolation, and fresh-session reset pass model and view tests.
- [x] Replace the Gallery landing page with searchable sample cards. Tests verify name, description, and repository search, independent page queries, no results, installed/enabled labels, and state-based actions.
- [x] Add simulated install, enable, and disable actions shared by Gallery and Installed. View-handler tests verify the full sequence and cross-page count and action changes. Conflicting operations are blocked until completion.
- [x] Add simulated uninstall confirmation with confirm and cancel. Tests verify that cancel changes nothing, confirm removes only installed state, the Gallery offers Install again, and protected samples cannot change. The confirmation capture shows the sample name, path, and simulation warning.
- [x] Connect the GitHub form to shared sample state. Tests verify URL validation and normalization, Gallery identity reuse, new Installed-only entries, duplicate prevention, and retry after failure without network access.
- [x] Add workflow tests and update preview instructions. `npm run ci` passes 129 tests, Biome, and JavaScript type checks. `npm run check:mod` and `npm run check:preview` pass; the latter checks Gallery, Installed, GitHub, confirmation, pending, error, and empty-search states in temporary copies and removes them. Tests cover progress, failure, and a stale-handler feedback race. Source inspection confirms that lifecycle handlers have no file, network, or persistent-state calls.

Dark-theme Gallery, Installed, From GitHub, and uninstall confirmation captures were inspected. Non-default captures used temporary initial-state setup, which was removed. The live manager opens on Gallery and reports no errors. Screenshot paths and the remaining native interaction review are recorded in `README.md` under Preview review handoff. Mocked tests and native initial-state checks do not establish keyboard dispatch, scrolling, both-theme usability, or native close/reopen reset behavior.

## Sidebar Launcher

- [x] Clone the sidebar mod and current layout without changing Herdr's shipped files. Created `mod-manager-sidebar` and `herdr-with-mods`; SHA-256 checks confirm the shipped layout, shipped sidebar code, and keybindings are unchanged.
- [x] Add a Mods row above Settings that runs `mod.open` for `mod-manager`; increase the footer height and use the custom sidebar mod only in the cloned layout's footer. The footer is 97 px and the custom layout is active.
- [x] Run native checks and repository checks, inspect the sidebar screenshot, and document the custom layout and recovery command. Native checks, `npm run ci`, and expanded/collapsed row-order and action-binding smoke tests pass. The running layout reports no errors. Screenshot: `/tmp/herdr-sidebar-mods-detail.png`; recovery instructions: `README.md`.

## Direct JavaScript

- [x] Move the UI and sample data to root `main.js` and `preview.js`, preserving runtime behavior and JSDoc types. A one-time compiler-output comparison confirms equivalent runtime code after normalizing redundant type-cast parentheses.
- [x] Remove the TypeScript source directory, generated output, SDK-copy script, and build commands; use `jsconfig.json` for no-emit JavaScript checks and update tests and usage instructions. Tests now import root `preview.js`; the `src` and `dist` directories remain absent after checks.
- [x] Run formatting, tests, JavaScript type checks, and native checks for all three initial views; open the manager without build output and inspect its screenshot. `npm run ci`, all three native initial views, and the live dialog pass; screenshot: `/tmp/herdr-mod-manager-javascript-ui.png`.

## Plan

Implement the live scope in this repository only. Use temporary repositories and disposable app profiles for lifecycle tests. Do not install, update or remove the user's real mods to validate the implementation.

### Research and execution status

The public Gallery source is `https://assets.herdr.dev/mods/index.json`. Its schema version 1 identifies repositories, case-sensitive recipe paths and one or more mod folders. It does not provide installed state or a mod version. Root-level direct JavaScript mods and recipe bundles require separate validation.

Herdr App 0.1.14 and the researched upstream revision expose no public all-instance unload API. That is a safety constraint for mutation, not a blocker for read-only discovery or Gallery work. The earlier requirement to wait for upstream enabled-state support is withdrawn: enable/disable is no longer in scope. Folder parking and related restart-state work are also excluded.

See [live management research and constraints](docs/lifecycle-prerequisites.md) for version-pinned evidence, available APIs, prior art and remaining validation gates. No live implementation task below is complete. The runtime remains the fixture-only preview.

Existing preview evidence: `npm run ci` passes 129 tests, Biome and JavaScript type checks; `npm run check:mod` and all seven `npm run check:preview` states pass. These results do not verify live file operations or native interaction.

### Implementation boundaries

- Read metadata through existing Herdr APIs. Use a tested local I/O adapter for lifecycle file operations and `git`; do not modify Herdr to supply missing primitives.
- Store manager-owned source records, transaction state and staging data under `appHome()/data/mod-manager/`, outside `mods/`. Record repository, recipe path, mod folder, original destination, installed commit and a file baseline.
- Validate ownership, paths, dependencies and local changes again immediately before mutation. A missing prerequisite blocks only the affected operation; independent read-only tasks can proceed.
- Resolve safe no-follow operations, no-replace installation, concurrency locks and recovery in the backend validation task before enabling destructive actions.
- A native check executes mod JavaScript. Use it for trusted fixtures and the manager; do not run it on downloaded code before review and explicit trust.

### Tasks

- [ ] Add read-only installed-mod discovery and shared installation state. Read manifests and verified source records; identify shipped mods, development links, the manager and active dependencies. Test mods absent from the Gallery, unreadable metadata, identity conflicts, symbolic links and unverified provenance without changing existing mods.
- [ ] Add in-app Gallery loading, browsing and search against the verified source. Validate schema and repository/recipe/mod-folder identity. Test metadata, absent versions, bundles, case-insensitive search, empty search, loading, no results, invalid responses, network failures and retry with fixtures.
- [ ] Connect both live pages to shared installation state. Test search, source filters, installed badges, eligible Install/Update/Uninstall actions and visible protection reasons. Keep preview fixtures isolated and omit toggle controls from live views.
- [ ] Verify an application-local lifecycle backend with existing host APIs and explicitly checked platform tools. In temporary roots, prove no-follow path and ownership checks, no-replace staging commits, locking and rollback. Test missing tools, unsafe ancestors, destination races and active or unknown runtime dependencies. Block unsupported operations with a reason; do not patch upstream or silently add a required runtime.
- [ ] Add one installation operation for Gallery entries and GitHub repository URLs. Validate root `mod.json`/`main.js` or each selected recipe mod folder, stage outside `mods/`, reject existing destinations and identity conflicts, and record verified provenance. Do not run repository scripts or unreviewed code. Test invalid repositories, unsafe file modes and paths, ambiguous bundles, partial failures, duplicate requests and refresh on both pages.
- [ ] Add confirmed uninstall for eligible installed mods from either page. Revalidate the displayed path and ownership; reject symbolic links, local changes, protected targets and unsafe live dependencies. Test cancel, successful removal, failures, path traversal, stale confirmations and the return to `Install` in the Gallery. Preserve source information for reinstallation.
- [ ] Add updates for manager-installed mods. Verify fast-forward ancestry, reject local changes and unmanaged or symbolic-link targets, and validate a staged revision before changing the live files. Preserve provenance and a recoverable previous revision. Test successful and rejected updates, partial-write recovery, watcher/reload limits and refresh of both pages without claiming unsupported unload.
- [ ] Add fixture-based integration tests for Gallery → install → update → uninstall and GitHub installation. Verify persistence of ownership and installed membership after manager reopen, duplicate/conflicting requests, view closure during work, interrupted recovery, and failure states without false success or partial live installations. Remove temporary data and verify the user's installed mods remain unchanged.
- [ ] Update usage and recovery instructions, run `npm run ci`, `npm run check:mod` and native checks for Gallery, Installed and GitHub, then prepare screenshots and a manual review handoff. Document source limits, required platform tools, blocked actions and verified reload or full restart behavior. Do not describe unverified native behavior as complete.

## Rollback / Recovery

- Remove failed staging downloads without changing existing mod directories.
- Persist operation intent before a multi-step change. On interruption or stale ownership, reconcile actual files with the record before permitting another mutation; do not infer success from the record alone.
- Validate an update before changing live files. Retain the previous revision and file baseline until verification succeeds; report failed recovery and leave the target blocked.
- Uninstall removes mod files and is not automatically reversible. State this in the confirmation and preserve source information for reinstallation. Never remove files outside the verified target or follow symbolic links.
- Do not quit, restart, update or replace the user's Herdr App automatically as a recovery action. Keep its shipped files, layouts and keybindings unchanged.

## Completion Checklist

- [x] The development symbolic link points to this repository.
- [x] The historical fixture-only preview demonstrates its simulated workflow without installed-mod discovery or real mod changes. Model and view tests, native state checks and screenshots are available; this is not live implementation evidence.
- [ ] The in-app Gallery lists real available mods and supports search; an external link is not the only interface.
- [ ] Gallery and Installed show matching installed membership and verified source information, including after an operation or manager reopen.
- [ ] Gallery and GitHub installation work without overwriting existing mods or running repository install scripts or unreviewed code.
- [ ] Eligible installed mods can be uninstalled from either page after confirmation; cancel changes nothing and successful uninstall restores the Gallery's `Install` action.
- [ ] Protected mods, symbolic links, unsafe paths, local changes and unsafe live dependencies are not modified. Rejections explain the reason.
- [ ] Updates are manager-owned and fast-forward-only, reject local changes and unsupported targets, and retain a recoverable previous revision until verification passes.
- [ ] Fixture lifecycle and failure tests, `npm run ci` and the required native view checks pass. Temporary test data is removed and the user's installed mods remain unchanged.
- [ ] No upstream Herdr source or binary was patched, no generated SDK was edited by hand, and no shipped mod, layout or keybinding was changed; live views do not expose enable/disable actions.
- [ ] Usage and recovery instructions match the implemented scope, and remaining native UI or platform checks have an explicit handoff.

## External Handoff

- Native interaction and unavailable platforms — Responsible role: a maintainer with access to the target platform. Prerequisite: passing agent checks, temporary lifecycle fixtures, screenshots and documented platform requirements. Action: check both themes, keyboard controls, search and scrolling, confirmation and failure feedback, and any documented full restart behavior in a disposable app profile. Expected result: native behavior agrees with automated tests, and no other profile or mod is changed. Native checks that the agent can safely prepare remain implementation tasks; only unavailable platform or human interaction checks belong here. Unverified behavior must be named in the usage handoff, and release claims must not include unverified platforms or behavior.
- Historical preview review — The fixture-only sequence in `README.md` remains a record of the existing preview. Its simulated toggles do not add live requirements. Replace that handoff with the scoped live workflow when live implementation is ready; no Herdr maintainer action or upstream patch is a prerequisite for this plan.
