# Herdr Mods

A monorepo for Herdr App mods, managed with npm workspaces.

## Share Mod Manager

The [Mod Manager recipe](mods/mod-manager/RECIPE.md) is a build brief for `mods/mod-manager/`. Its actual native preview is included. The bundle remains incomplete until the required native interaction checks pass. The mod bundle contains no layout or keybinding file. GitHub publication requires separate approval.

## Repository structure

- [`mods/agent-spaces/`](mods/agent-spaces/RECIPE.md): Spaces with overlapping agent icons, working/total counts, and one native status ring. The workbench layout uses this mod.
- [`mods/github-issues-prs/`](mods/github-issues-prs/): read-only GitHub issues and pull requests, repository context, and optional workspace tabs.
- [`mods/mod-manager/`](mods/mod-manager/): Herdr Mod Manager source, tests, native check scripts, and documentation.
- [`mods/better-files/`](mods/better-files/): a personal Files clone with a bundled native Markdown reader, display math, official Mermaid SVG, and static Vega-Lite in the same Files pane. Other file previews remain unchanged. Owner interaction checks remain incomplete.
- [`docs/markdown-reader-examples.md`](docs/markdown-reader-examples.md): a visual render check for Better Files, with Mermaid, LaTeX, Python/Go/Rust code, and Vega-Lite examples.
- `layouts/`: local layouts and SVG previews.
- `scripts/`: shared repository scripts.
- `biome.json`: shared formatting and lint rules.
- `.github/`, `.changeset/`, and `.husky/`: shared CI, release, and Git hook configuration.

Each mod is a workspace under `mods/*`. Development tools and the npm lockfile are shared at the repository root. Herdr loads each mod directly. Manager mods need no build output or runtime npm packages; Better Files needs installed Node dependencies and Puppeteer's browser for Markdown rendering.

## Development

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.15. Run these commands from the repository root:

```sh
npm ci
npm run setup:browser --workspace herdr-better-files
npm run check:mod
npm run ci
git diff --check
```

`check:mod` runs native checks and generates the ignored Herdr SDK declarations inside each mod. Run it before `check:types` or `ci`. Hosted Linux CI runs formatting and fixture tests without the local SDK.

Root `check` checks the whole repository. Root `test` runs the isolated shared-script tests, then all mod workspace suites. Root `test:operations`, `check:mod`, `check:views`, and `check:types` run the corresponding workspace scripts. To run one mod:

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

On Windows, use Windows PowerShell 5.1 or later. Preview the changes, then create the links:

```powershell
.\scripts\link.ps1 -WhatIf
.\scripts\link.ps1
```

The PowerShell script uses junctions for mod directories and symbolic links for layout JSON files and SVG previews. It does not copy files.

- File symbolic links require an Administrator session in Windows PowerShell 5.1, or Windows Developer Mode with a supported PowerShell version.
- If script execution is blocked, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\link.ps1`. This applies only to that process; it does not change the execution policy stored on the system.
- Use `-AppHome C:\Herdr-Test-Profile` to select a different profile.
- `-WhatIf` does not create directories or links.
- Conflicts and link errors are reported without stopping other entries. Any failure sets exit code 1.

Before removing links, select a layout that is not supplied by this checkout, then stop Herdr. To remove the links, run:

```sh
./scripts/unlink.sh
```

On Windows, preview the removals, then remove the links:

```powershell
.\scripts\unlink.ps1 -WhatIf
.\scripts\unlink.ps1
```

`unlink.ps1` also accepts `-AppHome C:\Herdr-Test-Profile`. It does not create a missing profile. Removal errors are reported without stopping other entries; any failure sets exit code 1. If script execution is blocked, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\unlink.ps1`.

The link scripts scan `mods/*/`, `layouts/*.json`, and `layouts/*.svg` on each run. They link mod directories into `mods/` and layout files and SVG previews into `layouts/`, using absolute source paths. They skip other files, layout subdirectories, and hidden entries such as `layouts/.state/`. Run a link script again after you add a mod or layout.

Correct links are left unchanged. Conflicts are reported without overwriting files, directories, or other links. A conflict sets exit code 1; other mods and layouts are still processed.

The unlink scripts remove only same-name links that point to this checkout's mod directories or supported layout paths, including broken links. They recognize absolute and relative links. Relative paths start at the link's directory. They keep source files, real files and directories, and links to other locations. The PowerShell script also removes matching mod junctions without deleting their contents.

