# Native reader evidence

`scripts/native-evidence.mjs` checks and captures the actual reader in isolated Herdr windows. It does not install the reader into the active profile.

## Run

Requirements: macOS, `/Applications/Herdr.app`, Node 26 or later, the workspace dependencies, and the Puppeteer browser already installed. This script does not install or download dependencies.

From the repository root:

```sh
node mods/markdown-reader/scripts/native-evidence.mjs
```

The command prints a new temporary output directory. For an explicit directory:

```sh
node mods/markdown-reader/scripts/native-evidence.mjs --output /tmp/herdr-md-evidence
```

The output directory must not exist. It must be outside the repository. Use a short path: the resolved `graphics-dark/profile/herdr-app.sock` path must be less than 104 bytes. The macOS default temporary directory can exceed this socket limit, so the script uses `/tmp` for its default output.

Do not change reader source files during a capture run. Captures show the current viewport, not the whole scrollable document. Screen dimensions and installed fonts can change the result. PNG hashes identify captures; they are not cross-machine pixel-equality assertions.

## Fixture and modes

The fixture calls the real `helper.mjs` `runRequest()` with `fixtures/reader.md`. Requests use the required `<app-home>/data/markdown-reader/requests/native-evidence.json` path. The job name satisfies the helper's 8–100 character lowercase identifier rule. `on` is null, and the fixture root is explicit.

The real renderers produce MathJax, official Mermaid.js, and static Vega-Lite SVG assets. Generation runs once for each light, dark, and narrow render configuration. Other modes reuse that manifest and copy its immutable assets into their own app homes.

Each app loads a fixture subclass of the repository's `main.js`, copied as `view.js`, with copies of `model.js` and `runtime.js`. The subclass replaces refresh, folder watching, and I/O with fixed fixture state. It calls `prepareEditors()` after assigning the manifest and raw-mode state. Editor creation does not occur in render. Apart from an external mode label, the subclass uses the actual reader render method.

| Mode            | Native state                                                                    |
| --------------- | ------------------------------------------------------------------------------- |
| `light`         | Full manifest, paper theme                                                      |
| `dark`          | Full manifest, graphite theme, dark SVG generation                              |
| `narrow`        | Full manifest in a 480 logical-pixel window; 400-pixel helper width             |
| `raw`           | Document source in the actual read-only Editor                                  |
| `error`         | Intentional reader error, without a loaded manifest                             |
| `loading`       | Intentional busy state, without a loaded manifest                               |
| `prose`         | Actual manifest with code and graphics removed recursively, to expose footnotes |
| `graphics`      | Actual top-level graphic blocks only, with unchanged reader cards               |
| `footnotes`     | Actual HTML blocks with generated footnote markers or definitions               |
| `graphics-dark` | Actual graphic blocks from the dark manifest, with unchanged reader cards       |

A new app starts with a custom static layout for each mode. Filtered captures have an explicit filtered-mode label. The script does not use background `layout.switch`: the feasibility spike found that `shot` could return a stale frame after that command.

## Isolation and cleanup

- Every launch receives an owned `HOME`, `HERDR_APP_HOME`, restricted `PATH`, `HC_SOCKET`, temporary directory, and XDG directories. The script does not inherit the active app/core environment.
- A Node protocol shim occupies `settings.core`, the isolated PATH, and the isolated home's `.local/bin` core locations.
  - The shim answers the generation-1 hello and framed status, subscription, terminal-list, machine-list, and document-read requests with an empty world.
  - It advertises the reviewed hc 0.1.20 method names so Herdr 0.1.15 does not try a core upgrade. Every unimplemented request, including document writes and program execution, is rejected. It never connects to a real core or starts a daemon.
  - Frames use a kind byte, little-endian channel u32, little-endian payload-length u32, and JSON payload. Input is bounded.
- Welcome is marked finished. Telemetry and sounds are disabled. The releases URL points to a closed loopback port. A restricted-PATH `curl` wrapper rejects install downloads. Update-note state suppresses the first-run update toast. These controls are not an operating-system network sandbox.
- Mermaid uses the real renderer's request interception and security controls. Its Chromium profile and process group are owned by the run.
- The script sends no pointer or keyboard input and does not read or write the clipboard. The reader's copy buttons remain visible but are not activated.
- App and CLI processes have owned process groups. The script requests isolated `app.quit`, then uses TERM/KILL only for recorded owned groups when needed. It records the app group's process list, including transient shell children. Browser closure is checked after real helper completion. `cleanup.json` records any remaining owned groups.

