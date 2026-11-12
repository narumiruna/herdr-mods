# Markdown Reader

Read local Markdown in a native Herdr pane. Prose stays selectable native text. Code uses a read-only native editor. MathJax, official Mermaid.js, and Vega-Lite produce local SVG assets.

**Inline math is not typeset on Herdr 0.1.15.** `$...$` stays visible as TeX source, with a warning. Display math (`$$...$$`) works. Do not describe this version as complete LaTeX support. See [verification and handoff](docs/verification.md).

**Sharing status: incomplete.** The source bundle, recipe, and actual preview are prepared. Owner-operated live acceptance and Community publication have not been completed.

## Requirements

- Herdr App 0.1.15. Native captures were checked on Apple Silicon macOS. Other native platforms are unverified.
- Node.js 26 on the app's PATH.
- Installed npm dependencies, either from the complete repository checkout or inside the standalone mod folder, and Puppeteer's pinned Chromium build.
- Installed system fonts for diagram labels. Chinese labels were checked with macOS system fonts.

The helper needs installed Node dependencies; they are not bundled in Git. A standalone mod folder can install them locally. No web server, database, or Morsel service is needed. The [recipe](RECIPE.md) is the rebuild brief. Community publication and live-profile interaction checks remain incomplete.

From the repository root:

```sh
npm ci
npm run setup:browser --workspace herdr-markdown-reader
```

For a standalone mod folder, run `npm install --omit=dev` and `npm run setup:browser` from that folder instead. Keep its `package.json` security override and [dependency notices](DEPENDENCIES.md).

Browser setup downloads the build selected by the pinned Puppeteer version. It is an explicit setup step, not a download on document open. The renderer keeps Chromium's sandbox enabled.

Stop Herdr before running the repository's `scripts/link.sh`, which links local mods and layouts. Reopen it afterward. Do not edit shipped mods or layouts. The reader has `"place": "none"`; linking it alone does not change Files clicks.

The Node helper uses `import.meta.main` for its CLI entry point. This supports both copied installations and directory junctions or symbolic links. A path comparison against `process.argv[1]` is not sufficient because Node resolves the module path before loading it.

## Open a document

Open Markdown Reader from Herdr's mod menu. Enter the absolute workspace root and Markdown file paths, then select **Open file** or press Enter. No Files clone or shell command is needed for this first open. **Open…** selects another local file; **Cancel** keeps the current document. Neither path is inferred or saved between reader instances.

For a command-based open in an existing local space, pass explicit paths:

```sh
herdr-app do tab.new '{"name":"README","mod":"markdown-reader","props":{"file":"/absolute/project/README.md","root":"/absolute/project","on":null}}'
```

Use `.md` or `.markdown`, including uppercase extensions. The canonical file must be inside the canonical root. A remote `on` value is rejected before any local document read. File paths from remote spaces are never treated as local paths.

To open Markdown by clicking Files, use the [offline Files-clone preparation guide](docs/files-integration.md). It prepares a personal Files mod and a personal layout in a separate output directory. It does not install them, change the active profile, or replace shipped files.

## Features and limits

| Content            | Behavior                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown/GFM       | Native text, tables, strikethrough, lists, quotes, read-only task markers, and compiled footnote links                                                                |
| Code fences        | Native syntax colors, selection, line numbers, and an explicit Copy source button                                                                                     |
| Display math       | MathJax SVG; TeX mathematics, not full LaTeX documents                                                                                                                |
| Inline math        | TeX source plus warning; typesetting unavailable                                                                                                                      |
| `mermaid` fences   | Official Mermaid.js 12.3.0 through local headless Chromium                                                                                                            |
| `vega-lite` fences | Static SVG with inline data; no tooltips, parameter bindings, or animation                                                                                            |
| Local images       | PNG, JPEG, GIF, WebP; rendered as separate image blocks, not inline rich-text images                                                                                  |
| Links              | Local Markdown and fragments stay in the reader; HTTP(S)/mail links open only after a click                                                                           |
| Refresh            | Local folder watch, a 250 ms debounce, and a 10-second retry on Linux, after watch failure, before the first successful read, or while local images/links are missing |

