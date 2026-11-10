# Herdr Mods

A monorepo for Herdr App mods, managed with npm workspaces.

## Repository structure

- [`mods/mod-manager/`](mods/mod-manager/): Herdr Mod Manager source, tests, native check scripts, and documentation.
- `scripts/`: shared repository scripts.
- `biome.json`: shared formatting and lint rules.
- `.github/`, `.changeset/`, and `.husky/`: shared CI, release, and Git hook configuration.

Each mod is a workspace under `mods/*`. Development tools and the npm lockfile are shared at the repository root. Herdr loads each mod directly; no build output or npm packages are needed at runtime.

## Development

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.14. Run these commands from the repository root:

```sh
npm ci
npm run check:mod
npm run ci
git diff --check
```

`check:mod` runs native checks and generates the ignored Herdr SDK declarations inside each mod. Run it before `check:types` or `ci`. Hosted Linux CI runs formatting and fixture tests without the local SDK.

Root `check` checks the whole repository. Root `test`, `test:operations`, `check:mod`, `check:views`, and `check:types` run the corresponding workspace scripts. To run one mod:

```sh
npm test --workspace herdr-mod-manager
npm run check:mod --workspace herdr-mod-manager
```

Shared hooks, Changesets, and release commands run from the root.

## Open Mod Manager

Link `<checkout>/mods/mod-manager` to `<app-home>/mods/mod-manager`, not the repository root. Existing development links to the old repository root must be changed by the profile owner with Herdr fully stopped. Reopen Herdr after the link change and verify that the manager loads. Repository checks do not change or verify the live profile link.

```sh
herdr-app check mods/mod-manager
npm start
```

`npm start` opens or closes the installed `mod-manager` dialog; it does not create an installation link. The same mod can provide a sidebar footer with `{ "footer": true }`; no separate sidebar mod is needed. Existing personal layouts that use `mod-manager-sidebar` need an owner-managed change. See the [sidebar launcher guide](mods/mod-manager/README.md#sidebar-launcher) for the 97 px layout block, migration, and recovery. Repository checks do not change the live profile.

See the [Mod Manager guide](mods/mod-manager/README.md) for installation, runtime requirements, file operations, and recovery.

## Self-update

Self-update is an explicit CLI operation. The script is now at `mods/mod-manager/self_update.py`. It checks and updates the **entire Git checkout**, including all workspaces and shared files. Source downloads use `narumiruna/herdr-mods`; checkout origins with the previous repository name remain accepted. Review the full repository changes before confirmation.

Older flat installations cannot update directly to this layout with their original updater. Preserve the old checkout, create a fresh clone, and have the profile owner change the development link to the nested mod directory. Do not use reset or clean to discard local files. See the [self-update guide](mods/mod-manager/README.md#self-update) for requirements and recovery.
