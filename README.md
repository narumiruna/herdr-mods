# Herdr Mod Manager

A native Herdr App mod that lists installed mods, installs trusted mods from public GitHub repositories, and updates manager-installed mods.

## Requirements and loading

Herdr loads root JavaScript files directly. There is no build, `src`, or `dist` directory. Node.js and npm are development tools only.

Local mod management requires **Git, uv, and Python 3** on Herdr's `PATH`. Install these tools separately. The manager runs isolated standard-library Python through `uv run --no-project --offline --no-python-downloads python`; it does not install tools or dependencies. Python supplies filesystem safety operations that Herdr's JavaScript API does not provide. Missing tools produce an error; Gallery access remains available.

Place this repository under the app's `mods/mod-manager` folder, or use the existing development link:

```text
~/.config/herdr-app/mods/mod-manager → /Users/narumi/src/herdr-mod-manager
```

```sh
herdr-app check .
herdr-app do mod.open --name mod-manager
```

`npm start` also toggles the dialog. Escape or the close button closes it. External development links may not reload automatically: close and reopen the dialog after editing. No restart is normally needed.

## Installed mods

The Installed page reads the local app's `mods/` directory, using `appHome()` so `HERDR_APP_HOME` is respected. Search names, descriptions, folder names, or GitHub sources. Filter by GitHub, development link, or local files. Use **Refresh** after external changes.

- Existing and shipped mods are read-only. Discovery does not run their code or change their files.
- Development symbolic links, including this manager's checkout, are never updated.
- Only a real checkout with the manager's ownership record has an **Update** button.
- Invalid metadata produces a per-mod error without hiding other mods.

## Install from GitHub

1. Open **From GitHub** and enter `https://github.com/owner/repository` (an optional `.git` suffix is accepted).
2. Read the trust warning, then select **Install trusted mod**.
3. The manager clones the default branch into a temporary directory outside `mods/`. It checks the pinned Git tree, root `mod.json`, and nonempty root `main.js` before checkout.
4. The manager publishes the complete checkout under `mods/<repository>` with an atomic, no-overwrite rename. Any existing path, including an empty directory or dangling link, is refused.

**Installed mods are trusted code. Herdr may run them immediately after installation.** They can run commands and use the network. Structural validation does not prove that JavaScript is safe, valid, or compatible with your Herdr version. Inspect the repository before installing it.

Only public GitHub HTTPS repository-root URLs are supported. Private authentication, branch URLs, subdirectory mods, build-only packages, symbolic links, and Git submodules are not supported. The manager does not execute repository install scripts, package managers, Git hooks, credential helpers, or configured checkout filters. It disables prompts and global/system Git configuration. Clone and fetch have a timeout, but repository disk use is not bounded.

Atomic publication uses macOS `RENAME_EXCL`, Linux `renameat2(RENAME_NOREPLACE)`, or Windows no-overwrite rename. Unsupported filesystems, unavailable primitives, and cross-device moves fail closed; there is no copy or overwriting fallback. macOS is checked locally and Linux is covered by CI; native Windows behavior still requires platform validation.

## Updates

Select **Update** on a manager-installed mod. The manager checks its recorded GitHub origin and branch, fetches that branch, validates the candidate tree without running it, and permits only a fast-forward. It checks local state again before applying the update.

Updates refuse symbolic links, linked worktrees, changed origins or branches, unsupported local Git configuration, hidden index flags, local commits that are not in the upstream history, and staged, unstaged, untracked, or ignored files. The manager never stashes, rebases, cleans, or resets an installed checkout. Git hooks and submodules remain disabled, and ignored files cannot be overwritten.

This is deliberately conservative. Herdr can generate `gpui-kit.d.ts` and `jsconfig.json` inside a mod. If these files are untracked or ignored, they also block an update. Move any files you need to keep outside the checkout before retrying; the manager does not delete them or exempt arbitrary SDK files.

Herdr usually reloads changed mods. A live fast-forward changes several files, so intermediate reload errors can occur; reopen the mod after the update finishes. Restart Herdr only if it still shows the old version. A mod with `place: "none"` needs a layout reference or a `mod.open` action; the manager does not edit layouts.

