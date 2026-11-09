# Herdr Mod Manager

## Goal

Build a Herdr App mod manager with an in-app [Herdr Gallery](https://herdr.dev/gallery/?type=mods). Users can browse and search available mods, install them, see which are installed, and enable, disable, update, or uninstall installed mods.

Current authorization: resolve the preview review findings with clearly marked sample data and simulated management actions. Follow Herdr's direct JavaScript convention without `src`, `dist`, or a build step. Real Gallery data, installed-mod discovery, installation, updates, and persistent enable/disable state require later implementation authorization. Do not change the user's installed mods.

## Context

- The initial preview used a TypeScript template; Herdr's shipped mods use JavaScript files directly.
- Installed Herdr App mods use `mod.json` and `main.js`.
- Development link: `~/.config/herdr-app/mods/mod-manager` → `/Users/narumi/src/herdr-mod-manager`.
- `main.js` now opens an in-app sample Gallery. `preview.js` owns shared session state for simulated installation, enable/disable, and confirmed uninstall. Model and view-handler tests cover the preview workflow.

## Requirements

### Gallery

- Show available mods inside Mod Manager. An external Gallery link is optional and does not meet this requirement by itself.
- Search by mod name, description, and repository, without case sensitivity. An empty search shows all available mods.
- Show each mod's name, description, source, and version when the data source provides it.
- Show whether each Gallery mod is installed and, when installed, whether it is enabled or disabled.
- Provide actions based on the current state:
  - Not installed: `Install`.
  - Installed and enabled: `Disable` and `Uninstall`.
  - Installed and disabled: `Enable` and `Uninstall`.
  - An update is available for a manager-installed mod: also offer `Update`.
- Show loading, no-results, and data-fetch errors. A fetch error must not appear as an empty Gallery.

### Installed Mods

- List actual installed mods, including mods that are not in the Gallery. Show their source and enabled or disabled state; an `Installed` label alone is not sufficient.
- Support search and retain source filters. Treat installation source and enabled state as separate properties.
- Provide `Enable`, `Disable`, and `Uninstall` actions with the same behavior as the Gallery. Keep `Install from GitHub` and eligible update actions.
- Disabling a mod must not uninstall it or delete its files. Enabling a disabled mod must not require reinstallation. Save the selected state and explain any required reload or restart.
- Confirm uninstall with the mod name and target path before removing files. Cancel must leave the mod unchanged.
- Block actions that cannot be performed safely and show the reason. In particular, protect shipped mods, the running manager, active layout dependencies, and symbolic-link targets from unsafe changes.

### Shared State and Operations

- Use one installed-mod state and one set of lifecycle operations for both pages. Match Gallery entries to local mods by verified identity and normalized repository source, not display name alone.
- After a successful operation, refresh both pages from actual local state. For example, uninstall changes the Gallery action back to `Install` and removes the Installed entry.
- Prevent duplicate or conflicting operations on the same mod. Show progress and failures; do not report success before the operation is verified.
- If the enabled state cannot be read, show an unknown state and a reason instead of assuming the mod is enabled.

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

These live-data and lifecycle tasks follow Preview Revision and require later implementation authorization. Use temporary fixtures for lifecycle tests; do not install, disable, update, or remove the user's real mods to validate the implementation.

- [ ] Verify a usable Gallery data source and Herdr's APIs for installed-mod discovery, persistent enable/disable state, reload, and removal. Record the source format, identity rules, permissions, and lifecycle behavior against the installed SDK and existing mods. If host support or a data source is missing, document the required change and keep dependent tasks blocked; a browser link or simulated success is not a substitute.
- [ ] Add installed-mod discovery and shared state. Read actual manifests, sources, and enabled state; identify shipped mods, symbolic links, the manager, and active layout dependencies. Test Gallery-to-local matching, mods absent from the Gallery, identity conflicts, and unreadable state without changing existing mods.
- [ ] Add in-app Gallery loading, browsing, and search against the verified source. Test metadata rendering, case-insensitive search, empty search, loading, no results, and fetch failures with fixtures.
- [ ] Replace sample-only Installed data with discovered mods and connect both pages to shared state. Test search, source filters, installed and enabled badges, the required action for each state, and visible reasons for protected or unknown states. Keep fixtures separate from live data.
- [ ] Add one installation operation for Gallery entries and GitHub repository URLs. Validate `mod.json` and the JavaScript entry before installation, stage downloads outside the live mods directory, reject existing destination paths and identity conflicts, and do not run repository install scripts. Test valid and invalid repositories, partial failures, duplicate requests, and state refresh on both pages.
- [ ] Add persistent enable and disable operations using the verified Herdr mechanism. Keep files intact and explain any reload requirement. Test both transitions, persistence after reload, failure handling, protected mods, and matching state and actions on both pages.
- [ ] Add confirmed uninstall for eligible installed mods from either page. Use verified paths and ownership checks; reject symbolic links and unsafe targets, including mods with local changes. Test cancel, successful removal, failures, path traversal, protected targets, and the return to `Install` in the Gallery.
- [ ] Add updates for manager-installed mods. Use fast-forward-only updates, reject local changes, and exclude symbolic links such as this development checkout. Test successful and rejected updates, preservation of enabled state, and refresh of both pages.
- [ ] Add integration tests for Gallery → install → disable → enable → uninstall, GitHub installation, and updates using temporary mod fixtures. Verify that duplicate or conflicting actions cannot run and failed operations do not produce false success states or partial live installations.
- [ ] Update usage and recovery instructions, then run `npm run ci` and native checks for all three initial views. Record results and prepare screenshots and a manual review handoff. Document data-source limits, protected actions, and required reload or restart behavior; do not describe unverified native behavior as complete.

## Rollback / Recovery

- Remove failed staging downloads without changing existing mod directories.
- Preserve the previous enabled state when an enable or disable operation fails. If recovery fails, show the actual state and recovery instructions.
- Validate an update before changing the live checkout. Retain the previous revision until validation succeeds and report any failed recovery.
- Uninstall removes mod files and is not automatically reversible. State this in the confirmation and preserve source information for reinstallation. Never remove files outside the verified target or follow symbolic links.

## Completion Checklist

- [x] The development symbolic link points to this repository.
- [x] The fixture-only preview demonstrates browsing, search, install, enable, disable, confirmed uninstall, and shared state across both pages without installed-mod discovery or real mod changes. Verified by model and view-handler tests, seven native state checks, and prepared screenshots; remaining native interaction checks have a README handoff.
- [ ] The in-app Gallery lists real available mods and supports search; an external link is not the only Gallery interface.
- [ ] Gallery and Installed show matching installed and enabled states, including after an operation or manager reload.
- [ ] Gallery installation and GitHub installation work without overwriting existing mods or running repository install scripts.
- [ ] Eligible installed mods can be enabled, disabled, and uninstalled from either page. Disable preserves files; uninstall requires confirmation and restores the Gallery's `Install` action.
- [ ] Protected mods, symbolic links, unsafe paths, and local changes are not modified by unsupported operations. Rejections explain the reason.
- [ ] Updates preserve enabled state and reject local changes and unsupported targets.
- [ ] Fixture-based lifecycle and failure tests, `npm run ci`, and native checks pass. Temporary test data is removed and the user's installed mods remain unchanged.
- [ ] Usage and recovery instructions are current, and remaining native UI checks have an explicit handoff.

## External Handoff

- Preview native UI review — Responsible role: a maintainer with Herdr App access. Prerequisite: the passing checks, screenshots, and fixture-only sequence in `README.md` under Preview review handoff. Action: review both themes, native search and scrolling, keyboard controls, confirmations and feedback, and close/reopen reset. Expected result: visible state and actions agree with the automated workflow tests. These native interactions remain unverified; do not claim release readiness before review. No real mod changes are needed. Live lifecycle validation requires a separate disposable test profile after the Plan tasks are implemented.
