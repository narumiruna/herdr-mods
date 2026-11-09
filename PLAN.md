# Herdr Mod Manager

## Goal

Build a Herdr App mod that installs and updates mods from GitHub repositories and helps users browse the [Herdr Gallery](https://herdr.dev/gallery/?type=mods).

Current authorization: build a visual preview in Herdr App and add a Mods button above Settings in a custom layout. Use clearly marked sample data. Do not implement installation, updates, or installed-mod discovery yet.

## Context

- This repository currently contains a TypeScript template.
- Installed Herdr App mods use `mod.json` and `main.js`.
- Development link: `~/.config/herdr-app/mods/mod-manager` → `/Users/narumi/src/herdr-mod-manager`.

## Visual Preview

- [x] Verify the native UI APIs and the mod build and open commands against the installed SDK and shipped mods. The ESM entry, development link, and `mod.open` work.
- [x] Build a theme-aware preview with a sample mod list, search, a GitHub form, and Gallery access. Installed mods are not read or changed.
- [x] Run formatting, tests, the build, and `herdr-app check`; open the preview and inspect a screenshot. Biome, five tests, and the TypeScript build pass. All three initial views pass native checks. The open dialog has no reported errors; its screenshot is `/tmp/herdr-mod-manager-ui.png`. Remaining manual review is documented in `README.md`.

## Sidebar Launcher

- [x] Clone the sidebar mod and current layout without changing Herdr's shipped files. Created `mod-manager-sidebar` and `herdr-with-mods`; SHA-256 checks confirm the shipped layout, shipped sidebar code, and keybindings are unchanged.
- [x] Add a Mods row above Settings that runs `mod.open` for `mod-manager`; increase the footer height and use the custom sidebar mod only in the cloned layout's footer. The footer is 97 px and the custom layout is active.
- [x] Run native checks and repository checks, inspect the sidebar screenshot, and document the custom layout and recovery command. Native checks, `npm run ci`, and expanded/collapsed row-order and action-binding smoke tests pass. The running layout reports no errors. Screenshot: `/tmp/herdr-sidebar-mods-detail.png`; recovery instructions: `README.md`.

## Plan

- [ ] Confirm the Herdr App mod APIs, build output, and method to open the manager. Verify these against the installed SDK and existing mods.
- [ ] Add a minimal manager interface that lists installed mods and their GitHub sources. Verify that existing mods remain unchanged.
- [ ] Add installation from a GitHub repository URL. Validate the mod before installation, reject existing destination paths, and do not run repository install scripts. Test valid and invalid repositories.
- [ ] Add updates for manager-installed mods. Use fast-forward-only updates, reject local changes, and exclude symbolic links such as this development checkout. Test successful and rejected updates.
- [ ] Add Gallery access. Start with a link to the Gallery; add an in-app list only if a supported data source is available. Verify the link and document any data-source limits.
- [ ] Add tests and usage instructions. Run formatting checks, tests, and the build. Document how to load the mod and any required restart or reload.

## Completion Checklist

- [x] The development symbolic link points to this repository.
- [ ] GitHub installation and updates work without overwriting existing mods or local changes.
- [ ] Users can open the Gallery from the manager.
- [ ] Automated checks pass, and usage instructions describe any checks that still require Herdr App UI validation.
