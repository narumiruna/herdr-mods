# Layout Manager

A native graphical editor for one managed Herdr mod panel. Drag installed mods into the panel, move it to any window edge, and change its tab order. Existing layout integrations stay unchanged.

## What you see

- A 1000 × 680 dialog with theme colors and 13px base text.
- A 58px `chrome` header: **Layout Manager**, current layout, **Refresh**, and **Close**.
- A 240px full-height inventory with a search field and scrolling mod cards. Each card has a **⠿** grip, title, and availability status.
- A scrolling editor with 22px padding. **Visual layout** contains a 330px schematic canvas with four edge targets and nested blocks for the existing body.
- When present, the managed panel appears at its saved edge. It has a **Panel** grip, scrolling draggable cards, and **Drop to append**. Each card has **Earlier** and **Later** buttons.
- **Place selected mod** buttons and a separate remove target follow the preview. The selected mod's title, existing integrations, JSON props editor, and action buttons are below them.
- Shipped layouts show a clone-name field and **Clone current layout**. Editing and drag initiation are disabled there.
- The live panel retains its 36px header with scrolling tabs, **Manage**, and **Hide**. Its initial extent is 380px; the owned model accepts 240–900px. The frame's divider supports native resizing.
- The footer shows drag instructions while a gesture is active. No external assets are required.

## How it behaves

- Opening or refreshing scans installed folders and development links without executing them. Search matches title and folder. Render at most 100 inventory cards initially; **Show more** adds 100.
- Selecting a mod restores its props draft or saved props. Use a Map so names such as `constructor` are safe. Refresh discards drafts.
- Pressing a grip starts a pending gesture. A distance of at least 5 logical pixels activates it. Store source kind and mod name, not a list index.
- Edge targets accept a mod or the entire panel. A new mod uses its current draft and creates one stable slot. An existing managed mod keeps saved props. Moving to an edge positions the entire panel, not an independent second panel.
- Card targets insert a mod before the target name. The append target moves it to the end. Saved props, saved and live active tabs, and panel visibility remain unchanged.
- Each card's native **Earlier** and **Later** buttons move it one step. Use `tab_stop` and `accessibility_label` for keyboard access and native accessibility. Boundary moves and blocked edits are disabled. Do not require mouse selection first.
- The remove target accepts only a managed mod. Removing the final slot unwraps the body and restores current root settings.
- A valid drop saves immediately. Clear the gesture before asynchronous work. No click-only save or automatic retry occurs.
- Cancel on root release outside a target, pointer exit, outside press, Escape, a new background press, refresh, layout change, and close. Focus the root's handle only when a grip is pressed, not on render.
- The same placement, props, removal, overlay, and show operations remain available through buttons. **Add to panel** uses the current edge or defaults to right.
- Missing managed mods can move, reorder, or be removed without parsing a draft. Reinstalling the same folder name reuses saved props.
- **Open overlay** uses explicit draft props and the manifest's supported kind and dimensions. It does not persist windows.
- Existing tab bars, footers, pane headers, status displays, and arbitrary body blocks are not moved or replaced. The preview is schematic, not an embedded live terminal or a general layout-tree editor.
- No polling timer, installation, network request, external program, or key rebinding is added.

## Built from

All files live directly under `mods/layout-manager/`; resolve links and assets from this mod root.

- `main.js`: one View with graphical dialog mode and lightweight `{mode:"dock"}` header mode. The header creates no inputs, discovery tasks, focus handles, or timers.
- `model.js`: immutable tree validation, reference discovery, props parsing, stable slots, wrapping, four-edge placement, reordering, and removal.
- `runtime.js`: manifest discovery, missing-slot display, personal-layout checks, expected-content saves, and overlay specifications. I/O is injected for tests.
- `mod.json`: `place:"none"` and a 1000 × 680 dialog.
- `package.json`, `jsconfig.json`, tests, and native fixture scripts supply development checks.
- Herdr APIs: `appHome`, `readTextFile`, `writeTextFile`, `shared("layout")`, `layout`, `theme`, `openOverlay`, `closeOverlay`, `props`, and `run`.
- Commands: `layout.clone`, `layout.select`, `layout.show`, `layout.hide`, and `mod.open`.
- `fs/promises` supplies directory listing and existence checks. Read through paths so development links work.

Use only supported GPUI mouse handlers: `on_mouse_down`, `on_mouse_move`, `on_mouse_up`, `on_hover`, and `on_mouse_down_out`. Use `cx.focus_handle()`, `track_focus`, and `on_key_down` for Escape. Herdr 0.1.15 has no generic internal `on_drag` API; `on_drop` is for external files. There is no pointer capture or outside-release callback, so leaving the dialog cancels rather than resuming a stale drag.

The outer node is `layout-manager-frame`. It contains exactly the original body and `layout-manager-dock`. A row puts the dock at left or right; a column puts it at top or bottom. Child order determines the edge. Do not add separate position metadata. The dock keeps `layout-manager-header` and `layout-manager-stack`. Slots are `layout-manager-mod-<folder>`. Header props save display titles; slot content saves the mod name and props.

Public transforms:

- `dockPosition(root)`: return the saved edge or `null`.
- `moveDock(root, position)`: copy the layout and change frame direction and child order.
- `reorderPanel(root, name, before = null)`: copy the layout and insert before a managed name, or append.
- Existing `addPanel` and `removePanel` operations retain their stable IDs and ownership checks.

## Watch out

- Never edit shipped layouts. Read `installed.json` again before every write; missing or invalid metadata must block editing.
- Capture the layout and compare its current name and exact contents before saving. Use `writeTextFile(path, next, expected)`; never write unconditionally or merge stale layouts.
- Preserve original node IDs, body fields, and saved props. Promote root look and window fields to the frame; restore current values when unwrapping at any edge.
- Keep strict reserved-ID and owned-structure validation. Allow only the documented frame orientations and child orders. Never remove foreign children to repair an unexpected structure.
- Use window-relative pointer positions for the movement threshold. Do not use the absent pressed-button state or assume native drag payload support.
- Give edge targets nonzero hit areas. Stretch preview rows and their children across the available height. Mark the hovered target and show an insertion border above a destination card.
- Create input states and custom focus handles in init and release them on close. Native reorder buttons retain their own focus by stable IDs. Each callback and async task must use its own `cx`.
- Keep runtime code independent of Node.js. Vitest, Biome, and TypeScript are development tools only.
- Hiding a view or removing a placement does not prove that external programs stopped.

## Done when

- Tests pass for discovery, props, missing reinstalls, immutable transforms, all edge transitions, root restoration, tab reordering, reserved collisions, and stale writes.
- Gesture tests verify thresholds, rendered handler wiring, feedback, cancellation, read-only states, missing mods, layout switches, and duplicate releases.
- Reorder tests verify keyboard button labels, tab stops, boundary moves, guarded saves, and no live select or show commands for an existing card.
- Native fixtures pass for all four panel edges, active edge/reorder/remove targets, and the existing recovery states.
- Type and repository checks pass.
- Inspect the actual graphical dialog with `herdr-app shot`; check stretching, scrolling, and readable targets without editing the live layout.

Physical pointer acceptance remains a profile-owner check in a disposable personal layout. Verify edge drops, tab reordering, removal, Escape, pointer-exit cancellation, Tab navigation, Enter and Space activation, and screen-reader labels. Automated handlers and one-frame native checks do not prove physical pointer dispatch. Do not automate the user's display.
