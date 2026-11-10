# Repository Rules

## Documentation

- Each `mods/<name>/` directory is a mod root and contains its `mod.json` and `main.js`.
- Store each mod's recipe at `mods/<name>/RECIPE.md`, beside those runtime entry files.
- Do not put a mod recipe at the repository root or create a nested `mods/` directory inside the mod root for recipe packaging.
- Resolve recipe links and preview paths from the mod root, and update references when files move.
