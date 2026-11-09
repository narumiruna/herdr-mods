# Herdr Mod Manager

A native Herdr App interface preview for managing mods.

## Preview scope

- Open the in-app Gallery with three community samples: enabled, disabled, and not installed.
- Search Gallery and Installed independently by name, description, or repository. Installed also has GitHub and development source filters.
- Simulate **Install**, **Enable**, **Disable**, and **Uninstall** from either page. Both pages and the Installed count use the same state.
- Confirm or cancel uninstall. The confirmation shows the sample name and path; the Gallery entry remains available for reinstallation.
- See disabled actions and the reason for the protected development manager sample.
- Use **From GitHub** to validate a repository URL and simulate installation. Matching Gallery entries are reused; new samples appear in Installed only. Duplicate installations are rejected.
- Open the real Herdr Gallery with **Website**, only when clicked.

All lifecycle actions are simulated in memory and reset when the manager closes. They do not read installed mods, fetch repositories, change enabled state in Herdr, or write files. A short progress state blocks conflicting actions. Versions, repositories, and `/preview/mods/` paths are illustrative. GitHub validation checks URL format, not repository contents. Real installation, updates, and persistent enable/disable state are not available.

## Live management status

Execution of `PLAN.md` found a public Gallery metadata source, but Herdr App 0.1.14 has no supported persistent mod enable/disable mechanism. Hidden copies can remain active, and deleting a folder does not establish unload. Live management remains incomplete; the runtime is still the sample-only preview described above.

See [Live management prerequisites](docs/lifecycle-prerequisites.md) for the source format, version-pinned host evidence, required host support and external handoff. No live acceptance criterion has been waived, and no installed mod was changed by the audit.

## Open in Herdr

Herdr loads root `main.js` and `preview.js` directly. No build, Node.js, or npm dependencies are required to run the mod.

```sh
herdr-app check .
herdr-app do mod.open --name mod-manager
```

Herdr must discover this repository as `mod-manager` under its `mods` folder. The local development link is:

```text
~/.config/herdr-app/mods/mod-manager → /Users/narumi/src/herdr-mod-manager
```

`npm start` also toggles the dialog. Press Escape or click the close button to close it. No layout or keybinding changes are required.

Edit the JavaScript files directly. There is no `src` or `dist` directory. Herdr provides `gpui-kit`, `gpui-base`, and `herdr` at runtime.

Changes through the external development symbolic link did not reload automatically during validation; close and reopen the dialog after editing. A restart was not needed.

Icons come from Herdr's shipped `icons` and `workspace-chrome` assets. Herdr blocks asset reads through symbolic links that leave its app folder, so this preview does not keep custom SVGs in the development checkout.

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

Development tools require Node.js 26. Herdr generates the ignored `gpui-kit.d.ts`, including declarations for `herdr`, when it checks or loads the mod. Generate it before running JavaScript type checks.

```sh
npm ci
npm run check:mod
npm run ci
herdr-app status
herdr-app shot /tmp/herdr-mod-manager-preview.png
```

`ci` runs Biome, model and mocked-view workflow tests, and `check:types`. The tracked `jsconfig.json` uses `checkJs` and `noEmit`; TypeScript checks JSDoc types against the generated SDK but does not produce files. There is no SDK-copy script or compilation step. The view tests exercise the real event handlers with native element and context adapters; they do not test native layout or keyboard dispatch.

Check all three pages and the confirmation, pending, error, and empty-search states:

```sh
npm run check:preview
```

This command creates temporary copies, runs native checks, and removes the copies. It does not add runtime test options or change the app's mods or configuration. Native checks validate eager elements, not paint or a complete interactive session.

## Preview review handoff

Dark-theme captures of Gallery, Installed, From GitHub, and uninstall confirmation were inspected. Non-default captures used temporary initial-state setup, which was removed after capture:

- Gallery: `/tmp/herdr-mod-manager-gallery-preview.png`
- Installed: `/tmp/herdr-mod-manager-installed-preview.png`
- From GitHub: `/tmp/herdr-mod-manager-github-preview.png`
- Uninstall confirmation: `/tmp/herdr-mod-manager-uninstall-preview.png`

A maintainer with Herdr App access must check native interaction and both themes before release. The captures and automated tests do not establish keyboard, scroll, or native close/reopen reset behavior. Use this fixture-only sequence; no real mod installation is required:

1. In Gallery, search by name, description, and repository. Clear the search and install Terminal Tools. The Installed count changes from 3 to 4.
2. Open Installed. Disable Terminal Tools, then return to Gallery and enable it. Both pages must show the same state. Check source filters separately from enabled state.
3. Request uninstall and cancel it. The sample must remain installed. Request uninstall again and confirm it. The count returns to 3 and Gallery offers Install again.
4. Check that the development manager's actions are disabled and its reason is visible after scrolling.
5. In From GitHub, submit an invalid URL, then `https://github.com/example/terminal-tools.git/`. The valid URL reuses the Gallery sample. A second install must be rejected. Try `https://github.com/owner/custom-sample` and confirm that it appears in Installed, not Gallery.
6. Close with Escape or Close, then reopen. The original sample states and count of 3 must return. Repeat the flow with keyboard controls and in the other theme.

Expected result: native state, actions, and confirmations agree with the automated workflow tests. These native interactions remain unverified until the maintainer performs them; do not claim release readiness before review. Real lifecycle operations remain outside this preview's scope.
