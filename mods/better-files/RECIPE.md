# Better Files

Build a native file browser with an embedded Markdown Reader preview. This recipe is the build brief. The adjacent files are one implementation based on the installed Herdr App 0.1.15 Files mod.

![Better Files preview](preview.png)

**Sharing remains incomplete.** The included preview is an actual native file-list fixture capture from Herdr 0.1.15 on Windows. It was inspected for private content. Required companion checks and owner-operated interaction checks remain open.

## What you see

- An existing Files pane with a 42 px header, 28 px rows, local folder/file icons, Git marks, and native theme colors.
- A scrollable tree with nested indentation and loading, empty, error, and read-only text-preview states.
- The Markdown Reader UI inside the same Files body after a Markdown click. The Files header keeps its Back arrow.
- No new tab, split, overlay, or separate reader layout block. No fixed private document path is included.

## How it behaves

- Discover the focused pane folder and active space. Refresh lazily with local folder watching and a 10-second retry.
- Keep directory expansion/collapse and the 500-per-folder, 5,000-total, and depth-40 bounds.
- Match `.md` and `.markdown` without regard to letter case.
  - Capture the file directory, workspace root, space ID, and machine identity when each row is built.
  - Build the absolute file from that captured directory and relative row path.
  - Use the space folder as the root only when it contains the browsed folder. Otherwise, use the browsed folder. Keep canonical workspace containment checks.
  - Reject missing or invalid context. Never replace a remote identity with `null`.
- Open the selected document directly. Do not show file/root inputs, an Open button, or a setup form. Show an error if loading fails.
- Mount the reader with `cx.new` as a retained child of the Files body. Pass `{ file, root, on }`; do not send `tab.new` or mutate a layout.
- Follow local Markdown links in the same reader view. Close the previous session before reading the next document. Keep the workspace root and apply the linked fragment after rendering. Same-document fragments only scroll.
- The reader must reject a remote location before local reads and canonicalize local files and resources within the workspace.
- Back clears the preview and keeps the file list. Another file, a workspace change, or parent close must close the previous reader and then release its entity. Wait for pending cleanup in the parent close hook.
- Keep the original Editor preview for other files and `toggle` for directory clicks.
- Do not write source documents, shared state, keybindings, or layout state when opening a file.

## Built from

- This root contains `main.js`, `markdown.js`, `mod.json`, four SVG icons, the local `reader/` UI modules, workspace/check files, this recipe, and license notices.
- Herdr's module boundary forbids importing a sibling mod. Copy the reviewed Markdown Reader UI, session, and host I/O modules into `reader/`, with their MIT [license](reader/LICENSE). The embedded UI removes manual file selection. Keep the session copy synchronized; tests compare it and the license. Host I/O adds a tested Node launcher without changing helper arguments or request data.
- The required companion remains a separate `mods/markdown-reader/` root. The copied host I/O module calls its installed Node helper at `<app-home>/mods/markdown-reader/helper.mjs`. Node.js 26, the reader's dependencies, and explicit browser setup are required.
- Runtime APIs come from `gpui-kit`, `gpui-base`, and `herdr`. The Files browser uses `spaces`, `panes`, `focused`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, and `window`. The reader UI keeps its original helper, watch, timer, focus, and rendering APIs.
- `mod.json` uses `place: "none"`, enables focus, and records a clone of `files` from version 0.1.15.
- Install this root as `<app-home>/mods/better-files`. Change only an intended personal Files block's `content.mod` to `better-files`. Keep its ID and container settings. No layout or keybinding file is included in this mod.
- See [NOTICE](NOTICE) for provenance and modifications, [LICENSE](LICENSE) for Apache-2.0, and [icon notices](THIRD-PARTY-NOTICES).
- Entry and fixed-data native checks use Herdr App 0.1.15 on Windows. Other native versions and platforms remain unverified.

## Watch out

- The browser starts local or remote `sh`/PowerShell and read-only Git commands. Authored document contents are not used as shell commands.
- The reader starts a local Node helper and can use sandboxed Chromium for diagrams. If Windows Herdr cannot find `node`, discover an installed Node.js 26+ through the persistent Windows PATH or `fnm`, then cache its absolute executable path for rendering and cancellation. Do not install software or change persistent environment settings. Its existing resource, cache, timeout, and cancellation limits remain in effect.
- The reader writes request JSON with absolute document, workspace, and app-home paths under `<app-home>/data/markdown-reader/requests/`. It writes rendered assets, render metadata, and renewed asset leases under the same reader data directory. Normal cleanup removes request, cancellation, and lease files. Cached assets remain subject to expiry and the cache limit; do not publish this data directory.
- Explicit clicks on HTTP(S) or mailto links launch the system handler. That handler can make network requests or start another application. Rendering uses no external chart data or remote document images.
- The workspace must be owner-controlled. Canonical checks are not an OS sandbox against concurrent replacement of directories.
- The bundled UI and installed helper must use the same reviewed source revision. The clone does not automatically receive shipped Files or reader updates.
- File lists, error text, and document headers can expose private paths. Remove private content from the actual preview.
- Reader cleanup has the host's bounded app-quit budget. Forced termination can leave temporary reader data until its normal expiry.
- Restore `content.mod: "files"` to disable this route. Keep shipped Files and source Markdown unchanged.
- This mod and its required companion remain incomplete until bundle files, checks, actual previews, and owner acceptance meet the repository rules.

## Done when

- Routing and row-click tests cover case-insensitive extensions, Windows/POSIX paths, spaces/Unicode, captured context, remote identity, and invalid context.
- Tests show the reader is mounted in the current Files body, with no `tab.new`, split, overlay, or layout mutation. Tests of the real embedded link handler cover local document replacement, fragments, close-time cleanup, scheduled refresh, cleanup failure, and explicit external links.
- Back, replacement, workspace changes, and parent close clean up the reader before releasing its entity. Other files and folders keep their original behavior.
- The matching entry check, all seven fixed-data native view checks, and type checks pass in disposable profiles.
- The reader session matches the required companion source. A Node-launcher test verifies real rendering and cancellation when Node is absent from the app PATH. Direct-open and invalid-entry tests confirm that no setup form or Open button appears. Bundle and recipe checks pass for both mods.
- The included private-content-free `preview.png` is a real native fixture capture and has been inspected. Do not treat it as physical click evidence.
- The profile owner verifies physical file clicks, Back, nested paths, remote rejection, scrolling, source controls, close/cancel, and normal app use.

See the [remaining checks](README.md#remaining-checks). Code tests and native description checks do not prove physical interaction or sharing readiness.
