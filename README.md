# Herdr Mod Manager

A native Herdr App mod for browsing real community mods and managing verified installations. The live interface has no enable/disable controls.

## Use

- **Gallery** loads the public Herdr mod index inside the manager. Search names, descriptions and repositories without case sensitivity. Empty search shows all entries. Recipe bundles have one card per mod folder.
- **Installed** lists actual local manifests, including mods absent from the Gallery. Source filters separate GitHub, development, local and shipped mods. Unverified sources are not guessed from display names.
- **Install** copies a selected Gallery mod after file and manifest checks. **From GitHub** accepts a public HTTPS repository URL for a root `mod.json`/`main.js` mod. Ambiguous recipe bundles require the exact Gallery selection instead.
- **Check updates** checks eligible manager-owned mods explicitly. **Update** accepts only the checked fast-forward revision and rejects local edits.
- **Uninstall** requires confirmation with the name and absolute path. Cancel changes nothing. A stale confirmation cannot remove a different or reinstalled mod.
- Lists render in batches of 50; **Show more** reveals another batch. Search always covers the full list, including cards not yet rendered.
- Loading, source errors, update failures and protection reasons remain visible. A failed fetch is not an empty successful Gallery.

Installation membership does not establish whether a mod is running. The manager does not open newly installed mods, change layouts or keybindings, or restart Herdr.

## Requirements and protection

Validated against Herdr App 0.1.14. Herdr loads the root JavaScript files directly. No build, Node.js or npm package is needed to open the mod.

File management uses an optional local backend with **Git**, **uv** and an already available **Python 3.9 or newer** on a POSIX system with no-follow directory handles, file locking, hardlinks and atomic no-replace rename (macOS or supported Linux filesystems). Staging and live targets must be on the same filesystem. Development validation uses Python 3.14 on macOS; Linux filesystem fixtures run in CI. Native Linux interaction and Windows file management are not verified. Windows mutation is rejected rather than using an unsafe fallback.

The runner uses offline mode:

```sh
uv run --offline --no-project python --version
git --version
```

The mod does not install tools, Python versions or dependencies automatically. If the backend is unavailable, Gallery and native read-only inventory remain available; file actions report the missing prerequisite. Existing mods are not adopted automatically.

Update and removal are limited to clean, verified manager-owned directories. Shipped mods, the running manager, symbolic links, hardlinked files, local edits, unsafe paths and configured or active dependencies are protected. Unknown dependency safety blocks mutation. Configured references are checked conservatively, including inactive layouts and keybindings. Every untracked file also blocks mutation, including generated-looking editor helpers: a filename alone does not establish ownership. Review those files separately rather than letting the manager delete or adopt them. Protection is rechecked before writes, not only when a card is rendered.

The manager does not patch or fork upstream Herdr, replace its binary, manually edit its SDK, or change shipped interface files.

## Installation limits and trust

