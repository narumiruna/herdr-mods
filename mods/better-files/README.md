# Better Files

A personal copy of Herdr App 0.1.15 Files. Click a local `.md` or `.markdown` file to read it **in the same Files pane**. Matching ignores letter case. The Back arrow returns to the file list. Markdown opens directly, with no file/root form or Open button. A failure shows an error, not a setup screen. No tab, split, overlay, or separate reader layout pane is created.

Other files keep the original read-only text preview. Directory clicks still expand or collapse folders.

**Sharing status: incomplete.** Owner interaction checks and passing required companion checks are still needed. The included native preview uses safe sample file-list data; it does not prove physical clicks.

## Requirements

- Herdr App 0.1.15. Other versions are unverified.
- Install this mod as `<app-home>/mods/better-files`.
- Install the required helper companion as `<app-home>/mods/markdown-reader`.
- Markdown Reader requires Node.js 26, its npm dependencies, and explicit Puppeteer browser setup. If Windows Herdr cannot find `node`, Better Files finds the installed executable through the persistent Windows PATH or `fnm`. This does not change the system PATH or install Node. Run root `npm ci` and `npm run setup:browser --workspace herdr-markdown-reader` before reading documents.
- Keep the bundled reader session and the installed reader helper from the same repository revision.

Herdr does not permit source imports outside a mod root. The local `reader/` directory contains Markdown Reader's UI, session, and host I/O modules. The embedded UI removes manual file selection. Its session module stays synchronized with the companion. Host I/O adds Windows Node discovery but keeps the companion helper protocol. The UI uses the helper already installed under `mods/markdown-reader/`. It does not contain a second Node renderer or browser.

## Install without replacing Files

Stop Herdr before creating links. The repository link script discovers `better-files` on its next run. On Windows, use `scripts/link.ps1`. Do not overwrite `<app-home>/mods/files`.

In a personal layout, change only the intended Files block's `content.mod`:

```json
{
  "id": "files",
  "type": "block",
  "content": { "mod": "better-files" }
}
```

Keep the existing node ID, sizes, props, and stack selection. Do not replace the complete layout or any keybindings. The source preparation does not install links or select a layout.

The separate Markdown Reader block was removed from Workbench. It is not needed for this Files preview.

## File-open behavior

- A row captures its file directory, workspace root, space ID, and machine identity when it is built. Later focus changes do not change the file or machine sent to the reader.
- Use the space folder as the reader root only when it contains the browsed folder. Otherwise, use the browsed folder. An unrelated space folder must not block a clicked file. Canonical containment checks still apply.
- Remote identity is preserved. Markdown Reader rejects remote files before local reads. There is no remote-to-local fallback.
- Missing or invalid Markdown context produces a browser error. It does not use a local preview fallback.
- The reader validates canonical paths and rejects outside-root files and resources, including escaping symlinks.
- `cx.new` creates a retained reader view inside the current Files body.
- Back, another file, or a workspace change closes the old reader session before its view handle is released. The application close hook also waits for pending reader cleanup.
- Local Markdown links replace the document in this same reader view after the previous session closes. Fragment links scroll within the document. No reader tab is created.
- Opening a document does not write layout state, shared state, keybindings, or source Markdown.

## Existing browser behavior

The copied browser lists the focused pane folder, hides `.git`, and sorts directories before files. It limits each folder to 500 entries, the complete tree to 5,000 entries, and recursion depth to 40. It refreshes every 10 seconds and watches local folders.

Directory listing starts `sh` or PowerShell. Git marks use read-only Git commands. Other file previews use `readTextFile`, reject NUL content, and display at most 400,000 text characters after the host read. The host read API can reject unavailable or excessive files. Source files are not written.

## Development

Run from the repository root:

```sh
npm test --workspace herdr-better-files
npm run check:mod --workspace herdr-better-files
npm run check:types --workspace herdr-better-files
npm run check:bundles
```

Native checks use temporary profiles. Fixed-data fixtures cover the file list, text preview, errors, embedded Markdown, remote rejection, and Back. They do not perform physical file clicks or modify the active profile.

For a visual render check, click `docs/markdown-reader-examples.md` in this repository through Better Files. It contains five Mermaid diagrams, four display equations, Python/Go/Rust code, and three Vega-Lite charts. Each section states the expected result. The helper rendered all twelve graphics without errors at 720 px in dark mode and 360 px in light mode. This does not replace the physical interaction checks below.

## Verified checks

- Better Files: 121 unit tests, type checks, the entry check, and all seven native fixtures passed on Herdr App 0.1.15/Windows.
- Markdown Reader: entry, nine native description fixtures, type checks, and seven real Chromium tests passed. The earlier full Windows unit run had 366 passes, 25 failures, and 3 unhandled test errors. Three additional helper CLI regression tests now pass.
- Windows Node discovery, a real helper render, and cancellation passed with Node absent from the simulated app PATH. A separate live Herdr process then returned complete JSON through its actual exec bridge and an installed helper junction: 34,384 bytes and 201 blocks.
- Scoped formatting checks pass. The installed Files runtime and icon hashes are unchanged.

## Remaining checks

- The actual `preview.png` was captured and inspected in an isolated Herdr 0.1.15 Windows profile. It contains no private file paths. Physical click and document-navigation checks remain required.
- The profile owner must verify local Markdown clicks, uppercase extensions, spaces/Unicode, Back, non-Markdown previews, folders, remote rejection, reader scroll/source controls, and unchanged normal app use.
- The unchanged Markdown Reader test suite has Windows failures related to symlink privileges, POSIX permissions/constants, and native-evidence process/socket tests. These failures must be resolved or verified in a supported environment before sharing readiness is claimed.
- The working tree has existing CRLF differences outside this mod. Full formatting and lint checks passed for all 148 checked files in a clean LF snapshot of the intended commit. No unrelated source files were rewritten.
- The Windows repository bundle check also reports a pre-existing Mod Manager test-file classification error. Its native path separators need a separate checker fix, or the check must run on the supported Linux/macOS environment. No check is weakened here.

To recover, restore the Files block's `content.mod` to `files`, close its preview, and stop Herdr before removing only the `better-files` link. Keep shipped Files, source documents, and unrelated layout state.

See [RECIPE.md](RECIPE.md), [NOTICE](NOTICE), [LICENSE](LICENSE), [reader UI license](reader/LICENSE), and [icon notices](THIRD-PARTY-NOTICES).
