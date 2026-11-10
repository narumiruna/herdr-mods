# Herdr Mod Manager

A native Herdr App mod for browsing the Gallery, discovering installed mods, installing trusted public GitHub mods, checking updates, and confirmed uninstall. It has no enable/disable controls.

## Open in Herdr

Herdr loads the root JavaScript files directly. No build, Node.js, or npm packages are required at runtime. Put this repository in `mods/mod-manager` under the app home, or use the existing development link:

```text
~/.config/herdr-app/mods/mod-manager → /Users/narumi/src/herdr-mod-manager
```

```sh
herdr-app check .
herdr-app do mod.open --name mod-manager
```

`npm start` also toggles the dialog. Escape or Close closes it. External development-link edits can require closing and reopening the dialog. There is no `src` or `dist` output. The local sidebar launcher is described below.

## Browse and install

- **Gallery** loads the same public mod index as the Gallery website: [`assets.herdr.dev/mods/index.json`](https://assets.herdr.dev/mods/index.json). It supports search, source filters, and batches of 50 cards. Search covers the full list, including folder IDs and cards not yet rendered.
- **Installed** reads actual local manifests. GitHub, development, local, and shipped sources are distinct. A name alone does not establish source identity or ownership. Gallery and Installed share verified membership.
- **From GitHub** accepts `https://github.com/owner/repository`, with an optional `.git` suffix, for a repository-root mod. Branch/tree URLs, credentials, SSH, private repositories, and local paths are not accepted.
- Gallery selections preserve the exact recipe path and mod folder. For a bundle, select the specific mod card. The manager does not apply recipe layouts or keybindings or install companion mods automatically.
- A Gallery failure is shown as an error, not an empty successful list. A slow Gallery request does not block an otherwise-ready Installed page or its operations.

The index has a versioned metadata schema, repository commits, recipe paths, and mod-folder names. It does not certify JavaScript safety, semantic versions, permissions, or host compatibility. Listing and card counts change. The manager does not scrape HTML or invent versions from commits.

**Mods are trusted code. They can run programs, use the network, and read files with your account's access. Review the repository and code before selecting Install.** Structural validation never runs the downloaded entry, repository scripts, a package manager, or a native check of the downloaded code.

Installation accepts an object `mod.json` and nonempty UTF-8 root `main.js` in the selected package. Omitted placement and valid `none`, `left`, `right`, `top`, and `bottom` placements remain supported. Manifest fields are checked; manifests are not rewritten. Herdr can dock and run a newly discovered mod immediately. The manager itself does not edit layouts or keybindings.

Downloads are staged outside `mods/`. Complete validated packages are published with atomic no-overwrite rename. Existing destinations, source conflicts, symbolic links, submodules, and unsafe paths or modes are refused. Hooks, credential helpers, configured checkout filters, prompts, and global/system Git configuration are disabled. Unsupported filesystems and cross-device publication fail closed. File limits and timeouts do not impose a complete disk-use limit on Git history downloads.

## Requirements and read-only mode

Gallery and native read-only inventory work without the local backend. File operations require **Git, uv, and an already available Python 3.9 or newer** on a supported POSIX system. Development checks use Python 3.14. The backend requires no-follow directory handles, file locking, hardlinks, and atomic no-overwrite rename. macOS and Linux filesystem tests are required; Windows mutation remains rejected until a safe native implementation is validated. Read-only browsing remains available there.

The runner uses isolated standard-library Python with no project discovery or downloads:

```sh
uv run --no-project --offline --no-python-downloads python -I -S --version
git --version
```

Install missing tools separately. The mod does not install tools, Python versions, or dependencies. A backend failure leaves inventory read-only, displays the reason, and does not adopt ownership. Source labels can be incomplete in this fallback because native directory listing cannot verify Git provenance or file identities.

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

Use **Check updates** to obtain a validated fast-forward candidate. **Update** uses only that checked revision. Preparation rejects a source revision that no longer matches the checked candidate. Candidate preparation finishes before a fresh runtime/dependency snapshot and commit request.

All mutations recheck ownership, identity, file state, and configured/runtime dependencies. Shipped mods, the running manager, development links, dirty targets, unsafe paths, and active or configured dependencies are protected. Unknown dependency safety blocks mutation. Inactive layouts and keybindings matter too; unrelated display names or theme strings are not mod references.

Updates do not merge user edits, rebase, reset, clean, or stash an installed mod. Untracked files also block mutation, including generated `gpui-kit.d.ts` or `jsconfig.json`. A filename does not prove manager ownership. Review and preserve those files outside the checkout before retrying.

Migrated Git checkouts keep their recorded branch and full Git history. Git writes only to private preparation; live apply publishes pinned pack/index data through no-follow directory descriptors and native Git lock files. It verifies the exact old ref and publishes the checked ref before working files and the index. Existing file modes and reflogs are retained; manager updates do not append a reflog entry. An occupied ref lock is rejected without leaving old HEAD and new working files. Rollback restores only verified manager changes; an external conflict retains a blocking journal rather than discarding data.

**Uninstall** requires name/path/revision/identity confirmation. A stale confirmation is rejected. Package uninstall removes verified manager-owned files; retained source history is not a promise that a revision can be downloaded again. For a migrated Git checkout, confirmation shows the exact retained archive path: the complete checkout and history move outside `mods/` and are **not deleted**. Archives are not automatically cleaned up.

Closing the manager does not cancel a mutation transaction. The transaction starts in an unowned task; an independent view-owned task redraws only while the view remains open. Do not externally edit a target, run another Git writer there, or quit Herdr during an operation.

File success does not prove runtime unload or reload. Herdr can retain hidden copies, and a broken reload can keep old code running. A full app restart may be needed. On macOS, closing the red window button can hide the app; it is not a full quit. The manager does not restart Herdr, its terminals, or dependent programs. Stop programs started by a mod separately when needed.

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

Prepared but unused updates and retained metadata preimages can remain outside `mods/`. They are not committed installs. Registry publication compares the original hash and inode after preserving the old file; it does not silently overwrite a later edit. Preserve receipts and workspaces referenced by a transaction; inspect unused data before manual cleanup. Complete migration preimages and Git uninstall archives are retained deliberately. Do not treat an older binary as a migration rollback tool.

See [lifecycle contracts and integration design](docs/lifecycle-prerequisites.md) for host boundaries and protocol details.

## Sidebar launcher

The existing local `herdr-with-mods` layout keeps its **Mods** row directly above **Settings**:

- Layout: `~/.config/herdr-app/layouts/herdr-with-mods.json`, cloned from `main`.
- Footer mod: `~/.config/herdr-app/mods/mod-manager-sidebar/`, cloned from `workspace-chrome`.
- Only that cloned layout uses the 97 px footer; the row runs `mod.open` with `{ name: "mod-manager" }`.

This local launcher is not distributed by this repository. Shipped mods, layouts, settings, and keybindings are not edited. Clones survive restarts but do not receive Herdr's automatic updates.

```sh
herdr-app do layout.switch --name herdr-with-mods
herdr-app do layout.switch --name main  # restore the original layout
```

## Development checks

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.14:

```sh
npm ci
npm run check:mod
npm run ci
git diff --check
```

`check:mod` runs the native entry check, generates the ignored real SDK for no-emit JavaScript type checks, and runs all native view fixtures. `ci` runs Biome, JavaScript model/runtime/UI tests, real JavaScript-to-Python lifecycle tests, Python filesystem/fault tests, and type checks. `check:views` runs only the native view fixtures through `scripts/check-views.mjs`. These tests use an isolated `HERDR_APP_HOME` for all pages and loading, error, confirmation, migration, protection, and archive states. They are tests of the live view, not a product preview mode.

Tests use disposable profiles and real local Git repositories. Test-only transport injection is not a production local-install mode. Cross-version fixtures cover both stores, mixed ownership, explicit confirmation, directory/busy/corrupt locks, retained Git data, ref failures, and recovery. Never use the user's mods for lifecycle tests.

Hosted Linux CI runs formatting and fixture tests. Real-SDK type checks and native rendering also run against the installed local Herdr version. No build output is produced.

## External handoff before release

1. **Profile owner — actual migration.** After disposable migration/recovery checks pass, make and verify a complete profile backup, review the exact migration summary, and stop conflicting writers. Run only the explicitly confirmed migration. Actual-profile migration is not established by fixture tests; unattended migration must remain disabled.
2. **Platform maintainer — native interaction and runtime behavior.** Use a disposable profile and fixture repository to inspect both themes, native keyboard controls, scrolling/batches, source failures, confirmation/cancel, close-during-operation, and full-restart instructions. Verify runtime copies and dependent programs separately. Native initial-render checks do not prove these paths; retain that release restriction until review.
3. **Platform maintainer — unavailable platforms.** Validate native filesystem, migration, and UI behavior before claiming support on a platform not exercised by the agent. Windows mutation remains unsupported, with read-only browsing available. A stale screenshot is not visual acceptance, and successful URL delivery is not proof that a browser displayed the page.

These handoffs do not authorize automated user-profile mutation, account actions, app restart, or release. No package publication, version tag, or release workflow dispatch is part of this change.