The run fails if a real fixture block fails, a native check fails, `status.errors` is missing or nonempty, the active layout differs, a capture is invalid, the shim handshake is absent, or an owned group remains. The intentional reader error is not a native runtime error and must not appear in `status.errors`.

## Output

- `captures/<mode>.png`: native app captures.
- `captures.json`: app version, dependency versions, source/SDK hashes, capture hashes, manifest block identifiers, browser startup timing, and cleanup result.
- `timing.json`: per-mode generation/reuse, check, launch/capture/shutdown, and total times.
- `cleanup.json`: final owned-group check. `remaining` and `errors` must both be empty.
- `<mode>/check.json`, `status.json`, `status-after-shot.json`, `manifest.json`, `processes.txt`, `owned-app.json`, `offline-core.jsonl`, and `app.log`: checks and diagnostic evidence.
- `<mode>/profile/`: retained custom layout, fixture subclass, real manifest, SVG assets, and SDK files generated by the installed app.
- `failure.json`: diagnostic information when a run fails after creating its owned directory.

No generated image or binary belongs in the repository. Remove only the printed owned output directory when the evidence is no longer required.

## Observed result and support boundary

The reviewed Herdr 0.1.15 runs completed all ten modes. All checks passed, both status samples per mode had `errors: []`, and no recorded owned process group remained. Each run records its actual elapsed time in `captures.json` and `timing.json`.

Visual inspection established these fixture-specific results:

- Native prose, GFM tables, task markers, nested lists, Chinese text, and highlighted read-only code are visible.
- `graphics` shows the MathJax fraction/radical, the official Mermaid flowchart with Chinese labels, and a two-bar static Vega-Lite chart. `graphics-dark` uses the corresponding dark SVG assets.
- `prose` and `footnotes` show a linked numeric footnote reference, a Footnotes section, the definition, and its backlink. The helper converts Markdown footnotes into explicit HTML semantics. This does not establish native `TextView.markdown()` footnote support. Link activation and return navigation were not exercised.
- Raw source, loading, and the intentional error state are visible.
- Native logs contain SVG parser and font-fallback warnings, although status reports no errors. In particular, skipped SVG rectangles and unsupported `letter-spacing: normal` were reported. Do not infer complete SVG/CSS/font fidelity from the captures.

**Inline mathematics remains unsupported.** The preceding Herdr 0.1.15 spike found no inline image for HTML MathJax/data-SVG, data-PNG, or local SVG controls. A separate display formula is not successful inline mathematics. The reader deliberately shows inline TeX source and a warning. This script does not repeat those failed inline controls and does not establish baseline, wrapping, selection, or copy behavior for inline assets.

The upstream handoff remains an inline-asset or Markdown-plugin API with explicit dimensions, baseline, wrapping, selection, and copy semantics, followed by native fixture tests. Do not claim full inline math support before that API and its tests pass.

Selection/copy, button activation, zoom interaction, user scrolling, local-link activation, live refresh/watch behavior, live Files integration, arbitrary SVG fidelity, and interactive Vega are not established by this script. Security failure/timeout tests are separate from this successful fixed-document capture run.

## Reviewed sources

- Repository `AGENTS.md` and the implementation requirements retained in [verification and handoff](verification.md).
- Reader `main.js`, `model.js`, `runtime.js`, `helper.mjs`, `document.js`, `cache.js`, `renderers/index.js`, `renderers/mermaid.js`, and `scripts/check-views.mjs`.
- Installed-app `AGENTS.md`: native check and shot behavior, layout ownership, settings/core lookup, telemetry, mod lifecycle, Editor initialization, and app-home asset paths. Each run retains the installed app's own generated SDK files rather than using a newer cached SDK.
- Installed `herdr.d.ts`: `appHome`, `props`, `settings`, `theme`, `exec`, and folder-watch APIs. Installed `gpui-kit.d.ts`: `TextView.html`, `TextView.markdown`, selectable text, native image elements, and Editor APIs.
- A preceding isolated feasibility spike supplied the tested protocol and inline-image controls. The repository script includes the protocol shim and does not require files from that temporary run.