## Operation safety and recovery

A disk lock at `<app-home>/data/mod-manager/lock` prevents concurrent manager mutations across dialogs or reloads. Closing the manager dialog does not cancel an operation. Do not edit the target checkout or quit Herdr while it is working. The lock does not prevent another program from editing files, and live updates are not an atomic directory swap.

A crash, forced quit, filesystem error, or failed publication can leave the lock and an `install.*` staging directory. Normal rejected installs remove their staging directory and release the lock. Unexpected publication failures preserve recovery evidence and do not touch existing mods.

To recover:

1. Confirm no manager operation or related Git process is still running. Do not remove a live lock.
2. Inspect `data/mod-manager/install.*` and the destination under `mods/`. Back up anything you need. A staged checkout is not an installed mod until the atomic rename succeeds. Do not move a rejected candidate into `mods/` without reviewing it.
3. For an interrupted update, inspect `git status` and `git log` in the affected checkout. Preserve local changes. Resolve any Git lock or partial checkout manually; the manager does not perform destructive rollback.
4. Remove only the confirmed stale **empty** manager lock with `rmdir`. Remove abandoned staging directories only after inspection, then reopen the manager and use Refresh.

Ownership is stored in `.git/herdr-mod-manager.json`, not in a repository-controlled tracked file. Do not copy or edit this record to adopt existing mods. If it is damaged or the checkout moved, update that mod manually. These checks protect normal operations; they are not a sandbox against another malicious process with the same user permissions.

## Gallery

The Gallery page sends `https://herdr.dev/gallery/?type=mods` to the system browser only when clicked. It also shows the URL if opening fails. No documented, supported feed was found; the manager does not scrape Gallery HTML or download a feed in the background. Some Gallery entries use subdirectories and are not supported by this repository-root installer.

## Sidebar launcher

The existing local `herdr-with-mods` layout has a **Mods** button directly above **Settings**, including a collapsed-sidebar tooltip.

- Layout: `~/.config/herdr-app/layouts/herdr-with-mods.json`, cloned from `main`.
- Footer: `~/.config/herdr-app/mods/mod-manager-sidebar/`, cloned from `workspace-chrome`.
- Only that cloned layout's `sidebar-footer` uses this mod; its height is 97 px.
- The row runs `mod.open` with `{ name: "mod-manager" }`.

The launcher configuration is local and is not included in this repository. Herdr's shipped mods, layout, settings, and keybindings remain unchanged. Clones survive restarts but do not receive Herdr's automatic updates.

```sh
herdr-app do layout.switch --name herdr-with-mods
herdr-app do layout.switch --name main  # recovery: restore the original layout
```

## Development checks

Use Node.js 26, Git, uv, Python 3, and an installed Herdr App:

```sh
npm ci
npm run check:mod
npm run ci
herdr-app status
herdr-app shot /tmp/herdr-mod-manager.png
```

`check:mod` checks the live entry and all three initial pages with temporary render fixtures, including managed and read-only cards. It generates the ignored `gpui-kit.d.ts` required by `check:types`. `ci` runs Biome, unit/UI tests, temporary real-Git integration tests, and no-emit JavaScript type checks. No build output is produced. CI runs formatting and tests on Linux; SDK type checks and native rendering require the local installed Herdr version.

Tests cover validation, no-overwrite publication, installation/update failures, local-change protection, ownership and symbolic-link exclusions, locks, and dialog closure. Test-only Git transport maps allowlisted GitHub URLs to temporary local repositories; production permits HTTPS only.

### External validation before release

Before release, the maintainer must check the following on an installed Herdr App:

1. Review all pages in light and dark themes. Verify readable text, scrolling, keyboard input, source filters, and Escape dismissal. Native checks render an initial view, not a complete interactive session. The local live-open command reported no errors, but its screenshot retained the pre-dialog frame; it does not establish visual acceptance.
2. On Windows, run the filesystem tests and an isolated native install/update session. Verify no-overwrite publication, link rejection, and dialog behavior before claiming Windows support.
3. Open the Gallery and verify that the browser displays the mods page. Successful URL delivery alone does not prove browser display.

These platform and manual UI paths remain unverified. No package publication or release is part of this change.
