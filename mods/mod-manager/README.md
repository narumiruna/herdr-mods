# Herdr Mod Manager

A native Herdr App mod for browsing the Gallery, discovering installed mods, installing trusted public GitHub mods, checking updates, and confirmed uninstall. It has no enable/disable controls.

## Open in Herdr

Herdr loads the JavaScript files in this mod directory directly. No build, Node.js, or npm packages are required at runtime. Copy or link this directory (`mods/mod-manager/` in the repository) to `mods/mod-manager` under the app home. A development link must point to the nested mod directory, not the repository root:

```text
~/.config/herdr-app/mods/mod-manager → /absolute/path/to/herdr-mod-manager/mods/mod-manager
```

From the repository root:

```sh
herdr-app check mods/mod-manager
herdr-app do mod.open --name mod-manager
```

Root `npm start` also toggles the dialog. It does not create or change the installation link. The profile owner must fully quit Herdr before changing an existing link from the old repository root to the nested mod directory. Reopen Herdr and verify loading after the link change; repository checks do not verify the live profile. Escape or Close closes it. External development-link edits can require closing and reopening the dialog. There is no `src` or `dist` output. The local sidebar launcher is described below.

## Browse and install

- **Gallery** loads the same public mod index as the Gallery website: [`assets.herdr.dev/mods/index.json`](https://assets.herdr.dev/mods/index.json). It supports search, source filters, and batches of 50 cards. Search covers the full list, including folder IDs and cards not yet rendered.
- **Installed** reads actual local manifests. GitHub, development, local, and shipped sources are distinct. A name alone does not establish source identity or ownership. Gallery and Installed share verified membership.
- **From GitHub** accepts a public `https://github.com/owner/repository` URL, with an optional `.git` suffix. Leave **Mod directory** blank for a repository-root mod, or enter the exact case-sensitive relative directory containing `mod.json` and `main.js`, such as `mods/github-issues-prs`. Installation uses the repository's default branch. Branch/tree URLs, credentials, SSH, private repositories, and local paths are not accepted.
- Each verified GitHub card has **Source**. It opens that card's recorded repository at its commit and exact case-sensitive recipe directory, without installing anything. When Update is available, **Update source** opens the checked update candidate instead of the older installed commit. Without a recorded commit, Source opens the repository root. For a recipe bundle, find the selected mod folder within that source directory. If the browser fails, the exact URL stays visible for manual review. URL delivery does not verify browser display.
- Gallery selections preserve the exact recipe path and mod folder. For a bundle, select the specific mod card. The manager does not apply recipe layouts or keybindings or install companion mods automatically.
- A Gallery failure is shown as an error, not an empty successful list. A slow Gallery request does not block an otherwise-ready Installed page or its operations. **Show warnings** reveals source and recovery warnings in a scrollable list, 20 at a time.

For example, to install a mod from this repository:

1. Enter `https://github.com/narumiruna/herdr-mods` in **Repository URL**.
2. Enter `mods/github-issues-prs` in **Mod directory**.
3. Select **Install**. The installed folder is `<app-home>/mods/github-issues-prs`.

The final directory component becomes the installed folder name, even if the manifest has a different `id`. Directory components must contain only ASCII letters, digits, underscores, periods, or hyphens, and must start with a letter, digit, or underscore. The final component must start with a letter or digit. Absolute paths, `.` or `..` components, backslashes, and trailing slashes are not accepted. Leading and trailing whitespace is removed. Each directory component is limited to 128 characters; the complete path is limited to 1024 characters and 64 components.

Install one mod at a time. Different directories from the same repository can be installed together, but existing destination folders are never overwritten. The selected directory must contain the mod files directly; it does not select a recipe bundle or install sibling mods. Use a specific Gallery card for a recipe bundle. Source records retain the exact directory for discovery, updates, and uninstall.

The index has a versioned metadata schema, repository commits, recipe paths, and mod-folder names. It does not certify JavaScript safety, semantic versions, permissions, or host compatibility. Listing and card counts change. The manager does not scrape HTML or invent versions from commits.

**Mods are trusted code. They can run programs, use the network, and read files with your account's access. Review the repository and code before selecting Install.** Structural validation never runs the downloaded entry, repository scripts, a package manager, or a native check of the downloaded code.

Installation accepts an object `mod.json` and nonempty UTF-8 root `main.js` in the selected package. Omitted placement and valid `none`, `left`, `right`, `top`, and `bottom` placements remain supported. Manifest fields are checked; manifests are not rewritten. Herdr can dock and run a newly discovered mod immediately. The manager itself does not edit layouts or keybindings.

Downloads are staged outside `mods/`. The Git staging phase has a 150-second shared budget; each Git command has at most 120 seconds. This budget does not interrupt live publication or rollback. Repository file sizes come from one Git tree listing, not one process per file. Complete validated packages are published with atomic no-overwrite rename. Existing destinations, source conflicts, symbolic links, submodules, and unsafe paths or modes are refused. Hooks, credential helpers, configured checkout filters, prompts, and global/system Git configuration are disabled. Unsupported filesystems and cross-device publication fail closed. File limits and timeouts do not impose a complete disk-use limit on Git history downloads.

## Requirements and read-only mode

Gallery and native read-only inventory work without the local backend. File operations require **Git, uv, and an already available Python 3.9 or newer** on a supported POSIX system. Development checks use Python 3.14. The backend requires no-follow directory handles, file locking, hardlinks, and atomic no-overwrite rename. Keep the adjacent [MIT license](LICENSE) with copied source. macOS and Linux filesystem tests are required; Windows mutation remains rejected until a safe native implementation is validated. Read-only browsing remains available there.

The runner uses isolated standard-library Python with no project discovery or downloads:

```sh
uv run --no-project --offline --no-python-downloads python -I -S --version
git --version
```

Install missing tools separately. The mod does not install tools, Python versions, or dependencies. A backend failure leaves inventory read-only, displays the reason, and does not adopt ownership. All file actions and update checks remain blocked, including From GitHub installation. **Retry local backend** refreshes Installed from any page; actions return only after verified discovery succeeds. Source labels can be incomplete in this fallback because native directory listing cannot verify Git provenance or file identities. A stopped process or invalid response after a mutation reports an unverified outcome, not a tool-installation diagnosis or a verified rollback. Refresh Installed and preserve recovery evidence before retrying.

## Ownership migration

Discovery never migrates data. If an older manager store is detected, normal file actions remain blocked until **Review migration** and explicit confirmation. The summary lists each folder, absolute path, source, and package/Git kind. Cancel changes nothing.

Two legacy stores are recognized:

1. PR #5: a version 1 `registry.json`, file/inode baselines, and a persistent regular-file/flock lock.
2. PR #6: real Git checkouts with `.git/herdr-mod-manager.json`, formerly protected by a directory lock.

The new registry and regular-file lock use version 2. Valid, disjoint records can migrate together. Migration verifies both source formats, records durable preimages, and upgrades an existing regular lock in the same inode while holding its exclusive flock. Older writers cannot safely operate against version 2; return to read-only use or restore a verified complete profile backup instead of bypassing the protocol.

Git checkouts remain Git checkouts. Migration does not remove `.git`, local branches, objects, or history. Unknown directories are not adopted. Dirty checkouts, unknown generated files, linked Git metadata, source collisions, altered backups, active writers, or unverified interrupted state block migration.

A legacy **directory lock** cannot be proved stale from its name or age. It is not removed automatically. Do not delete it, the registry, or a journal just to enable actions. Have the profile owner inspect the original operation and backups before resolving it.

Interrupted migration has a separate, retained journal. Its immutable intent is pinned by hash and inode in a separate receipt; a complete-phase label also needs a completion receipt. A verified pending journal can be resumed only through another explicit confirmation; altered records or conflicting preimages remain blocked. Migration on the user's actual profile is a separate owner action and is not performed by development tests.

## Updates and uninstall

Use **Check updates** to obtain a validated fast-forward candidate. The current mod and checked/total count update during the batch. **Stop checks** waits for the current repository, then stops before the next one; it does not kill a subprocess. Closing the dialog also stops further checks. Completed candidates remain available. The final message reports the checked and failed counts instead of claiming that a partial batch completed. A changed identity or protection state stops a stale batch. **Update** uses only that checked revision. Preparation rejects a source revision that no longer matches the checked candidate. Candidate preparation finishes before a fresh runtime/dependency snapshot and commit request.

All mutations recheck ownership, identity, file state, and configured/runtime dependencies. Shipped mods, the running manager, development links, dirty targets, unsafe paths, and active or configured dependencies are protected. Unknown dependency safety blocks mutation. Inactive layouts and keybindings matter too; unrelated display names or theme strings are not mod references.

Updates do not merge user edits, rebase, reset, clean, or stash an installed mod. Untracked files also block mutation, including generated `gpui-kit.d.ts` or `jsconfig.json`. A filename does not prove manager ownership. Review and preserve those files outside the checkout before retrying.

Migrated Git checkouts keep their recorded branch and full Git history. Git writes only to private preparation; live apply publishes pinned pack/index data through no-follow directory descriptors and native Git lock files. It verifies the exact old ref and publishes the checked ref before working files and the index. Existing file modes and reflogs are retained; manager updates do not append a reflog entry. An occupied ref lock is rejected without leaving old HEAD and new working files. Rollback restores only verified manager changes; an external conflict retains a blocking journal rather than discarding data.

**Uninstall** requires name/path/revision/identity confirmation. A stale confirmation is rejected. Package uninstall removes verified manager-owned files; retained source history is not a promise that a revision can be downloaded again. For a migrated Git checkout, confirmation shows the exact retained archive path: the complete checkout and history move outside `mods/` and are **not deleted**. Archives are not automatically cleaned up.

Closing the manager does not cancel a mutation transaction. The transaction starts in an unowned task; an independent view-owned task redraws only while the view remains open. Do not externally edit a target, run another Git writer there, or quit Herdr during an operation.

File success does not prove runtime unload or reload. Herdr can retain hidden copies, and a broken reload can keep old code running. A full app restart may be needed. On macOS, closing the red window button can hide the app; it is not a full quit. The manager does not restart Herdr, its terminals, or dependent programs. Stop programs started by a mod separately when needed.

## Self-update

Self-update is an **explicit external CLI operation**, not the Gallery **Update** action. There is no automatic or live self-update. The running manager remains protected in the UI and file backend.

The command supports an ordinary, complete Git checkout of this official repository on `main`, on macOS or Linux. Run the updater from the installation to change. The script is in `mods/mod-manager/`, but it reports and updates the entire resolved Git checkout, including every workspace and shared file. Review all repository changes. For a development link, it does not replace the link. The exact reported checkout path must be confirmed during apply. Package copies, shipped copies, linked worktrees, shallow clones, detached HEAD, development branches, and non-official origins are not supported.

Original updaters in older flat installations require manager files at the repository root and cannot update directly to this monorepo layout. Preserve the old checkout, create a fresh clone, and have the profile owner change the development link to `<checkout>/mods/mod-manager`. Older installations without `self_update.py` also need manual migration. Do not discard local files with reset or clean.

A checkout must have **no staged, unstaged, untracked, or ignored files**. This includes `node_modules`, generated SDK files, and Python caches. Preserve these outside the checkout before use; do not delete them with `git clean`. Local Git filters, includes, URL rewrites, attributes, and other unsupported settings also block the command. The updater does not change configuration or adopt registry ownership. A normal development checkout can therefore remain ineligible.

Use the same separately installed Git, uv, and cached Python 3.9+ as the file backend. Process inspection also requires `ps`. No Node.js, Python packages, or tool downloads are needed. From the repository root:

```sh
uv run --no-project --offline --no-python-downloads python -I -S mods/mod-manager/self_update.py check
```

A successful check returns JSON with `path`, `installedCommit`, `targetCommit`, and `updateAvailable`. It downloads the fixed official HTTPS `main` into temporary storage without changing the installation. Review and trust both commits. These are source commits, not signed release artifacts or semantic versions.

If an update is available, preserve a complete checkout backup. **Fully quit every Herdr app instance**, including hidden windows. Use an external terminal; a terminal inside Herdr can lose its owner during quit. Do not start Herdr or another Git writer until the command finishes. Substitute the exact values from `check`:

```sh
uv run --no-project --offline --no-python-downloads python -I -S mods/mod-manager/self_update.py apply \
  --expected-path /absolute/path/from/check \
  --expected-commit INSTALLED_COMMIT_FROM_CHECK \
  --target-commit TARGET_COMMIT_FROM_CHECK \
  --app-stopped
```

`apply` checks the source again and rejects a changed official `main` tip. It verifies ancestry in the official source, serializes competing updaters with a persistent `.git/herdr-self-update.lock`, and applies only the confirmed fast-forward. Hooks, credential helpers, prompts, global/system Git settings, and inherited Git settings are disabled. Unknown local configuration, hidden index flags, unsafe source trees, non-ASCII source paths, and linked Git metadata are rejected. No Git hooks, package scripts, or candidate code are executed.

Process inspection rejects known GUI executable names `Herdr`, `herdr`, and `herdr-app` across profiles. It does not reject `herdr-core`, which can keep terminals alive separately. Unavailable or malformed process evidence blocks apply. Process inspection cannot identify renamed executables, prove unrestricted process visibility, or prevent a concurrent launch. `--app-stopped` is the owner's confirmation, not a host lifecycle lock.

Success verifies the installed commit and tracked file bytes/modes. It does not prove runtime reload. Reopen Herdr and verify the manager loads before normal use.

### Failed self-update

Git fast-forward checkout is **not an atomic filesystem transaction**. A failed or interrupted Git operation can leave old HEAD with new working files. No automatic reset, clean, stash, downgrade, lock deletion, or restart is attempted. Error JSON includes the confirmed commits and, when inspection is safe, current HEAD and working state. A terminated process might return no JSON.

Keep Herdr stopped. Preserve the checkout, Git metadata, backup, and reported commits. Inspect `git status` and have a maintainer verify recovery before restarting. Do not force a retry or bypass a Git lock. Recovering source files does not downgrade or restore manager registry data; use a verified complete profile backup when state recovery is needed.

## State and recovery

Manager data stays under `appHome()/data/mod-manager/`:

| Path                            | Purpose                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `registry.json`                 | Version 2 source identity, commit, file baseline, and package/Git ownership                |
| `lock`                          | Version 2 persistent regular file protected by flock                                       |
| `migration.json`, `migration-*` | Migration workspaces, immutable intent receipts, completion receipts, and source preimages |
| `.metadata-*`                   | Retained metadata preimages from verified retirement/publication                           |
| `transaction.json`              | Intent for an interrupted or unverified live-file transaction                              |
| `work-*`, `stage-*.json`        | Downloads, pinned preparations, receipts, backups, and recovery evidence                   |
| `archive-*`                     | Complete Git checkouts retained after confirmed uninstall                                  |

Recovery steps:

1. Stop starting file actions. Do not delete locks or journals or run a destructive Git command.
2. Preserve the complete profile, registry, journals, and their named workspaces. Inspect the exact target and recorded identities, hashes, revisions, and preimages without following links.
3. Resume only a migration whose current summary verifies its journal and backups. An unverified live transaction requires maintainer recovery; the manager must not guess which user edits to discard.
4. Verify either the complete previous state or the complete new state before removing a recovery marker. An uncertain rollback stays blocked with its original evidence. Restore a verified complete profile backup when independent recovery cannot be established.

Prepared but unused updates and retained metadata preimages can remain outside `mods/`. They are not committed installs. If a preparation receipt may have been published, a later preparation failure retains its pinned workspace rather than leaving a receipt with missing files. Registry publication compares the original hash and inode after preserving the old file; it does not silently overwrite a later edit. Preserve receipts and workspaces referenced by a transaction; inspect unused data before manual cleanup. Complete migration preimages and Git uninstall archives are retained deliberately. Do not treat an older binary as a migration rollback tool.

See [lifecycle contracts and integration design](docs/lifecycle-prerequisites.md) for host boundaries and protocol details.

## Sidebar launcher

The same `mod-manager` installation provides both the dialog and a sidebar footer. In a personal layout cloned from `main`, use this footer block:

```json
{
  "id": "sidebar-footer",
  "type": "block",
  "content": {
    "mod": "mod-manager",
    "props": { "footer": true }
  },
  "size": { "px": 125 }
}
```

Keep the header on shipped `workspace-chrome`. Without `footer: true`, the mod keeps its existing dialog behavior. The footer does not create a manager session, inputs, or background tasks. Gallery and inventory load only when the dialog opens.

The footer shows **Mods**, **Layout Manager**, **Settings**, and **Add machine** in that order. Mods toggles the `mod-manager` dialog. Layout Manager toggles the separately installed `layout-manager` dialog; it does not install that mod or create a panel. The other rows retain their original actions. Below 160 px sidebar width, rows show icons with tooltips. The Settings update indicator follows the app's update-ready state. Icons come from shipped `workspace-chrome`, including when the manager is installed through an external development link.

### Migrate an existing sidebar layout

This repository no longer distributes the separate `mod-manager-sidebar` clone. No automatic layout migration is performed. A personal layout such as `~/.config/herdr-app/layouts/herdr-with-mods.json` remains outside this repository.

The profile owner must perform these steps:

1. Preserve the personal layout and old sidebar installation outside the checkout before updating it. Fully quit Herdr before changing installation files or links.
2. Keep the manager installation at `<app-home>/mods/mod-manager`. Change the personal footer's mod reference from `mod-manager-sidebar` to `mod-manager`, using the block above. Keep `footer: true`, the 125 px height, and the shipped header.
3. Remove the old installed sidebar only after confirming that no personal layout or keybinding still references it.
4. Reopen Herdr. Verify that the footer loads, Mods opens and closes the dialog, and the footer remains usable after closing it. Old runtime copies can require a full app restart.

Shipped mods, layouts, settings, and keybindings must not be edited. Repository checks use disposable profiles; they do not change or verify the live profile. Personal clones survive restarts but do not receive Herdr's automatic layout updates.

### Sidebar recovery

If the combined footer fails, fully quit Herdr and restore the saved personal layout and old sidebar installation. Alternatively, use the shipped `main` layout to remove the custom footer dependency. Keep the manager installation available for dialog use. Reopen Herdr and verify loading. Do not reset or clean the checkout, delete manager data, or change registry ownership for this UI rollback.

When Herdr is running, these commands select the personal layout or the shipped fallback:

```sh
herdr-app do layout.switch --name herdr-with-mods
herdr-app do layout.switch --name main
```

### Sidebar verification handoff

1. **Profile owner — actual layout migration.** After repository gates pass, preserve the layout and old sidebar installation, fully quit Herdr, and apply the migration steps above. Expected result: Mods toggles the dialog while the footer stays usable. Actual-profile loading, old runtime copies, and restart behavior remain unverified by fixtures. Do not claim automatic migration or completed profile migration before this check.
2. **Platform maintainer — native interaction and visual review.** After native fixtures pass, use a disposable profile with the documented block. Check both themes, expanded/narrow widths, tooltips, icons, the update indicator, all four actions, and repeated open/close cycles. Expected result: the existing footer behavior remains intact and closing the dialog leaves the footer active. Initial-render checks do not prove appearance, native event routing, or footer/dialog coexistence. Do not claim native interaction acceptance on unreviewed platforms. Windows mutation restrictions remain unchanged.

These handoffs do not authorize automated profile edits, app restart, or release.

## Development checks

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.15. Shared development tools and the lockfile are at the repository root. Run from the repository root:

```sh
npm ci
npm run check:mod
npm run ci
git diff --check
```

Root commands delegate to the npm workspaces. To select only this mod, use `npm test --workspace herdr-mod-manager` or `npm run check:mod --workspace herdr-mod-manager`. `check:mod` uses a disposable `HERDR_APP_HOME` for the native entry check and each fixture check. It generates the ignored real SDK at `mods/mod-manager/gpui-kit.d.ts` for no-emit JavaScript type checks and runs 24 native view fixtures, including read-only, warnings, update progress, and expanded/narrow footers with and without an app update indicator. `ci` runs Biome, JavaScript model/runtime/UI tests, real JavaScript-to-Python lifecycle tests, Python filesystem/fault tests, and type checks. `check:views` runs only the native view fixtures through `mods/mod-manager/scripts/check-views.mjs`. These tests use an isolated `HERDR_APP_HOME` for all pages and loading, error, confirmation, migration, protection, and archive states. They are tests of the live view, not a product preview mode.

Tests use disposable profiles and real local Git repositories. Test-only transport injection is not a production local-install mode. Cross-version fixtures cover both stores, mixed ownership, explicit confirmation, directory/busy/corrupt locks, retained Git data, ref failures, and recovery. Never use the user's mods for lifecycle tests.

Hosted Linux CI runs formatting and fixture tests. Real-SDK type checks and native rendering also run against the installed local Herdr version. No build output is produced.

## External handoff before release

1. **Profile owner — actual migration.** After disposable migration/recovery checks pass, make and verify a complete profile backup, review the exact migration summary, and stop conflicting writers. Run only the explicitly confirmed migration. Actual-profile migration is not established by fixture tests; unattended migration must remain disabled.
2. **Platform maintainer — native interaction and runtime behavior.** Use a disposable profile and fixture repository to inspect both themes, native keyboard controls, scrolling/batches, source failures, confirmation/cancel, close-during-operation, and full-restart instructions. Check typing, focus, scrolling, validation errors, and sibling-mod installation through the new From GitHub Mod directory field within the fixed dialog size. Verify runtime copies and dependent programs separately. Native initial-render checks do not prove these paths; retain that release restriction until review.
3. **Platform maintainer — unavailable platforms.** Validate native filesystem, migration, and UI behavior before claiming support on a platform not exercised by the agent. Windows mutation remains unsupported, with read-only browsing available. A stale screenshot is not visual acceptance, and successful URL delivery is not proof that a browser displayed the page.
4. **Profile owner — actual self-update and restart.** After merge and disposable updater tests, verify a complete checkout backup, review the reported path and commits, fully quit all Herdr app instances, and apply from an external terminal without concurrent Git writers. Reopen Herdr only after verified success or maintainer-verified recovery, then verify manager loading and browsing. Disposable Git tests do not establish actual-profile update or restart behavior. Automatic/live self-update remains unsupported.

These handoffs do not authorize automated user-profile mutation, account actions, app restart, or release. No package publication, version tag, or release workflow dispatch is part of this change.