All link scripts can run from any working directory and can be run more than once. They do not select a layout or change keybindings. Reopen Herdr after you change links. Changes to linked mods or layouts affect the checkout directly.

Run `npm run test:scripts` to test the shell scripts with a temporary checkout and `HOME`. On Windows, run `node --test scripts/unlink.test.mjs` for PowerShell cleanup tests with a temporary checkout and `-AppHome`. Symbolic-link tests require Administrator permissions or Windows Developer Mode; they are skipped when link creation is not permitted. These tests do not change your Herdr profile.

## Agent Spaces

[Agent Spaces](mods/agent-spaces/RECIPE.md) keeps the shipped Spaces controls and adds the selected compact summary: overlapping agent icons on the left, with a working/total count and one status ring on the right. For example, `2/3` means two of three reported agents are working. Three icons are shown at most; `+N` counts the rest. Hover either summary to read the full agent list. Spaces without reported agents keep their colored avatar and have no count.

The repository workbench layout now uses `agent-spaces`. Install or link `mods/agent-spaces` into the existing profile while Herdr is stopped, then reopen Herdr. For a different personal layout, change only its Spaces block's `content.mod` from `spaces` to `agent-spaces`. Keep the separate Agents block and existing keys. Repository checks do not change or verify the live profile. To revert, change that block back to `spaces`.

```sh
npm test --workspace herdr-agent-spaces
npm run check:mod --workspace herdr-agent-spaces
```

Native fixture checks and gallery preview requirements are recorded in the [recipe](mods/agent-spaces/RECIPE.md#done-when). Real agent interaction and platform checks must pass before this bundle is ready to share.

## Open Mod Manager

Link `<checkout>/mods/mod-manager` to `<app-home>/mods/mod-manager`, not the repository root. Existing development links to the old repository root must be changed by the profile owner with Herdr fully stopped. Reopen Herdr after the link change and verify that the manager loads. Repository checks do not change or verify the live profile link.

```sh
herdr-app check mods/mod-manager
npm start
```

`npm start` opens or closes the installed `mod-manager` dialog; it does not create an installation link. The same mod can provide a sidebar footer with `{ "footer": true }`; no separate sidebar mod is needed. Existing personal layouts that use `mod-manager-sidebar` need an owner-managed change. See the [sidebar launcher guide](mods/mod-manager/README.md#sidebar-launcher) for the 125 px layout block, migration, and recovery. Repository checks do not change the live profile.

See the [Mod Manager guide](mods/mod-manager/README.md) for installation, runtime requirements, file operations, and recovery.

## Better Files and Markdown

[Better Files](mods/better-files/README.md) opens local `.md` and `.markdown` files in the same Files pane. It bundles the reader UI and Node helper, with native prose/code, MathJax display math, official Mermaid.js diagrams, and static Vega-Lite charts. Inline math remains TeX source on Herdr 0.1.15; it is not complete LaTeX support.

Install dependencies and the pinned browser first. Install only `better-files`, then change the intended Files block's `content.mod` to `better-files` while Herdr is stopped. Keep other layout settings, shipped Files, and source documents unchanged. See the [installation and migration guide](mods/better-files/README.md).

The standalone `markdown-reader` mod, its Open/dialog/tab entry points, and personal Files-clone preparation tool have been removed. Existing profile links and layouts need owner-managed cleanup. New reader data uses `data/better-files/`; old `data/markdown-reader/` is not reused, migrated, or automatically deleted.

```sh
npm test --workspace herdr-better-files
npm run test:browser --workspace herdr-better-files
npm run check:mod --workspace herdr-better-files
npm run evidence:native --workspace herdr-better-files
```

See [verification and external handoff](mods/better-files/docs/verification.md) for native evidence, platform limits, and required owner interaction checks.

## Self-update

Self-update is an explicit CLI operation. The script is now at `mods/mod-manager/self_update.py`. It checks and updates the **entire Git checkout**, including all workspaces and shared files. Source downloads use `narumiruna/herdr-mods`; checkout origins with the previous repository name remain accepted. Review the full repository changes before confirmation.

Older flat installations cannot update directly to this layout with their original updater. Preserve the old checkout, create a fresh clone, and have the profile owner change the development link to the nested mod directory. Do not use reset or clean to discard local files. See the [self-update guide](mods/mod-manager/README.md#self-update) for requirements and recovery.
