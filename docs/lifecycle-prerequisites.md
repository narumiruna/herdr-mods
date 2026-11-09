# Live management prerequisites

## Status

Live management is blocked on Herdr App 0.1.14. The host has no supported persistent enabled-state mechanism. The prerequisite audit is complete, but the live implementation and completion criteria in `PLAN.md` are not complete. The manager remains a fixture-only preview.

The audit used read-only commands, the installed SDK and manifests, and the public host source at [`v0.1.14`, commit `2405bf3`](https://github.com/herdrdev/herdr-app/tree/2405bf388c568c3ed479f05b8e405ccfa44b3f2c). No lifecycle operations were run against the user's mods. A newer host version must be checked again before implementation.

## Gallery source

The production [Gallery client](https://herdr.dev/live/gallery.js) fetches [`https://assets.herdr.dev/mods/index.json`](https://assets.herdr.dev/mods/index.json). This is a usable public metadata source, not an installation or lifecycle API. It requires no credentials.

The observed response has `schemaVersion: 1`, `generatedAt: "2026-11-09T13:30:16.274Z"`, 559 listings and 439 repositories. These counts are observations, not acceptance criteria. The top-level fields are `schemaVersion`, `generatedAt`, `modCount`, `repositoryCount`, `source`, and `mods`. `source` describes collection from public GitHub repositories with the `herdr-mod` topic and includes truncation and skipped-result counts.

Each listing provides:

- Repository: `owner`, `repo`, `fullName`, `url`, `defaultBranch`, `headCommit`, `stars`, `pushedAt`.
- Recipe folder: `path`, `name`, `blurb`, `modNames`, `hasKeys`, `hasPreview`, `recipeBytes`, `previewUrl`.

There is no mod version, installed state, enabled state, permissions declaration, or host compatibility declaration in the observed listings. Do not display the commit as a semantic version or infer compatibility from index membership.

### Identity and package layout

The production [card mapper](https://herdr.dev/live/gallery-cards.js) identifies a listing as:

```text
mods:<lowercase-owner>/<lowercase-repository>/<case-sensitive-recipe-path>
```

An empty recipe path is valid. A listing can contain multiple `modNames`; it is not necessarily one installable mod or a repository-root `main.js`. The installed guide describes recipe folders containing `mods/<name>/`, `RECIPE.md`, a preview, and an optional `keys.json` snippet. For example, the observed `ChmaraX/herdr-nvim` listing has path `herdr-app` and two mod names. The website also has example cards; the community index is not a complete list of every website card.

A future installer must validate the repository, recipe path, commit and each mod folder. Match local mods through verified repository and folder provenance, not the recipe title or folder name alone. Normalize repository owner and name without changing path case. Reject identity conflicts, unsafe paths and existing destinations. Index metadata alone does not prove local ownership or repository safety.

Community mods are trusted code, not reviewed packages. The Gallery warns that an agent must inspect the files. The installed guide requires disclosure of network use, program execution and file reads outside a mod's folder. Do not execute downloaded code, repository scripts or a native check of untrusted code as a substitute for that review. Authentication, private repositories and API rate limits were not validated.

## Installed host contracts

- **Public API:** `herdr-app commands` lists 71 commands; the only `mod.*` commands are `mod.clone` and `mod.open`. The generated `herdr` SDK has no installed-mod or enabled-state API. There is no supported get/set enabled operation.
- **Discovery:** [`mods.rs`, lines 336–386](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L336-L386) scans folders with `main.js`, skips dot-prefixed IDs and uses folder names as runtime IDs. Manifest hints are `place`, `size` and `focusable`. Missing or invalid manifest hints default.
  - Read-only metadata discovery is possible, but a manifest does not establish enabled state or verified Gallery identity. Symbolic-link folders can be discovered.
- **Bookkeeping:** [`mods.rs`, lines 99–135](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L99-L135) uses `installed.json` for shipped-file fingerprints. `seen.json` records first-time docking.
  - Neither file is an authoritative registry of community mods or enabled state. Do not write either as an enable/disable mechanism.
- **Visibility:** [`window.rs`, lines 1433–1444](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L1433-L1444) keeps copies while their layout, pane or overlay slots exist, including hidden slots. [`mod.open`](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L3302-L3313) toggles one overlay.
  - Hidden is not disabled. Closing one overlay does not disable all instances or save an enabled state.
- **Reload and removal:** [`window.rs`, lines 3871–3939](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L3871-L3939) reloads changed loaded mods internally and rescans removed folders. Copy cleanup depends on ownership slots, not folder absence.
  - There is no public reload/unload/uninstall operation. Folder deletion does not establish that every running copy stopped.

The installed `~/.config/herdr-app/AGENTS.md` also states that hidden copies and their tasks remain alive and a failed reload keeps the previous version running. Separately, `README.md` records that edits through the external development symbolic link required close/reopen during preview validation. Restart behavior for live enable/disable cannot be specified until the host supports it.

### Permissions and file safety

The generated SDK exposes `fs/promises` reads, writes, directory listing, `exists`, `unlink`, empty-directory `rmdir`, and `mkdir`. It does not expose `lstat`, `realpath`, `readlink`, atomic rename or recursive removal. A directory entry has only a name and `isDirectory()`.

The [host policy](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L1143-L1152) grants filesystem reads under the user's home and writes under the app folder, plus unrestricted execution and network access. `herdr.exec` uses the user's real environment and credentials. These are broad trusted-code facilities, not manager ownership or lifecycle guarantees. The installed guide says not to read or change other mods' code at runtime; a sanctioned discovery and mutation contract is still needed.

`readTextFile` and compare-and-write `writeTextFile` are separate host wrappers. In particular, [`writeTextFile` resolves symbolic-link targets](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mod_files.rs#L26-L74); it is not a safe-target check. Do not assume all host file and execution APIs enforce the same filesystem boundary. Before destructive operations, the manager still needs verified ownership, no-follow path checks, local-change detection and protection for shipped mods, itself and active dependencies.

## Required host support

A Herdr maintainer must provide a supported lifecycle contract before dependent plan tasks can pass:

1. Read authoritative installed identity and enabled state, with explicit unknown/error results and protection or dependency information, or a sanctioned way to discover that metadata.
2. Persist enabled-state changes without deleting or renaming mod files. Apply the state at startup, rescans, hot reload and all pane, layout and overlay load paths.
3. Stop all affected instances safely, including hidden copies and tasks. Specify failure recovery, readback and any reload or restart requirement.
4. Define supported reload/removal behavior and safe file-operation boundaries so the manager can verify outcomes without following symbolic links or modifying protected targets.

A manager-only stored boolean, layout visibility change, `seen.json` edit, renamed entry file, or shipped-file change does not satisfy these requirements. An unknown enabled state must remain unknown, with a reason.

Read-only discovery and Gallery work are technically separable from the lifecycle blocker. They remain unimplemented in this prerequisite-only change; the verified Gallery endpoint does not complete the in-app live Gallery criterion. Persistent enable/disable, consistent state after reload, updates that preserve enabled state, and the full lifecycle integration sequence remain blocked. No live completion checkbox has been waived.

## Reproduce the audit

These commands do not change installed mods:

```sh
herdr-app --version
herdr-app commands
curl --fail --location --max-time 30 https://herdr.dev/live/gallery.js
curl --fail --location --max-time 30 https://herdr.dev/live/gallery-cards.js
curl --fail --location --max-time 30 https://assets.herdr.dev/mods/index.json
curl --fail --location --max-time 30 \
  https://raw.githubusercontent.com/herdrdev/herdr-app/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs
```

The existing preview passed `npm run ci` (129 tests, Biome and JavaScript type checks), `npm run check:mod`, and `npm run check:preview` (Gallery, Installed, GitHub, confirmation, pending, error and empty-search states). These checks do not verify real management, persistent state, repository downloads or native interaction.

## External handoff

- **Host lifecycle support — Herdr maintainer.** Prerequisite: a supported enabled-state and lifecycle contract with the behavior above. Implement or identify that contract and its SDK declarations. Then verify state persistence, all-instance cleanup and failure recovery in a disposable profile. These behaviors remain unverified and block live-management completion and release claims. Updating or patching Herdr itself is outside this repository change.
- **Live integration and native review — Mod Manager maintainer.** After host support and the remaining plan implementation exist, use temporary repositories and a disposable Herdr profile to run the planned lifecycle tests and inspect all three views. Do not validate destructive actions against the user's real mods. The fixture-only native review sequence remains in `README.md`; this audit adds no new UI or screenshots and does not establish release readiness.
