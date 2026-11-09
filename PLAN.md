# Herdr Mod Manager

## Goal

Build a Herdr App mod that installs and updates mods from GitHub repositories and helps users browse the [Herdr Gallery](https://herdr.dev/gallery/?type=mods).

Current authorization: maintain the visual preview and sidebar launcher, and follow Herdr's direct JavaScript convention without `src`, `dist`, or a build step. Use clearly marked sample data. Do not implement installation, updates, or installed-mod discovery yet.

## Context

- The initial preview used a TypeScript template; Herdr's shipped mods use JavaScript files directly.
- Installed Herdr App mods use `mod.json` and `main.js`.
- Development link: `~/.config/herdr-app/mods/mod-manager` → `/Users/narumi/src/herdr-mod-manager`.

## Visual Preview

- [x] Verify the native UI APIs and the mod build and open commands against the installed SDK and shipped mods. The ESM entry, development link, and `mod.open` work.
- [x] Build a theme-aware preview with a sample mod list, search, a GitHub form, and Gallery access. Installed mods are not read or changed.
- [x] Run formatting, tests, type checks, and `herdr-app check`; open the preview and inspect a screenshot. Biome, five JavaScript tests, and no-emit JavaScript type checks pass. All three initial views pass native checks. The direct JavaScript dialog has no reported errors; its screenshot is `/tmp/herdr-mod-manager-javascript-ui.png`. Remaining manual review is documented in `README.md`.

## Sidebar Launcher

- [x] Clone the sidebar mod and current layout without changing Herdr's shipped files. Created `mod-manager-sidebar` and `herdr-with-mods`; SHA-256 checks confirm the shipped layout, shipped sidebar code, and keybindings are unchanged.
- [x] Add a Mods row above Settings that runs `mod.open` for `mod-manager`; increase the footer height and use the custom sidebar mod only in the cloned layout's footer. The footer is 97 px and the custom layout is active.
- [x] Run native checks and repository checks, inspect the sidebar screenshot, and document the custom layout and recovery command. Native checks, `npm run ci`, and expanded/collapsed row-order and action-binding smoke tests pass. The running layout reports no errors. Screenshot: `/tmp/herdr-sidebar-mods-detail.png`; recovery instructions: `README.md`.

## Direct JavaScript

- [x] Move the UI and sample data to root `main.js` and `preview.js`, preserving runtime behavior and JSDoc types. A one-time compiler-output comparison confirms equivalent runtime code after normalizing redundant type-cast parentheses.
- [x] Remove the TypeScript source directory, generated output, SDK-copy script, and build commands; use `jsconfig.json` for no-emit JavaScript checks and update tests and usage instructions. Tests now import root `preview.js`; the `src` and `dist` directories remain absent after checks.
- [x] Run formatting, tests, JavaScript type checks, and native checks for all three initial views; open the manager without build output and inspect its screenshot. `npm run ci`, all three native initial views, and the live dialog pass; screenshot: `/tmp/herdr-mod-manager-javascript-ui.png`.

## Plan

- [ ] Confirm the Herdr App mod APIs, JavaScript entry files, and method to open the manager. Verify these against the installed SDK and existing mods.
- [ ] Add a minimal manager interface that lists installed mods and their GitHub sources. Verify that existing mods remain unchanged.
- [ ] Add installation from a GitHub repository URL. Validate the mod before installation, reject existing destination paths, and do not run repository install scripts. Test valid and invalid repositories.
- [ ] Add updates for manager-installed mods. Use fast-forward-only updates, reject local changes, and exclude symbolic links such as this development checkout. Test successful and rejected updates.
- [ ] Add Gallery access. Start with a link to the Gallery; add an in-app list only if a supported data source is available. Verify the link and document any data-source limits.
- [ ] Add tests and usage instructions. Run formatting, tests, JavaScript type checks, and native checks. Document how to load the mod and any required restart or reload.

## Completion Checklist

- [x] The development symbolic link points to this repository.
- [ ] GitHub installation and updates work without overwriting existing mods or local changes.
- [ ] Users can open the Gallery from the manager.
- [ ] Automated checks pass, and usage instructions describe any checks that still require Herdr App UI validation.
