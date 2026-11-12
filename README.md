# Herdr Mods

A monorepo for Herdr App mods, managed with npm workspaces.

## Share Mod Manager

The [Mod Manager recipe](mods/mod-manager/RECIPE.md) is a build brief for `mods/mod-manager/`. Its actual native preview is included. The bundle remains incomplete until the required native interaction checks pass. The mod bundle contains no layout or keybinding file. GitHub publication requires separate approval.

## Repository structure

- [`mods/github-issues-prs/`](mods/github-issues-prs/): read-only GitHub issues and pull requests, repository context, and optional workspace tabs.
- [`mods/mod-manager/`](mods/mod-manager/): Herdr Mod Manager source, tests, native check scripts, and documentation.
- [`mods/layout-manager/`](mods/layout-manager/): edit existing personal layout blocks and containers, insert new mod views beside any node, and keep legacy managed-panel controls.
- [`mods/markdown-reader/`](mods/markdown-reader/): native local Markdown reading, display math, official Mermaid SVG, static Vega-Lite, and personal Files integration preparation.
- `layouts/`: local layouts and SVG previews.
- `scripts/`: shared repository scripts.
- `biome.json`: shared formatting and lint rules.
- `.github/`, `.changeset/`, and `.husky/`: shared CI, release, and Git hook configuration.

Each mod is a workspace under `mods/*`. Development tools and the npm lockfile are shared at the repository root. Herdr loads each mod directly. Manager mods need no build output or runtime npm packages; Markdown Reader needs installed Node dependencies and Puppeteer's browser.

## Development

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.15. Run these commands from the repository root:

```sh
npm ci
npm run setup:browser --workspace herdr-markdown-reader
npm run check:mod
npm run ci
git diff --check
```

`check:mod` runs native checks and generates the ignored Herdr SDK declarations inside each mod. Run it before `check:types` or `ci`. Hosted Linux CI runs formatting and fixture tests without the local SDK.

Root `check` checks the whole repository. Root `test` runs the isolated shared-script tests, then all four workspace suites. Root `test:operations`, `check:mod`, `check:views`, and `check:types` run the corresponding workspace scripts. To run one mod:

```sh
npm test --workspace herdr-mod-manager
npm run check:mod --workspace herdr-mod-manager
```

Shared hooks, Changesets, and release commands run from the root.

## Quality and bundle checks

The [quality review](docs/mod-quality-review.md) records scores against [RUBRIC.md](RUBRIC.md), test evidence, and acceptance limits. Scores do not replace native interaction checks.

```sh
npm run check:bundles
npm run evidence:previews
```

`check:bundles` checks every mod root for workspace scripts, recipe sections and local links, license notices, JSON, parsed runtime imports, and bounded PNG structure/inflation with chunk CRCs. It excludes development dependencies, caches, and generated declarations from its source-file view. It is not a full image decoder or an inspection of a packaged archive. Missing required source files fail the check. Inspect each preview in an image viewer and test native interaction separately; this command does not establish sharing readiness.

`evidence:previews` captures actual fixture views in disposable macOS Herdr profiles. Evidence and process-cleanup records stay outside the repository. Preview generation does not change the owner's profile, perform real GitHub requests, or test physical pointer and keyboard input. A passing structural check or screenshot is not sufficient to call a bundle ready to share.

## Link local mods and layouts

Stop Herdr before you change links. To link this checkout's mods and layouts into `~/.config/herdr-app/`, run:

```sh
./scripts/link.sh
```

Before removing links, select a layout that is not supplied by this checkout, then stop Herdr. To remove the links, run:

```sh
./scripts/unlink.sh
```

The link script scans `mods/*/`, `layouts/*.json`, and `layouts/*.svg` on each run. It links mod directories into `mods/` and layout files and SVG previews into `layouts/`, using absolute source paths. It skips other files, layout subdirectories, and hidden entries such as `layouts/.state/`. Run it again after you add a mod or layout.

