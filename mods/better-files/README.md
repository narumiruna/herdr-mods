# Better Files

Browse files and read local Markdown **in the same Files pane**. This mod derives from Herdr App 0.1.15 Files. Click `.md` or `.markdown` files, with any letter case, to open the embedded reader. The Back arrow, Escape, or unmodified Backspace returns to the file list. Other files keep the read-only text preview; folders still expand and collapse.

**Sharing status: incomplete. External acceptance remains open.** Linux automated checks and Windows native checks pass; existing Windows repository/test limits and owner-operated physical acceptance remain. The preserved 600 × 525 `preview.png` is a genuine native Windows file-list fixture with safe sample data. It is not merged-reader or physical interaction proof.

## Share on Herdr Gallery

Copy this prompt into your coding agent. Review the files before you approve
publication.

```text
Source repository: https://github.com/narumiruna/herdr-mods

Read ~/.config/herdr-app/AGENTS.md, then write a RECIPE.md for my better-files mod the
way it describes: a brief another agent could build it from with an empty folder.
Put the mods/better-files/ folder, any keys.json snippet, the recipe and
a screenshot named preview.png in one folder, without a layouts/ folder, push it
to a public GitHub repo and add the topic herdr-mod.
```

## One installable mod

Install only `better-files`. Its `reader/` directory contains the embedded UI, model, host runtime, Node discovery, helper, parser, file/cache handling, and renderers. All runtime imports remain inside this mod root.

- Helper: `<app-home>/mods/better-files/reader/helper.mjs`.
- Requests, assets, render metadata, and leases: `<app-home>/data/better-files/`.
- No companion mod or separate reader pane is required.
- The standalone Markdown Reader Open form, dialog/tab API, Files-clone preparation tool, and old repository mod root are retired.
- There is no migration, fallback read, or automatic deletion of `<app-home>/data/markdown-reader/`. The merged runtime must not access it.

## Requirements and setup

- Herdr App 0.1.15 on Windows passed the merged entry and 16 native fixture checks. Other app versions are unknown.
- Node.js 26 or later and the pinned dependencies in `package.json`.
- Puppeteer's browser, installed explicitly before document rendering. Keep Chromium's sandbox enabled.
- System fonts suitable for the document's labels. Font and SVG appearance can differ by platform.

From the repository root:

```sh
npm ci
npm run setup:browser --workspace herdr-better-files
```

For a standalone copy of this mod root, run inside that folder:

```sh
npm install --omit=dev
npm run setup:browser
```

Setup needs package/browser download access. Document opening does not install software or download a browser. Keep the package's KaTeX override and [dependency notices](DEPENDENCIES.md). No server, database, or Morsel service is required.

If Windows Herdr cannot find `node` on its inherited PATH, the launcher checks persistent Windows PATH and then `fnm` for installed Node.js 26+. A persistent PATH candidate below 26 does not block the `fnm` fallback. The launcher caches the absolute executable for rendering/cancellation; it does not change persistent PATH or install Node.

## Owner installation and retirement

Only the profile owner performs these steps. Source preparation does not change the live profile.

