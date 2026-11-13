# Native fixture reproduction

Native checks and captures use disposable profiles, not the owner's live installation. The Windows entry and all 16 native fixtures passed; exact post-merge results and remaining capture limits are in [verification.md](verification.md). Fixed state does not prove physical clicks, selection/copy, scrolling, live watches, or owner acceptance.

## Entry and native descriptions

Requirements: Node.js >=26, installed dependencies, explicit Puppeteer browser setup, and matching Herdr App 0.1.15 on PATH. Windows App 0.1.15 is available; other app versions are unknown.

From the repository root:

```sh
npm run check:mod --workspace herdr-better-files
npm run check:views --workspace herdr-better-files
```

`check:mod` runs the real mod entry check, seven Files fixtures, and the reader fixture script. `check:views` omits the initial real-root entry check, but runs the same fixtures. Scripts allocate temporary app homes and remove only their owned temporary directories afterward. Generated SDK declarations must not enter the shared bundle.

| Files fixture     | Fixed state                          |
| ----------------- | ------------------------------------ |
| `empty`           | No listed files                      |
| `tree`            | Safe sample folder/file list         |
| `preview`         | Read-only non-Markdown native Editor |
| `error`           | Folder error                         |
| `markdown`        | Embedded direct-open Markdown        |
| `markdown-remote` | Remote rejection                     |
| `markdown-back`   | Return to Files after embedded open  |

The Files fixtures use the actual Files implementation with injected state and mocked reader I/O. They do not run a physical row click or a real document helper job.

`node mods/better-files/scripts/check-reader-views.mjs` separately runs nine reader descriptions: `missing-entry`, `loading`, `error`, `ready`, `raw`, `source`, `refresh-error`, `remote`, and `unsafe-manifest`. It calls the real `reader/helper.mjs` with `fixtures/reader.md`, validates the generated manifest, rejects unexpected graphic errors, and injects fixed UI state. Its request is `<temporary-app-home>/data/better-files/requests/native-fixture.json`. Missing entry must fail without an Open form. These checks do not establish live refresh or navigation.

## macOS capture script

The retained evidence script requires **macOS**, `/Applications/Herdr.app`, Node.js >=26, dependencies, and Puppeteer's browser already installed. It does not install/download them. It cannot capture Windows, even when Windows Herdr is available. Record an unavailable macOS run honestly; do not use old standalone captures as new evidence.

From the repository root:

```sh
npm run evidence:native --workspace herdr-better-files
node mods/better-files/scripts/native-evidence.mjs --output /tmp/herdr-files-evidence
```

From the mod root, its interface is `node scripts/native-evidence.mjs [--output NEW_DIRECTORY]`. Use either the default new temporary directory or a new explicit path outside the repository; the explicit path must not exist. Keep it short: the resolved `graphics-dark/profile/herdr-app.sock` path must be less than 104 bytes. The default is under `/tmp` for this reason.

Do not change source during a run. Captures show the current viewport, not the whole scrollable document. Screen scale and installed fonts affect output; PNG hashes identify files, not cross-machine pixel equality.

### Fixture and modes

The script calls the real `reader/helper.mjs` `runRequest()` with `fixtures/reader.md`, explicit local root, and `on: null`. Requests use `<temporary-app-home>/data/better-files/requests/native-evidence.json`. Real MathJax/Mermaid/Vega renderers generate assets once per light/dark/narrow configuration; other modes reuse the manifest and copy immutable assets into their own app homes.

Each capture injects a fixed Reader subclass as a retained child of the actual Files subclass shell. Reader modules are copied from `reader/`. The fixture is installed only in its disposable profile as `mods/better-files`, so Files SVG paths resolve. Layout names are `better-files-evidence-${mode}`. It uses the real render methods, but replaces refresh/watch/I/O with fixed state and prepares editor states outside render.

