# Better Files implementation plan

## Goal

Copy the installed Files runtime into `mods/better-files/`. Open `.md` and `.markdown` directly in the same Files pane with a Back control. Never show file/root inputs or an Open control in the embedded reader. Remove the separate Markdown Reader pane from Workbench. Preserve other file previews, directory navigation, shipped Files, and source documents.

## Context

- The installed Files source is from Herdr App 0.1.15 on Windows. Its original `main.js` SHA-256 is `8296131be2d680db91711f1cd3a79d67de6b11b3328c06dfe8957028ec9bf7cf`.
- Native probing confirmed that Herdr rejects sibling-mod imports. The new mod therefore includes local copies of Markdown Reader's UI, session, and host I/O modules. They keep their MIT license and use the existing installed Markdown Reader helper.
- The initial implementation used new tabs. The user requires direct same-pane rendering, with no file/root form. No `tab.new` or layout mutation is used for file opening.
- The earlier Workbench reader block and its schematic preview were removed. The original terminal and shared Files/Changes/GitHub panel remain.

## Plan

- [x] Inspect the Files runtime, icons, license, SDK APIs, integration contract, and companion bundle.
- [x] Copy the Files runtime without generated SDK declarations. Preserve source/license notices and add captured-context Markdown entry validation.
- [x] Mount the local reader UI with `cx.new`. Keep a Back control and close the old reader before releasing its entity.
- [x] Correct the root when the browsed folder is outside the space folder. Use the containing space folder or the browsed folder without disabling canonical checks.
- [x] Remove the embedded reader's picker, input state, Open control, and setup form. Direct-load, ready-content, and error tests confirm that the form never appears.
- [x] Resolve installed Windows Node when the app cannot find it. Persistent PATH/fnm discovery, real helper rendering, and cancellation passed with no Node or fnm initialization on the simulated app PATH. No persistent environment setting was changed.
- [x] Remove the separate Workbench reader pane and its preview. JSON and source comparison confirm the original layout structure is restored.
- [x] Add workspace commands, recipe, installation notes, native fixtures, and tests. The scoped suite has 132 passing tests, including source compatibility, direct opening, no-picker states, Node discovery, and cleanup order.
- [x] Fix the helper CLI entry point for installed junctions. Three real CLI regression tests pass. Actual Herdr exec returned 34,384 bytes of valid JSON and 201 blocks through a junction, with an isolated offline core.
- [x] Run native entry checks, seven in-pane fixtures, and type checks for Better Files. Run companion entry/description/type checks and seven real Chromium tests. These checks pass.
- [ ] Pass the full repository and companion test gates. The unchanged reader suite has 25 Windows failures and 3 unhandled test errors. The Windows bundle checker misclassifies a Mod Manager test path. Full formatting and lint passed for all 148 checked files in a clean LF snapshot; existing working-tree CRLF differences remain unchanged.
- [x] Capture and inspect an actual `mods/better-files/preview.png` in an isolated Windows Herdr profile with sample tree data. No private paths are visible.
- [x] Keep embedded local document links in the same view. Nine real link-handler tests cover replacement, fragments, cleanup, scheduled refresh, failure, and external handlers.
- [x] Add `docs/markdown-reader-examples.md` for owner visual checks. All five Mermaid diagrams, four display equations, and three Vega-Lite charts rendered without errors at 720 px/dark and 360 px/light. The Python, Go, and Rust programs each printed `3`.

## Completion Checklist

- [x] Markdown entry props preserve the captured file, workspace root, and remote identity without a local fallback.
- [x] The reader is mounted inside Files. Back, replacement, and parent close wait for child cleanup before releasing the entity.
- [x] Other files use the original preview. Directory clicks still toggle the directory.
- [x] The installed Files runtime and original icon hashes remain unchanged.
- [x] Workbench has no separate Markdown Reader block. Other layout content remains unchanged.
- [ ] Required bundle files, companion checks, and owner acceptance all pass. Keep both mods marked incomplete until then.

## External Handoff

The profile owner must stop Herdr before linking `better-files`. Then change only the intended personal Files block's `content.mod` to `better-files`, keep its node ID, and reopen Herdr. Verify local Markdown, uppercase extensions, nested paths with spaces or Unicode, Back, other file previews, folders, and remote rejection. Check reader scrolling, source controls, close/cancel, and normal app use.

The actual Better Files preview was captured in a disposable Windows profile and inspected. It shows sample tree data, not physical file-click behavior. Physical interaction evidence remains required before sharing readiness is claimed.

For the companion's failed Windows checks, use a supported environment with the required symlink privileges and POSIX behavior, or address Windows test portability separately. Do not weaken checks. The remaining-check details are retained in `mods/better-files/README.md` and `RECIPE.md`. Review publication does not establish sharing readiness or authorize changes to the active profile. Do not replace shipped Files or change installed links as part of validation.
