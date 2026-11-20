# Repository Rules

## Documentation

- When adding or removing a mod, update `layouts/narumi.json` and `README.md` in the same change.
  - If a file needs no content change, check its mod references and state the reason in the pull request instead.
- Each `mods/<name>/` directory is a mod root and contains its `mod.json` and `main.js`.
- Embed the mod preview in `mods/<name>/README.md` with descriptive
  alt text and the relative path `preview.png`.
- Store each mod's recipe at `mods/<name>/RECIPE.md`, beside those runtime entry files.
- Do not put a mod recipe at the repository root or create a nested `mods/` directory inside the mod root for recipe packaging.
- Resolve recipe links and preview paths from the mod root, and update references when files move.

## Mod sharing

- For every mod under `mods/*/`, read and follow `.agents/skills/share-herdr-mod/SKILL.md` when adding or updating the mod.
- Require every mod, including required companion mods, to meet the skill's bundle, recipe, preview, and validation requirements before reporting it as complete or ready to share.
  - Report missing files, failed checks, and unavailable checks with the action needed to complete them; keep the mod marked incomplete until all required checks pass.
- Publish to GitHub only with explicit user approval, and meet the skill's publication requirements before reporting the mod as published.