The source is [`assets.herdr.dev/mods/index.json`](https://assets.herdr.dev/mods/index.json), used by the [Herdr Gallery](https://herdr.dev/gallery/?type=mods). The index supplies repository commits, case-sensitive recipe paths and mod-folder names, but not a semantic mod version or compatibility guarantee. The UI does not invent a version.

Only public GitHub HTTPS repositories are supported. Credentials, SSH, local paths, repository install scripts, hooks, checkout filters, symlinks, gitlinks and unsafe file modes or paths are not accepted. Downloads are staged outside `mods/`. Existing destinations and conflicting source identities are rejected, not overwritten or renamed.

A downloaded mod must contain an object `mod.json`, `place: "none"`, and nonempty UTF-8 `main.js`. Other placements are rejected to avoid automatic docking and layout changes. Validation is static: it checks metadata and file safety, not JavaScript syntax, API compatibility or trust. It never executes the downloaded entry or runs a native check of it.

Community code is not reviewed by Herdr. Read the repository, recipe and code before installing or opening a mod. Mods can run programs, use the network and read files with your account's access. A successful copy is not a safety certification.

## Open in Herdr

```sh
herdr-app check .
herdr-app do mod.open --name mod-manager
```

Herdr must discover the checkout under its `mods/mod-manager` path. The development link is:

```text
~/.config/herdr-app/mods/mod-manager → /Users/narumi/src/herdr-mod-manager
```

`npm start` also toggles the dialog. Escape or **Close** closes it. External development-link edits can require closing and reopening the manager. That observation does not prove a downloaded mod reloads.

Herdr provides `gpui-kit`, `gpui-base`, `herdr` and `fs/promises`. Runtime entry and model files remain direct JavaScript, with no `src/` or `dist/`. `operations.py` has one separate purpose: verified local filesystem and Git operations.

Icons use Herdr's shipped assets. The development symbolic-link target is never eligible for updates or uninstall.

## Reload and lifecycle limits

Herdr 0.1.14 retains copies while their layout, pane or overlay slots exist, including hidden copies. Removing files does not establish that every runtime copy stopped. A failed reload can keep old code running.

Updates download and validate outside the live directory, then obtain a fresh runtime snapshot before committing the checked revision. They keep the live root directory identity, replace complete files and write the entry last. Existing inodes are not truncated. This avoids replacing the watched mod directory; it does not guarantee hot reload.

Do not open or externally modify a target during a file operation. Herdr provides no atomic lock between its loader and external filesystem changes. If dependency checks fail or recovery cannot be verified, the operation is rejected or left blocked with an error, not reported as successful unload.

A full app restart can be required before removed or updated runtime code is gone. On macOS the red window button hides Herdr; it is not a full quit. Quit and reopen the app yourself when needed. The manager does not quit, update or restart Herdr or its terminals. Programs started by a mod can outlive its view or app; stop such dependent programs separately before changing their files.

## State and recovery

Manager data stays under `appHome()/data/mod-manager/`, outside the live mods directory:

- `registry.json` records source repository, recipe/mod folder, commit, destination, ownership token and verified file baseline. Uninstalled source information remains in its history for reinstallation.
- `lock` serializes file operations across manager views and processes.
- `work-*/` holds unexecuted downloads, prepared updates and rollback data.
- `transaction.json` records intent before a multi-step live change. Successful verification removes it.

A failed operation refreshes actual local state. The UI does not simulate a rollback or claim success from the registry alone. An interrupted or unverified rollback blocks later mutations; read-only browsing remains available.

If recovery is required:

1. Stop starting file actions. Preserve `transaction.json`, `registry.json` and the workspace named by the transaction.
2. Inspect the recorded target, expected inode/hash information, staged files and preserved original or displaced files. Do not follow a symbolic link or overwrite unrelated files.
3. Restore or verify the recorded file state and the matching registry from the retained data. A maintainer must resolve any user edits or ownership conflict rather than guessing.
4. Remove a recovery marker only after the files and ownership records are independently verified. Never delete the registry or lock to bypass protection, and never retry a destructive action blindly.

A prepared update left by closing the manager before commit has not changed live files. Its `work-<stageToken>/prepared.json` and `prepared/<id>/` files have a paired `stage-<stageToken>.json` receipt. Consumption moves them to `consumed.json` and `receipt.json` in the workspace. Unused preparations can remain outside `mods/`; inspect both the receipt and workspace, verify ownership, and ensure no transaction refers to them before cleanup. No background cleanup removes unknown data.

Recovery workspaces can contain `backup/` copies, `staged/` copies, original inodes under `displaced/`, unexpected rollback objects under `retired/`, and original directories under `displaced-dirs/`. Preserve all of these until recovery is independently verified.

Uninstall is not automatically reversible. Its confirmation states that files are removed; retained source records are not a promise that a repository or revision will remain available.

## Sidebar launcher

The local `herdr-with-mods` layout has a **Mods** button directly above **Settings**. It toggles the manager dialog and uses an icon with a tooltip when the sidebar is collapsed.

- Layout: `~/.config/herdr-app/layouts/herdr-with-mods.json`, cloned from `main`.
- Footer mod: `~/.config/herdr-app/mods/mod-manager-sidebar/`, cloned from `workspace-chrome`.
- Only the cloned layout's `sidebar-footer` uses this mod; its height is 97 px instead of 69 px.
- The new row, before the Settings row, is:

  ```js
  .child(row("mods", "layers", "Mods", false, () => run("mod.open", { name: "mod-manager" })))
  ```

Herdr's shipped layout, shipped mods, Settings screen, and keybindings are unchanged. The custom layout is active now. These commands select the custom layout or return to the original:

```sh
herdr-app do layout.switch --name herdr-with-mods
herdr-app do layout.switch --name main
```

The launcher configuration is local to this Herdr installation and is not included in this repository. Clones survive restarts but do not receive Herdr's automatic layout and mod updates. Keep the custom layout selected to retain the button.

## Checks

Development tools require Node.js 26, Git, uv and cached Python 3.14. Install npm dependencies and let Herdr generate the ignored real SDK before type checks:

```sh
npm ci
npm run check:mod
npm run ci
npm run check:preview
herdr-app status
```

- `ci` runs Biome, JavaScript model/runtime/view/integration tests, Python lifecycle tests and no-emit JavaScript type checks against Herdr's generated SDK.
- Python tests use temporary profiles and real local Git fixture repositories. The transport injection exists only in tests; production cannot enable `file://` installation.
- Integration tests connect the real JavaScript model to the Python backend for Gallery → install → update → confirmed uninstall, GitHub installation, checked-revision drift and unusual local metadata. A separate production HTTPS smoke test installed and uninstalled this public repository in a disposable profile and rejected a missing repository, without executing downloaded code.
- `check:preview` checks trusted temporary native states for all three pages, loading/errors, no results, confirmation, progress, protection and update feedback. It injects fixture I/O and removes its temporary files; it does not change installed mods or fetch repositories.
- GitHub CI runs formatting and fixture tests on Linux. Real SDK type checks and native checks require an installed Herdr App and are also required locally.

Mocked handler tests are not native keyboard or layout tests. Do not use the user's real mods for lifecycle validation.

## Native review handoff

Dark-theme captures were inspected for the live Gallery, Installed and From GitHub views:

- `/tmp/herdr-mod-manager-live-gallery.png`
- `/tmp/herdr-mod-manager-live-installed.png`
- `/tmp/herdr-mod-manager-live-github.png`

The live Gallery and read-only inventory were inspected without installing, updating or removing a user mod. Non-default captures used temporary initial-view changes, which were removed; the default remains Gallery. Final check evidence is recorded in the pull request.

A maintainer with the target platform must review both themes, native search and scrolling, batch navigation, keyboard controls, confirmation/cancel and error feedback. Use a disposable profile and fixture repository for lifecycle interaction, not the user's installed mods. Verify any full restart instructions there.

Expected result: native behavior agrees with fixture tests, Gallery and Installed have the same membership, failed operations never show success, and other profiles remain unchanged. Native keyboard dispatch, both-theme usability, live lifecycle restart behavior and unavailable-platform interaction remain unverified until that review. Do not claim release readiness for those paths.

See [live management research and constraints](docs/lifecycle-prerequisites.md) for the version-pinned source evidence and platform limits.
