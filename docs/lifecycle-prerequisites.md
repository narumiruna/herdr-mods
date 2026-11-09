# Live management research and constraints

## Status

The planned live scope is Gallery browsing, installed-mod discovery, installation, updates and confirmed uninstall. Enable/disable and persistent enabled-state management are excluded by the user's scope decision. Do not implement folder parking, a disabled-mod store or toggle-related restart state.

No upstream Herdr change is required by this plan. Missing native lifecycle APIs require application-local safety checks, not a host patch or permission to mutate unsafe targets. The earlier blanket upstream prerequisite is withdrawn. Live implementation and the completion criteria in `PLAN.md` remain incomplete; the runtime is still a fixture-only preview.

Research used read-only commands, the installed SDK and manifests, and public source at [Herdr App v0.1.14, commit `2405bf3`](https://github.com/herdrdev/herdr-app/tree/2405bf388c568c3ed479f05b8e405ccfa44b3f2c) and [researched upstream commit `b721ded`](https://github.com/herdrdev/herdr-app/tree/b721deda985270ec8256552692729a4add389b2a). Their `src/mods.rs` files are identical. No user-mod lifecycle probe or downloaded-code execution was performed. Recheck these contracts when targeting a different host version.

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

- **Public API:** `herdr-app commands` lists 71 commands; the only `mod.*` commands are `mod.clone` and `mod.open`. There is no public all-instance unload or uninstall API. Use existing APIs and a verified local backend; do not add host commands.
- **Discovery:** [`mods.rs`, lines 336–386](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L336-L386) scans immediate mod folders with `main.js`, skips dot-prefixed IDs and uses folder names as runtime IDs. Manifest hints are `place`, `size` and `focusable`; missing or invalid hints default.
  - Read-only inventory can use directory listing and manifests. A manifest does not prove repository identity, ownership or runtime inactivity. The host scan can follow symbolic-link folders; the manager must classify and protect them.
- **Bookkeeping:** [`mods.rs`, lines 99–135](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L99-L135) uses `installed.json` for shipped-file fingerprints. `seen.json` records first-time docking.
  - Neither is a complete community-mod inventory or source registry. Read shipped metadata for protection; do not rewrite host bookkeeping.
- **Visibility:** [`window.rs`, lines 1433–1444](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L1433-L1444) retains copies while their layout, pane or overlay slots exist, including hidden slots. [`mod.open`](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L3302-L3313) toggles one overlay.
  - Removing a file or closing one overlay does not prove all copies stopped. Do not edit layouts or keys to detach a target. Block mutation when dependency or runtime safety cannot be established.
- **Reload and removal:** [`window.rs`, lines 3871–3939](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L3871-L3939) reloads changed loaded mods internally and rescans removed folders. Copy cleanup depends on ownership slots, not folder absence.
  - File-operation success and runtime reload are separate outcomes. Report verified file state and any required full restart; do not claim immediate unload.
- **Full app restart:** [`window.rs`, lines 463–493](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L463-L493) starts a fresh runtime and inventory. On macOS, [closing the window hides the app](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/window.rs#L556-L568); it is not a full quit.
  - Verify any update or removal restart instructions in a disposable profile. Do not restart the user's session automatically.

The installed guide also states that hidden copies and their tasks remain alive and a failed reload keeps the previous version running. Separately, `README.md` records that edits through the external development symbolic link required manager close/reopen during preview validation. That observation is not proof of update or uninstall safety.

### Permissions and file safety

The generated SDK exposes `fs/promises` reads, writes, directory listing, `exists`, `unlink`, empty-directory `rmdir` and `mkdir`. It does not expose `lstat`, `realpath`, `readlink`, atomic rename or recursive removal. A directory entry has only a name and `isDirectory()`.

The [host policy](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mods.rs#L1143-L1152) grants filesystem reads under the user's home and writes under the app folder, plus unrestricted execution and network access. `herdr.exec` uses the user's real environment and credentials. Broad execution capability does not establish ownership or safe paths.

`readTextFile` and compare-and-write `writeTextFile` are separate wrappers. In particular, [`writeTextFile` resolves symbolic-link targets](https://github.com/herdrdev/herdr-app/blob/2405bf388c568c3ed479f05b8e405ccfa44b3f2c/src/mod_files.rs#L26-L74); it is not a no-follow check. The local backend must verify ownership, paths, local changes, dependencies and destination races. Missing safe primitives block the affected action, not independent browsing or discovery. Do not silently add a required runtime or patch Herdr to fill the gap.

## Implementation route without upstream changes

1. Read actual manifests, shipped metadata and manager-owned source records. Keep installation membership separate from runtime activity; enabled-state discovery is not required.
2. Load and validate the real Gallery source. Match normalized repository identity plus recipe and mod-folder paths, not display names.
3. Stage repository downloads and ownership records under `appHome()/data/mod-manager/`, outside the live `mods/` directory. Validate root mods or recipe bundles without running repository scripts or unreviewed code.
4. Use one set of install, update and confirmed-uninstall operations for both pages. Commit only to a verified target, then read back files and source records before reporting success.
5. Protect shipped mods, the running manager, symbolic links, local changes and unsafe active dependencies. Recheck protection immediately before writes; unknown safety must produce a visible rejection.
6. Update manager-installed mods only after fast-forward ancestry and clean-file checks. Retain a recoverable previous revision. Do not merge local edits or replace a live folder without validating watcher and recovery behavior.
7. Do not patch upstream source or binaries or manually edit the generated SDK. Leave shipped files, layouts and keybindings unchanged. Normal SDK generation by Herdr checks is permitted. No enable/disable implementation is part of this route.

### Prior art and limits

- [`jacksonpires/herdr-app-mod-manager`](https://github.com/jacksonpires/herdr-app-mod-manager/blob/f10831597ca506903713e89071cfd296bf5139a9/mods/mod-manager/core.js) separates core installation logic from the native view. Its replacement and recursive-removal behavior does not establish this plan's ownership, local-change or rollback guarantees.
- [`manastalukdar/herdr-pkg`](https://github.com/manastalukdar/herdr-pkg/blob/0fad8c14aed0a0f076b84bfc6f6e9f94c2f9baa4/mods/pkg/pkg.py#L631-L694) documents that replacing a mod folder can leave watchers on the previous folder. Its in-place update approach needs failure testing; its local-edit merging is outside the fast-forward-only requirement.
- [`werlang/herdr-mod-manager`](https://github.com/werlang/herdr-mod-manager/blob/c97ea4cfc2fe581737fbd7ec34f6b17f5771ec1e/mods/mod-manager/main.js#L295-L343) uses folder parking and layout restoration for toggles. That research corrected the earlier blanket upstream blocker, but both toggles and automatic layout changes are now outside scope.

### Open validation gates

- Verify available platform tools and a local backend with no-follow checks, no-replace staging commits, concurrency locks and interruption recovery using temporary roots.
- Establish safe eligibility for update and removal without modifying active dependencies or assuming hidden copies stopped. Reject unsafe or unknown cases.
- Test Gallery → install → update → uninstall, GitHub installation, ownership persistence and state refresh with temporary repositories. Verify cleanup and preservation of existing mods.
- Run trusted native view checks and prepare screenshots. Verify required reload or full restart behavior in a safely isolated profile; record unavailable native checks in the handoff. Source inspection and community claims are not substitutes for these checks.

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

- **Native interaction and unavailable platforms — Mod Manager maintainer.** Prerequisite: implemented scoped operations, passing agent checks, fixture repositories, screenshots and documented platform requirements. Check both themes, keyboard controls, search and scrolling, confirmations, failure feedback and any required full restart in a disposable app profile. Expected result: native behavior matches the automated tests without changing another profile's mods. Prepare safe native checks as agent work where possible; identify genuinely unavailable checks and do not claim release readiness for unverified behavior.
- **Upstream boundary.** No Herdr maintainer action, upstream API addition or host patch is a prerequisite of this plan. Unsafe local operations remain rejected until their own validation gates pass; do not solve them by changing Herdr. Enable/disable remains excluded.