Correct links are left unchanged. Conflicts are reported without overwriting files, directories, or other links. A conflict sets exit code 1; other mods and layouts are still processed.

The unlink script removes only same-name links that point to this checkout's mod directories or supported layout paths, including broken links. Both scripts recognize absolute and relative links. Relative paths start at the link's directory. The unlink script keeps source files, real files and directories, and links to other locations.

Both scripts can run from any working directory and can be run more than once. They do not select a layout or change keybindings. Reopen Herdr after you change links. Changes to linked mods or layouts affect the checkout directly.

Run `npm run test:scripts` to test both scripts with a temporary checkout and `HOME`. These tests do not change your Herdr profile.

## Open Mod Manager

Link `<checkout>/mods/mod-manager` to `<app-home>/mods/mod-manager`, not the repository root. Existing development links to the old repository root must be changed by the profile owner with Herdr fully stopped. Reopen Herdr after the link change and verify that the manager loads. Repository checks do not change or verify the live profile link.

```sh
herdr-app check mods/mod-manager
npm start
```

`npm start` opens or closes the installed `mod-manager` dialog; it does not create an installation link. The same mod can provide a sidebar footer with `{ "footer": true }`; no separate sidebar mod is needed. Existing personal layouts that use `mod-manager-sidebar` need an owner-managed change. See the [sidebar launcher guide](mods/mod-manager/README.md#sidebar-launcher) for the 125 px layout block, migration, and recovery. Repository checks do not change the live profile.

See the [Mod Manager guide](mods/mod-manager/README.md) for installation, runtime requirements, file operations, and recovery.

## Layout Manager

[Layout Manager](mods/layout-manager/README.md) moves existing blocks and containers by node ID beside any ordinary layout node. Its canvas and outline support four-side placement and a keyboard path. Inventory grips explicitly add new views; they do not duplicate a node during a move. The legacy managed panel, tab ordering, props, and overlay controls remain available. Shipped layouts must be cloned before editing. Saves reject stale files. Actual host layout parsing, geometry, and physical interaction remain [unverified owner checks](mods/layout-manager/README.md#unverified-acceptance-and-owner-handoff); eager native-description checks do not prove them.

The [recipe](mods/layout-manager/RECIPE.md) describes both dialog and dock-header modes. Stop Herdr before creating its development link, then reopen the app. No layout or keybinding is installed automatically.

```sh
npm test --workspace herdr-layout-manager
npm run check:mod --workspace herdr-layout-manager
npm start --workspace herdr-layout-manager
```

## Markdown Reader

[Markdown Reader](mods/markdown-reader/README.md) opens local Markdown in native panes. It supports native prose/code, MathJax display math, official Mermaid.js diagrams, and static Vega-Lite charts. Inline math remains TeX source on Herdr 0.1.15; it is not complete LaTeX support.

Install dependencies and the pinned browser first. The [Files integration guide](mods/markdown-reader/docs/files-integration.md) prepares personal Files/layout clones outside the active profile. Linking the reader alone does not replace Files clicks. No shipped mod, live layout, or source document is changed automatically.

```sh
npm test --workspace herdr-markdown-reader
npm run test:browser --workspace herdr-markdown-reader
npm run check:mod --workspace herdr-markdown-reader
npm run evidence:native --workspace herdr-markdown-reader
```

See [verification and external handoff](mods/markdown-reader/docs/verification.md) for native evidence, platform limits, the inline-asset API requirement, and live-profile checks.

## Self-update

Self-update is an explicit CLI operation. The script is now at `mods/mod-manager/self_update.py`. It checks and updates the **entire Git checkout**, including all workspaces and shared files. Source downloads use `narumiruna/herdr-mods`; checkout origins with the previous repository name remain accepted. Review the full repository changes before confirmation.

Older flat installations cannot update directly to this layout with their original updater. Preserve the old checkout, create a fresh clone, and have the profile owner change the development link to the nested mod directory. Do not use reset or clean to discard local files. See the [self-update guide](mods/mod-manager/README.md#self-update) for requirements and recovery.