1. Close old reader views and let their helper processes finish. Stop Herdr before changing installed links or layouts.
2. Remove only the stale installed `<app-home>/mods/markdown-reader` link or owned copy. Do not follow a link and delete its target. Remove obsolete reader blocks/references from the owner's layouts.
3. Copy or link this complete mod root to `<app-home>/mods/better-files`. Do not overwrite shipped `<app-home>/mods/files`.
4. In the intended existing Files block, set `content.mod` to `better-files`. Keep its node ID, sizes, props, stack selection, other layout content, and keybindings. Restart Herdr and perform the [owner checks](docs/verification.md#owner-physical-acceptance).

No layout or keybinding file is distributed. No `keys.json` is required. Do not replace a whole profile to install this mod.

The owner may remove stale `<app-home>/data/markdown-reader/` **only after closing old reader views and helper processes**. This is optional owner cleanup, not migration or agent work. Never delete source Markdown.

## Behavior and support

- Rows capture their directory, workspace root, space ID, and machine identity. Later focus changes cannot retarget a click. Use the space folder as root only if it contains the browsed directory; otherwise use that directory. The helper still enforces canonical containment.
- Markdown opens directly through a retained `cx.new` child in the Files body. No Open/setup screen, tab, split, overlay, or layout mutation is used. Invalid context or load failure shows an error, not a local preview fallback.
- Remote Markdown is rejected before local document reads. Remote identity is never replaced with local identity.
- Local Markdown links replace the document in this same reader after the previous session closes. Fragments scroll within the document. HTTP(S)/mailto URLs launch the system handler only after an explicit user click.
- Prose/GFM stays selectable native text. Tasks are read-only. Footnotes use compiled references and backlinks. Code and full-document Source use read-only native editors.
- Display math uses MathJax SVG. **Inline math is unavailable** on the checked app: TeX source and a warning remain visible. This is not full LaTeX support.
- Official Mermaid.js renders through local headless Chromium. Successful blocks reuse one initialized page per batch; failure, timeout, or cancellation discards it. Authored directives/frontmatter, external resources, and active diagram links are disabled. Unsupported sanitized SVG shows an error.
- Vega-Lite is static SVG with bounded inline data, selected transforms, and layer/concat/facet/repeat compositions. No tooltips, parameter controls, animation, remote data, generators, lookup, regex/data-access expressions, or string-expanding addition. Limits are 5,000 rows, 16 leaf views, and 20,000 row-views.
- Local PNG/JPEG/GIF/WebP images display as separate blocks, not inline rich-text images. Failed graphics show errors/source without hiding other blocks. Failed refresh keeps the last good document.

The browser hides `.git`, sorts directories first, watches local folders, and refreshes every 10 seconds. Bounds are 500 entries per folder, 5,000 total, and depth 40. Listing runs `sh` or PowerShell, locally or on the captured machine. Git marks use read-only commands. Other previews use `readTextFile`, reject NUL content, and show at most 400,000 characters after the host read; host limits still apply.

## Security, limits, and lifecycle

No authored HTML, JavaScript, code fence, or document-controlled shell command runs. The helper receives argument arrays and a request file, not document source in shell commands. Mermaid requests are blocked before authored rendering; Vega's loader denies network/file resources. Math uses fixed TeX packages. Remote images, authored SVG, `file:` links, and data URLs are not loaded. Generated SVG is separately sanitized.

Local files/resources must stay within the canonical workspace root, including symlink resolution. Reads check regular-file type, byte limits, UTF-8, and file identity. The workspace must be stable and owner-controlled: canonical checks are not an OS sandbox against a hostile concurrent directory writer.

| Bound              | Limit                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| Markdown           | 1 MiB, UTF-8; no truncation                                               |
| Document structure | 12,000 AST nodes; depth 40; 600 native blocks; 40 graphics                |
| Images/assets      | 4 MiB each; local images at most 8,192 pixels per dimension               |
| Native graphics    | 16 million pixels each; 64 million pixels per document                    |
| Generated SVG      | 2 MiB; at most 16,384 pixels per dimension                                |
| Work               | 8 seconds per renderer; 70-second helper deadline; 90-second host command |
| Cache              | 64 MiB assets; 512 render metadata entries                                |

The reader watches before its first read and debounces refresh by 250 ms. It retries every 10 seconds on Linux, after watch failure, before initial success, or while local images/links are unresolved. Missing links stay inactive until validated. Each build validates a repeated local-link target once; the next build resolves it again. Unchanged editor states, retained block views, and the outer scroll handle survive refreshes. Header-only redraws do not rebuild unchanged block content.

The helper loads renderer dependencies only for a graphic cache miss. Cancellation does not load the Markdown parser or renderers. Asset capacity accounting avoids repeated full file-stat scans while below the cache limit; each new asset still checks filename membership. Missing, stale, or corrupt accounting triggers a validated rebuild. Active leases remain protected during eviction.

Back, Escape, unmodified Backspace, another file, a workspace change, or parent close starts reader cleanup before releasing its retained entity. Local-link replacement waits for old-session cleanup. Obsolete work is cancelled and late results discarded. Workers and the per-batch Mermaid browser are closed. Leases renew every 10 seconds, expire after 60 seconds, and protect displayed assets. Lease release waits for in-flight renewal. Stale jobs/temporary assets are collected after two minutes; an active-full cache errors instead of deleting displayed assets.

Opening documents never writes source Markdown, layout state, shared state, or keybindings. Requests contain absolute private paths; generated data must not be shared. Forced termination can leave temporary files until normal collection/expiry. App-quit cleanup has Herdr's 250 ms budget; it is not a crash-recovery guarantee.

To disable, close readers/helpers and stop Herdr. Then restore only the intended block's `content.mod` to `files`. Remove only the `better-files` link or its generated `data/better-files/` directory. Keep shipped Files, source documents, and unrelated state.

## Validation

From the repository root, after setup:

```sh
npm test --workspace herdr-better-files
npm run test:browser --workspace herdr-better-files
npm run check:types --workspace herdr-better-files
npm run check:mod --workspace herdr-better-files
npm run check:bundles
git diff --check
```

Native scripts use disposable profiles. The entry, seven Files fixtures, and nine embedded reader fixtures passed on Windows App 0.1.15. After the Backspace fix, the Linux merged suite has 507 passes and 5 Windows-only skips; the selected Windows suite has 331 passes. Chromium tests passed on both platforms. Full repository tests, types, formatting, and bundles passed in a disposable Linux LF snapshot. These checks do not establish physical interaction. Existing Windows full-suite and raw-checkout gate failures remain documented. The macOS-only capture script cannot capture Windows.

The Markdown performance follow-up passes current Linux CI with 554 Better Files tests and five platform skips, seven Chromium tests on each platform, and all 17 Windows native checks plus two 600-block stress fixtures. Physical acceptance remains open.

See [verification and owner handoff](docs/verification.md) for exact pre-merge baselines, post-merge results, Markdown performance follow-up evidence, remaining failed/unavailable checks, and physical acceptance. See [native fixture reproduction](docs/native-fixture.md), [RECIPE.md](RECIPE.md), [NOTICE](NOTICE), [Apache license](LICENSE), [MIT reader license](reader/LICENSE), and [icon notices](THIRD-PARTY-NOTICES).
