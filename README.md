# Herdr Mods

A monorepo for Herdr App mods, managed with npm workspaces.

## Mod overview

| Mod                                                       | What it does                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [GitHub Issues & PRs](mods/github-issues-prs/README.md)   | View issues and pull requests for the focused terminal's GitHub repository in a read-only panel. |
| [Mod Manager](mods/mod-manager/README.md)                 | Browse the Gallery, install or remove mods, and check for updates.                               |
| [Spaces Agent Status](mods/spaces-agent-status/README.md) | See agent icons, activity counts, and status rings in the Spaces sidebar.                        |

## Repository structure

- [`mods/`](mods/): mod source, tests, and documentation.
- `layouts/`: local layouts and SVG previews.
- `scripts/`: shared repository scripts.
- `biome.json`: shared formatting and lint rules.
- `.gitattributes`: LF checkout rules for text files.
- `.github/` and `.changeset/`: shared CI and release configuration.
- `prek.toml`: shared Git hook configuration.

Each mod is a workspace under `mods/*`. Development tools and the npm lockfile
are shared at the repository root. See each mod's README for runtime requirements.

## Development

Use Node.js 26, Git, uv, cached Python 3.14, and Herdr App 0.1.15. Run these
commands from the repository root:

```sh
npm ci
npm run check:mod
npm run ci
git diff --check
```

`check:mod` runs native checks and generates the ignored Herdr SDK declarations inside each mod. Run it before `check:types` or `ci`. Hosted Linux CI runs formatting and fixture tests without the local SDK.

Root `check` checks the whole repository. Root `test` runs the isolated
shared-script tests, then all mod workspace suites. Root `test:operations`,
`check:mod`, `check:views`, and `check:types` run the corresponding workspace
scripts. See each mod's README for its workspace commands.

Changesets and release commands run from the root.

### Git hooks

Install or upgrade prek, then install the Git hook from the repository root:

```sh
uv tool install --upgrade "prek>=0.3.2"
prek install
```

For an existing Husky checkout, check `git config --local --get core.hooksPath` before running `prek install`. If it returns `.husky/_`, run `git config --local --unset core.hooksPath`. Do not remove a different custom hook path.

The hooks run in order on every commit: line-ending normalization, Biome migration,
Biome check, recipe lint, and README installation prompt lint.
The first hook converts staged text files to LF before Biome runs.
The `.gitattributes` rule keeps text files in LF on checkout, including Windows with `core.autocrlf=true`; binary files are not converted.

The local hooks check the whole repository and do not receive staged filenames.
Biome check includes formatting, so no separate format hook is needed.
If a hook changes files, review and stage the changes, then retry the commit.
Run all hooks manually with `prek run --all-files`.
`npm ci` does not install Git hooks.

### Share on Herdr Gallery

Copy this prompt into your coding agent from the repository root. It covers
all mods in this checkout. Review the files before you approve publication.

```text
Read the repository's AGENTS.md, ~/.config/herdr-app/AGENTS.md if present,
and .agents/skills/share-herdr-mod/SKILL.md. Follow the sharing skill for
all mods under mods/*/, including required companion mods. Include any
immediate subdirectory with mod.json or main.js, even if one is missing.

Prepare or update each mod's bundle in its existing directory. Put RECIPE.md
and a privacy-safe preview.png next to mod.json and main.js. Write each recipe
so another agent can build the mod from an empty folder. Include a keys.json
snippet only for required bindings. Do not include a layouts/ directory.

Run the required checks for each mod. Report every mod's status and what is
needed to resolve missing files, failed checks, or checks you could not run.
Mark a mod as ready to share only when all its required checks pass.

Prepare the bundles locally. Get explicit approval before publishing the
approved bundles to a public GitHub repository and adding the herdr-mod topic.
```

## Quality and bundle checks

The [historical quality review](docs/mod-quality-review.md) records scores against [RUBRIC.md](RUBRIC.md), test evidence, and acceptance limits. Scores do not replace native interaction checks.

```sh
npm run check:bundles
npm run evidence:previews
```

`check:bundles` checks every mod root for workspace scripts, recipe sections and local links, license notices, JSON, parsed runtime imports, and bounded PNG structure/inflation with chunk CRCs. It excludes development dependencies, caches, and generated declarations from its source-file view. It is not a full image decoder or an inspection of a packaged archive. Missing required source files fail the check. Inspect each preview in an image viewer and test native interaction separately; this command does not establish sharing readiness.

`evidence:previews` captures actual fixture views in disposable macOS Herdr profiles. Evidence and process-cleanup records stay outside the repository. Preview generation does not change the owner's profile, perform real GitHub requests, or test physical pointer and keyboard input. A passing structural check or screenshot is not sufficient to call a bundle ready to share.

## Recipe lint

Run the Python linter from the repository root. It uses only the standard library:

```sh
uv run python scripts/lint_recipes.py
uv run python -m unittest discover -s scripts -p 'test_lint_recipes.py' -v
```

The linter requires `RECIPE.md` and `preview.png` in each immediate `mods/`
subdirectory that contains a `mod.json` or `main.js` file. It ignores directories
with only generated files or installed dependencies. The linter checks the
optional root `RECIPE.md` if it exists. Each recipe must have a non-empty H1 title
and these exact H2 headings: `What you see`, `How it behaves`, `Built from`,
`Watch out`, and `Done when`. Use ATX headings (`#` and `##`). Headings inside
fenced code blocks, HTML blocks, or HTML comments do not count.

The optional directory argument selects a different repository: `uv run python scripts/lint_recipes.py <directory>`. The default is the current directory. Errors include file paths and set exit code 1; success sets exit code 0. A directory with no recipe targets fails. This is a structural check, not a full Markdown renderer. It does not enforce section order or content, validate image data or links, or replace bundle and native checks. The prek commit hook runs it automatically. The npm and CI commands do not include it.

## README installation prompt lint

`prek` checks each mod README for a plain-text fenced installation prompt with
that mod's directory URL on GitHub. The linter checks immediate `mods/`
subdirectories with `mod.json` or `main.js`. Ordinary prose and prompts in HTML
comments do not count. Run the check and its tests from the repository root:

```sh
uv run python scripts/lint_readme_prompts.py
uv run python -m unittest discover -s scripts -p 'test_lint_readme_prompts.py' -v
```

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