Use Source to inspect the full document. Graphic cards have source, copy, fit, and zoom controls. Missing local links remain inactive until a refresh validates their target. The root watch starts before the first read, so a restored document can recover without closing the pane. A failed graphic shows its error and source without hiding other blocks. A failed refresh keeps the previous document. The outer scroll handle survives document refreshes; manual interaction checks are listed separately in the verification guide.

Vega-Lite supports bounded layer, concat, facet, and repeat charts; named inline datasets; safe presentation config; and selected filter, calculate, aggregate, joinaggregate, bin, and timeUnit transforms. It rejects generators, lookups, image/href output, parameters, regex functions, data-access expressions, and string addition. Keep charts small: at most 5,000 inline rows, 16 leaf views, and a 20,000 row-view budget. Unsupported specifications show an error; they are not executed with weaker settings.

Mermaid directives/frontmatter configuration, external resources, and active links are disabled. Styles are converted to concrete SVG attributes before native display. Layout and fonts can differ from a browser. Diagram types that cannot produce a supported sanitized SVG show an error.

Documents are UTF-8, at most 1 MiB. Binary, invalid UTF-8, non-regular, missing, or changed files produce an error rather than a truncated document. Other bounds include 12,000 AST nodes, 40 nesting levels, 600 native blocks, and 40 graphic blocks. Native graphics are limited to 16 million pixels each and a 64 million-pixel document budget. Each renderer has an 8-second work timeout. The helper has a 70-second batch deadline; the host command has a 90-second timeout.

## Local resource policy

- No authored HTML or JavaScript runs. Code fences are never executed.
- Local links/images resolve from the document directory and must stay within the canonical workspace root. Static escaping symlinks are rejected.
- Remote images, authored SVG files, `file:` links, and embedded data URLs are not loaded. Generated SVG is separately sanitized.
- Mermaid's page blocks requests before authored rendering. Vega's loader rejects network and file resources. Math uses a fixed TeX package set.
- The helper uses argument arrays and a per-job request file. Document source is not placed in shell commands or command arguments.
- Files are opened nonblocking and no-follow, checked as regular files, size-bounded, and checked for identity changes. Workspace paths are revalidated before returning content.

The workspace must be owner-controlled while it is read. Canonical-path checks are not an OS filesystem sandbox against a hostile local process that concurrently replaces intermediate directories. Do not use this root policy as isolation for an independently privileged workspace writer; read a stable owner-controlled copy instead.

## Cache and cleanup

Generated files live under `<app-home>/data/markdown-reader/`, not under mod source or document folders. Keys include renderer version, source, theme, fonts, and width. Asset names are content hashes; cached bytes are checked before reuse.

The asset budget is 64 MiB, with at most 512 render metadata entries. Active reader leases protect displayed assets. Leases renew every 10 seconds and expire after 60 seconds if a reader disappears. Stale job files and abandoned temporary assets are collected after two minutes. A full cache of active assets produces an error instead of deleting displayed assets.

Unchanged code editor states are reused across image and width refreshes; changed or removed states are released. Lease release waits for in-flight renewals so a closed reader cannot recreate its old lease. Replacement content does not wait for old-lease cleanup.

One Mermaid browser is used per document batch and closed afterward. Math/Vega run in a bounded worker. New requests cancel obsolete work; late results are discarded. Close sends a cancellation marker for pending work. Normal cleanup is tested, but app crashes and forced termination have only the helper deadlines and lease expiry as recovery paths. Cleanup on app quit is limited by Herdr's 250 ms budget.

To clear the cache manually, close reader panes first, then remove only `data/markdown-reader/` from the selected app home. Never remove source Markdown. To undo Files integration, switch back to the original layout before removing personal clone links. See the integration guide for details.

## Development

From the repository root:

```sh
npm test --workspace herdr-markdown-reader
npm run test:browser --workspace herdr-markdown-reader
npm run check:mod --workspace herdr-markdown-reader
npm run check:types --workspace herdr-markdown-reader
npm run evidence:native --workspace herdr-markdown-reader
```

The browser suite uses real Chromium and checks resource denial, malformed input recovery, cancellation, timeouts, and owned-process exit. Native fixture checks cover empty, loading, failed, loaded, source, refresh-error, and remote states without changing the active profile. The [native evidence script](docs/native-fixture.md) uses an isolated profile and offline core fixture; it does not automate pointer/key input or touch the clipboard.

See [dependency notices](DEPENDENCIES.md) for licenses and the KaTeX security override.
