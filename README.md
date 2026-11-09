# Herdr Mod Manager

A native Herdr App interface preview for managing mods.

## Preview scope

- Browse four clearly marked sample mods.
- Search the samples and filter by GitHub or development source.
- Open the GitHub form. **Preview install** only shows a message.
- Open the Herdr Gallery in the default browser from the Gallery page.

The preview does not read installed mods, fetch repositories, install mods, or update files. Gallery access starts a browser only when clicked. Versions and repository names in the sample list are illustrative.

## Build and open

Requires Node.js 26 and an installed Herdr App. Start Herdr once to generate its SDK files.

```sh
npm ci
npm run build
herdr-app check .
herdr-app do mod.open --name mod-manager
```

Herdr must discover this repository as `mod-manager` under its `mods` folder. The local development link is:

```text
~/.config/herdr-app/mods/mod-manager → /Users/narumi/src/herdr-mod-manager
```

`npm start` also toggles the dialog. Press Escape or click the close button to close it. No layout or keybinding changes are required.

The build copies the installed `gpui-kit.d.ts` and `herdr.d.ts` into ignored local files. It uses `HERDR_APP_HOME` when set, otherwise `~/.config/herdr-app`. `main.js` loads the compiled ESM entry from `dist/index.js`.

After a source edit, run `npm run build`. Changes through the external development symbolic link did not reload automatically during validation; close and reopen the dialog to load the new build. A restart was not needed.

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

The launcher configuration is local to this Herdr installation, not part of the manager's build output. Clones survive restarts but do not receive Herdr's automatic layout and mod updates. Keep the custom layout selected to retain the button.

## Checks

```sh
npm run ci
npm run check:mod
herdr-app status
herdr-app shot /tmp/herdr-mod-manager-preview.png
```

`ci` runs Biome, sample-filter tests, and the TypeScript build against the installed SDK. It needs the local Herdr SDK; the build does not download it. `check:mod` validates the initial native view, not a complete interactive session.

Visual review remains manual: check the Installed, From GitHub, and Gallery pages, scroll the sample list, try the search and source filters, and close the dialog with Escape. Review both light and dark themes before release. Installation and updates are not available in this preview.
