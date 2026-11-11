# Layout Manager

A native dialog for putting installed Herdr mods into a right-side panel. The user selects a mod, sets its JSON props, and adds it without editing a layout file. A small dock header switches between saved views and opens the manager again.

## What you see

- A 1000 × 680 dialog with the theme's `canvas` background and 13px base text.
- A 58px `chrome` header: **Layout Manager** at 17px, the current layout name, **Refresh**, and **Close**.
- A 240px `chrome` list on the left. A 34px search field, result count, and scrolling mod rows show title and Installed, Herdr, Managed panel, or Unavailable.
- A scrolling detail area with 22px padding: title, folder, availability message, existing integrations, a 132px JSON textarea, action buttons, and reinstall guidance.
- Shipped layouts show a clone-name field and **Clone current layout**. File actions are disabled there.
- The managed dock is 380px wide initially, adjustable between 240 and 900px. Its 36px header contains scrolling mod tabs, **Manage**, and **Hide**. The selected mod fills the remaining height.
- Colors come from `theme()`. No external assets or preview image are required to run it.

## How it behaves

- Opening or refreshing scans installed folders and development links without executing them. Search matches title and folder. At most 100 rows render initially; **Show more** adds another 100.
- Selecting a mod restores its props draft, or its saved managed props. Refresh discards drafts.
- **Add to right panel** adds one managed block per mod name. Repeating it updates that slot rather than creating a duplicate.
- **Save panel props** saves the selected slot's object and shows the slot.
- **Show panel** selects a managed slot and shows the dock without writing the layout.
- **Open overlay** runs the selected mod with the draft props and the supported kind and dimensions in its manifest. It does not keep the window across restarts.
- **Remove from panel** removes only the managed slot. Removing the final slot restores the original body as root, with the current root look and window fields.
- Missing mod references stay saved. A same-name reinstall reuses the reference and props.
- Existing special integrations are listed, not replaced. The manager does not infer footer or tab-bar modes.
- All agent statuses remain owned by the original layout and its mods. Layout Manager does not display or change working, blocked, done, or idle states.
- No automatic installation, layout mutation, polling timer, network request, key rebinding, or external program is used.

## Built from

All files live directly under `mods/layout-manager/`.

- `main.js`: one View with a dialog mode and a lightweight `{mode:"dock"}` header mode. Header mode creates no inputs, discovery tasks, or timers.
- `model.js`: immutable tree validation, reference discovery, props parsing, stable slot IDs, root wrapping, and removal.
- `runtime.js`: manifest discovery, missing-slot display, personal-layout checks, compare-and-swap saves, and overlay specifications. Its I/O is injected for tests.
- `mod.json`: `place:"none"` and a 1000 × 680 dialog.
- `package.json`, `jsconfig.json`, tests, and native fixture scripts provide repository checks.
- Herdr APIs: `appHome`, `readTextFile`, `writeTextFile`, `shared("layout")`, `layout`, `theme`, `openOverlay`, `closeOverlay`, `props`, and `run`.
- Commands: `layout.clone`, `layout.select`, `layout.show`, `layout.hide`, and `mod.open`.
- `fs/promises` supplies directory listing and existence checks. Read through mod paths instead of filtering only directory entries, so symlinks work.

The original tree becomes the first child of `layout-manager-frame`. The second child is `layout-manager-dock`, with `layout-manager-header` and `layout-manager-stack`. Slot IDs are `layout-manager-mod-<folder>`. The header's props save display titles. Slot content saves the mod name and props.

## Watch out

- Never edit shipped layouts. Read `installed.json` again before a write; missing or invalid metadata must fail closed.
- Compare the current layout name and loaded file contents before saving. Use the host's atomic expected-content write, not an unconditional file write.
- Preserve original node IDs. Promote root look, titlebar, traffic-light, preview, menu, toast, and clone fields to the wrapper and restore current values on unwrap.
- Reject reserved-ID collisions and unexpected edits to owned nodes. Do not delete foreign children.
- Use a Map for props drafts so valid folder names such as `constructor` do not use object prototype values.
- Give both dialog columns full height. Give inventory rows fixed flex sizing so the scrolling list does not collapse.
- Create InputState and TextareaState in init, not render. Release them on close. Each asynchronous task must use its own `cx`.
- Hidden views and an uninstall do not prove that external programs stopped.
- Only letter/digit-led names containing letters, digits, dots, underscores, or hyphens are supported. The tree must have unique explicit node IDs.
- Keep runtime code independent of Node.js. Node, Vitest, Biome, and TypeScript are development tools only.

## Done when

- Unit and fixture tests pass for normal and linked discovery, missing reinstalls, immutable transforms, props, root fields, collisions, stale files, shipped metadata, layout switches, and view actions.
- Native checks pass for every documented view state.
- In a disposable live layout, adding a mod shows its saved props, the dock header renders, and removing the final slot restores the original tree.
- The dialog's mod list and detail both scroll at their assigned heights.
- Herdr reports no errors, and the original personal layout file remains unchanged.