| Mode            | Native state                                                                             |
| --------------- | ---------------------------------------------------------------------------------------- |
| `missing-entry` | Direct-open failure without file props; no Open form; metadata state `direct-open-error` |
| `light`         | Full manifest, paper theme                                                               |
| `dark`          | Full manifest, graphite theme and dark SVG                                               |
| `narrow`        | Full manifest, 480 logical-pixel window, 400-pixel helper width                          |
| `raw`           | Full-document source in the read-only Editor                                             |
| `error`         | Injected reader error without a loaded manifest                                          |
| `loading`       | Injected busy state without a loaded manifest                                            |
| `prose`         | Code/graphics removed recursively to expose prose/footnotes                              |
| `graphics`      | Top-level graphic cards only                                                             |
| `footnotes`     | Compiled footnote HTML reference/definition blocks only                                  |
| `graphics-dark` | Dark top-level graphic cards only                                                        |

Filtered modes have explicit labels. The script does not repeat the retired standalone Open-form behavior or use background layout switching as capture proof.

### Isolation and cleanup

- Each launch owns its HOME, app home, socket, PATH, temporary/XDG directories, and app/CLI process groups. It does not inherit the owner's active app/core environment.
- A bounded Node protocol shim supplies an empty offline core. It handles the reviewed hello/status/subscription/list/document-read protocol and rejects unimplemented requests, including writes and program execution. It never connects to the real core or starts its daemon.
- Welcome/update-note state is disposable; telemetry/sounds are disabled. A closed-loopback releases URL and rejecting `curl` wrapper prevent the fixture's install-download routes. These controls are not an OS network sandbox.
- Mermaid keeps the production request blocking and Chromium sandbox. Its temporary browser profile/process group belongs to the run.
- Startup status has a 15-second deadline; only missing/refused connections to the owned macOS socket are retried. App exit, invalid status, runtime errors, other command errors, or deadline expiry fail the run. CLI output is consumed through stream closure before JSON parsing.
- The script sends no pointer/key input and does not access the clipboard. It requests isolated `app.quit`, then uses TERM/KILL only for recorded owned groups if needed. It checks browser exit and records remaining groups; it must not search for or terminate unrelated processes.

A run fails for an unexpected graphic failure, failed native check, absent/nonempty `status.errors`, wrong layout, invalid PNG, missing shim handshake, or remaining owned group. An intentional reader error is UI state, not a native runtime error.

### Output and review

- `captures/<mode>.png`: native viewport captures.
- `captures.json`: app/dependency versions, source/SDK and PNG hashes, manifest block IDs, browser timing, and cleanup summary.
- `timing.json`: generation/reuse, check, capture/shutdown, and total times.
- `cleanup.json`: final owned-group check; `remaining` and `errors` must be empty.
- `<mode>/check.json`, `status.json`, `status-after-shot.json`, `manifest.json`, `processes.txt`, `owned-app.json`, `offline-core.jsonl`, and `app.log`: diagnostics.
- `<mode>/profile/`: disposable fixture/layout/assets and installed-app SDK output. `failure.json` records failures after output creation.

Inspect every capture and the two status samples per mode, logs, hashes, timings, and cleanup record. Report native SVG/font warnings even with `errors: []`. Retained full captures can expose absolute private source paths; do not share them unchanged. Keep generated output outside Git. Remove only the printed owned output directory when no longer needed.

The existing `../preview.png` remains the genuine inspected Windows 600 × 525 safe file-list fixture. Do not replace it with generated imagery or describe it as merged-reader evidence.

## Evidence boundary

Inline math is unavailable. The reader keeps visible TeX plus a warning. Native display images do not establish inline baseline, wrapping, selection, copy, or full LaTeX support. Static Vega captures do not establish interactivity. Sanitized SVG can differ from browser SVG/CSS/fonts.

Neither descriptions nor captures establish physical file/link clicks, Back/Escape, clipboard round trips, user scrolling, zoom/button operation, watch/reload recovery, source immutability under owner use, forced-crash cleanup, or live-profile integration. Run separate security/timeout/real-browser tests, then complete [owner physical acceptance](verification.md#owner-physical-acceptance). Sharing remains incomplete until all required checks pass.
