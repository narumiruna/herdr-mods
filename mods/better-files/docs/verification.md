# Verification and owner handoff

**Sharing status: incomplete. External acceptance remains open.** Historical checks are not results for the merged mod. Required owner physical acceptance remains open even if automated checks pass.

## Merged scope

One installable `better-files` root contains the Files browser and embedded reader. UI/model/host I/O, helper/parser/files/cache, and renderers live under `reader/`. The installed helper is `<app-home>/mods/better-files/reader/helper.mjs`; requests, assets, render metadata, and leases use `<app-home>/data/better-files/`.

The standalone reader Open form, dialog/tab API, Files-clone preparation tool, and old repository mod root are retired. There is no companion synchronization requirement. No migration, fallback access, or automatic deletion of `data/markdown-reader/` is permitted. Source Markdown remains read-only.

The root Apache license/NOTICE and icon notices remain. Reader source retains `reader/LICENSE` (MIT); installed dependencies/browser retain their own licenses. See [DEPENDENCIES.md](../DEPENDENCIES.md).

## Pre-merge baseline

These exact counts describe the implementations **before the merge**, not current merged test success:

| Environment                          | Better Files before merge    | Standalone reader before merge  |
| ------------------------------------ | ---------------------------- | ------------------------------- |
| Windows                              | 132 passed                   | 369 passed, 25 failed, 3 errors |
| Isolated Linux Node.js 26.6 snapshot | 127 passed, 5 platform skips | 394 passed                      |

The Windows reader failures/errors concern symlink privileges, POSIX modes/flags, and process/socket tests. Linux success does not prove Windows behavior. Record post-merge results separately with their environment and remaining failures; do not rename these old counts as merged results.

Earlier standalone macOS captures and Windows helper-bridge tests establish only their old scope. They do not prove the new helper/data paths, merged packaging, or physical interactions. Herdr App 0.1.15 Windows is available. Compatibility with other app versions is unknown.

The preserved `../preview.png` is an inspected, genuine native Windows 600 × 525 safe file-list fixture. It has no private paths. It is not a merged-reader screenshot or proof of file clicks, navigation, clipboard, or scrolling.

## Post-merge validation

Checked on 2026-11-13 with Node.js 26.6.0 and Herdr App 0.1.15 on Windows. Linux checks use a disposable WSL checkout with LF line endings and separate npm dependencies. This avoids changing the source checkout's existing repository-wide CRLF differences. No installed mod, profile, layout, keybinding, or old data directory was changed. A final clean install from the merged lockfile with `npm ci --ignore-scripts --offline`, followed by `npm run ci` and the Chromium suite, also passed in the Linux LF snapshot. The table records that merge run before the Backspace follow-up; updated checks for that change are recorded under Owner acceptance reports.

| Check                                                                                                        | Environment                       | Result                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                   | Linux LF snapshot                 | Passed: 65 shared-script tests; Better Files 499 passed and 5 Windows-only tests skipped; GitHub 122, Layout Manager 597, Mod Manager 387, and Python 207 passed                                                                                                        |
| Selected routing, UI, Node discovery, host I/O, helper CLI, model, renderer, bundle, and native-script tests | Windows                           | 323 passed across 11 files; not a full Windows suite                                                                                                                                                                                                                    |
| `npm run test:browser --workspace herdr-better-files`                                                        | Linux and Windows                 | 7 real Chromium tests passed on each platform; sandbox retained                                                                                                                                                                                                         |
| `npm run check:mod --workspace herdr-better-files`                                                           | Windows                           | Entry, 7 Files fixtures, and 9 embedded reader fixtures passed: 17 native checks                                                                                                                                                                                        |
| `npm run check:types`                                                                                        | Linux LF snapshot                 | All four workspace type checks passed; Better Files also passed on Windows                                                                                                                                                                                              |
| `npm run check`                                                                                              | Linux LF snapshot                 | Repository formatting/lint passed                                                                                                                                                                                                                                       |
| `npm run check:bundles`                                                                                      | Linux LF snapshot                 | All four bundles passed; Better Files has 57 source files                                                                                                                                                                                                               |
| Standalone dependency installation and helper execution                                                      | Isolated Linux folder             | `npm install --omit=dev --ignore-scripts` passed without a parent workspace; direct dependencies resolved inside that folder; helper ran through an installed directory symlink, returned 3 graphics/assets (display math, Mermaid, Vega-Lite), and cancellation passed |
| Namespace regressions                                                                                        | Linux and selected Windows suites | New request/asset paths accepted; old request/asset paths rejected; old cache sentinel left unchanged                                                                                                                                                                   |
| Independent source review                                                                                    | Read-only                         | No material merge regression found; renderer safety logic and budgets retained                                                                                                                                                                                          |
| `git -c core.whitespace=cr-at-eol diff --check`                                                              | Source checkout                   | Passed without changing Git configuration                                                                                                                                                                                                                               |

Remaining failed or unavailable checks are not waived:

1. The raw source checkout's `npm run check` and plain `git diff --check` fail on pre-existing CRLF differences. Use a clean LF checkout for the mandatory repository gates, or resolve line-ending policy in separately authorized work. The passing Linux results above refer only to the LF snapshot.
2. The Windows root bundle checker still classifies Mod Manager's `tests\lifecycle-fixture.js` as runtime because of native path separators. Better Files passes this check; the complete Linux bundle check passes. Fix the shared checker's Windows path handling separately before claiming a clean Windows repository gate.
3. The migrated backend's Windows run has 262 passes and 17 existing failures related to symlink privileges, POSIX modes, and flags. The full Windows suite was not rerun after the known POSIX process-group/socket baseline failures. The full Linux suite passes without weakening or skipping those security/process tests. A full Windows claim still needs test portability work and required symlink privileges.
4. Owner-provided screenshots and partial interaction reports are recorded below. A complete merged capture set and the remaining owner acceptance checks are still unavailable. The existing file-list PNG remains valid for that view, but does not show merged reader graphics. Run the macOS capture tool on its supported platform, or prepare equivalent Windows captures in a disposable matching-app profile and inspect them. See [native-fixture.md](native-fixture.md).
5. Sharing remains incomplete until the required checks and owner acceptance pass. No publication or live-profile installation is claimed.

Documented commands from the repository root, after dependency/browser setup:

```sh
npm test --workspace herdr-better-files
npm run test:browser --workspace herdr-better-files
npm run check:types --workspace herdr-better-files
npm run check:mod --workspace herdr-better-files
npm run check:bundles
git diff --check
```

Dependency setup is root `npm ci` plus `npm run setup:browser --workspace herdr-better-files`, or standalone `npm install --omit=dev` plus `npm run setup:browser`. Node.js >=26 is required. Setup is explicit and is not performed by opening documents. Do not weaken Chromium's sandbox to make a check pass.

## Markdown performance follow-up

Checked on 2026-11-13 with Windows Node.js 26.6.0 and Chromium 157. Measurements use temporary profiles and files. The baseline is the reviewed code; the Mermaid and cancellation comparisons also used paired baseline/current copies. No dependency, browser, live profile, layout, keybinding, or source document was changed for setup.

| Work                                                                           | Before                                                      | After                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 5,000 tiny SVG assets, then 40 new inserts; initial assets total 418,890 bytes | 14,335 ms; 200,820 `lstat` calls                            | 739 ms; 5,160 `lstat` calls with no accounting record; the next 40 inserts took 365 ms and 160 `lstat` calls |
| Six distinct two-node Mermaid flowcharts in one batch                          | Six pages and six bundle injections; warm blocks 736–806 ms | One page and one bundle injection; warm blocks 28–34 ms                                                      |
| Fresh helper cancellation process                                              | 321–326 ms                                                  | 37–40 ms; no parser or renderer imports                                                                      |
| 3,000 links to one local target; 53,999 source bytes                           | 953–987 ms; 6,000 `realpath` and 3,000 `lstat` calls        | 101–156 ms; two `realpath` and one `lstat` call                                                              |
| Forty graphic cache hits, including the helper's final lease                   | 81 writes, 81 renames, 122 removals                         | 41 writes, 41 renames, 82 removals; no renderer calls                                                        |
| Unchanged parent redraw with 600 HTML or code blocks                           | 600 `TextView.html` or `Editor.new` calls per redraw        | Zero block builders on ten redraws and a metadata-only refresh; mock counts, not native FPS                  |

A separate eight-flowchart run used one browser, one page, and one bundle injection. The first block took 1,031 ms; the other blocks took 27–36 ms. Fresh plain-document helpers took 206–259 ms, and a 40-block fully cached Mermaid document took 308–327 ms. These are local measurements, not timing guarantees.

### Automated checks

The final source passed these checks. Linux uses a new disposable LF snapshot and existing separate Linux dependencies with the same normalized lockfile. No old snapshot was used as current-source evidence.

- Root `npm run ci`: passed formatting/lint, all four bundle checks, 65 shared-script tests, Better Files 554 tests with five Windows-only skips, GitHub 122 tests, Layout Manager 597 tests, Mod Manager 387 JavaScript tests and 207 Python tests, and all four workspace type checks.
- Real Chromium suite: seven tests passed on Windows and seven on Linux, with the sandbox retained. Coverage includes page/library reuse, sequential diagram families, HTTP/file denial, theme/configuration reset, failure recovery, cancellation, and timeouts.
- Windows selected regressions: 349 tests passed across 11 files; the Better Files type check passed. This is not a full Windows-suite claim.
- Herdr App 0.1.15 Windows: all 17 native entry/fixture checks passed in temporary profiles. Additional temporary HTML and code fixtures each passed with 600 retained blocks. These checks are not physical input or FPS measurements.
- Independent read-only cache/document review: no actionable findings within the documented immutable-cache model; 155 targeted Linux tests passed.
- Scoped diff review and `git -c core.whitespace=cr-at-eol diff --check`: passed without changing Git configuration. Runtime imports, assets, recipe links, licenses, and the inspected genuine 600 × 525 PNG remain valid. No generated SDK, dependency, private cache, image, or live profile was added to the change.

Existing raw-checkout CRLF and Windows portability limits remain unwaived. The Windows cache suite has 52 passes and six environment failures: one POSIX-mode assertion and five `EPERM` file-symlink setup failures, including the new accounting-symlink test. All 58 cache tests pass on Linux without skipping these security cases. A clean full Windows gate needs the required symlink privileges and portable POSIX/process tests. Physical acceptance and updated merged appearance evidence remain external requirements; sharing is still incomplete.

### Bounds and recovery

- New assets still enumerate, sort, and hash filenames. Capacity accounting removes repeated full file-stat scans; it does not make inserts constant-time. Missing, corrupt, interrupted, or stale accounting forces a validated scan. Eviction still checks current leases and file sizes/ages under the cache lock.
- Cached assets remain immutable in a stable owner-controlled directory. External in-place edits to unrelated files do not reliably change accounting metadata. Every asset reuse still checks type, size, and digest. This is not protection against hostile concurrent filesystem writers.
- Mermaid keeps the trusted initialized page only after success. It clears authored DOM, generated styles, and render configuration. Failure, timeout, cancellation, or cleanup failure discards the owned browser. Request interception, CSP, sandbox, source limits, and SVG limits remain enforced.
- Retained block views are not virtualization. Initial creation remains linear in the block count. Refresh updates changed content; local controls invalidate only the containing top-level block. Navigation and close release block entities before editor cleanup. Physical scrolling, selection, and FPS still require owner checks.
- Local-link validation is shared only within one build. Later builds resolve paths again, including missing targets and changed symlinks. Cache operations protect assets before releasing the lock; document conversion does not repeat those lease writes.
- To roll back, close readers and helpers before restoring the previous source version. No source-data migration is required. The old implementation ignores `asset-accounting.json`; the new implementation rebuilds missing or invalid accounting. Do not clear source documents or active assets to roll back.

### Follow-up owner handoff

Responsible role: profile owner. Prerequisite: the complete updated mod in a disposable matching Herdr App 0.1.15 profile. Recheck the [physical acceptance steps](#owner-physical-acceptance), with emphasis on long-document scrolling, selection/copy, links/fragments, Source/Read, graphic controls, theme/resize, and close during work. Expected result: unchanged interaction, no stale content, and no released-state errors. Native FPS, subjective appearance, and physical interaction remain unverified by automated checks. Keep sharing incomplete until required acceptance and appearance evidence pass. Publication requires separate explicit approval.

## Owner acceptance reports

The owner confirmed that the Back arrow, Escape, scrolling, text selection, Source/Read, graphic zoom, and Copy source work. After the follow-up fix, the owner also reported that Backspace works. The owner also reported that the graphics example check looked correct. These are owner reports, not automated pointer/clipboard tests.

Screenshots supplied in the conversation show native prose, tables, code, display math, Mermaid, Vega-Lite, and footnotes. They do not independently show every diagram/equation/chart in the larger example document. The images were inspected but not added to the bundle; the earlier screenshot contains a private local file path. The exact installed build and use of a disposable profile were not supplied with these reports.

The owner then reported that Backspace did not return from the reader. The handler previously recognized only Escape. Unmodified Backspace now uses the same Back action; Ctrl/Alt/Shift/Cmd+Backspace are not intercepted. The new keyboard regressions reproduced three failures before the fix and passed afterward. Follow-up checks passed: 57 Windows return/lifecycle tests, 331 selected Windows regressions, 507 Linux mod tests with 5 Windows-only skips, Windows/Linux types, Linux repository format/bundle checks, and all 17 Windows native checks. Existing baseline gate failures above remain unchanged. The owner subsequently reported a successful Backspace retest. The exact reload method was not reported; the document Reload button does not reload mod JavaScript. This action returns to the Files list, not document history or a different folder root.

These reports do not close the remaining checks below or establish sharing readiness.

## Owner physical acceptance

Responsible role: profile owner. Use a disposable profile first; only the owner changes the live installation. The agent must not edit the owner's links, layout, keybindings, or data.

1. Close old reader views and helper processes. Stop Herdr before removing the stale installed `mods/markdown-reader` link or owned copy and updating obsolete layout references. Never delete a link target by following the link.
2. Install only this complete `better-files` root; change only the intended Files block's `content.mod`. Keep shipped Files, node IDs, sizes, props, stack selection, and unrelated state. No separate reader block or Open/tab command is needed.
3. Physically click `.md`, uppercase `.MD`/`.MARKDOWN`, and nested paths with spaces/Unicode. The correct local document opens in the same Files body without an Open form, new tab, split, or overlay. Test an unrelated active space root and captured context after focus changes.
4. Use local document links and heading/footnote links. The document stays in this view; fragments scroll once, empty self-links go to the start, and unknown headings report an error. The Back arrow, Escape, and unmodified Backspace return to the file list without an old reader dismissing a replacement.
5. Verify native text/code selection, actual clipboard contents from Copy source, vertical/horizontal scrolling, Source/Read, graphic Source/Render, Fit/zoom, narrow width, and light/dark themes. Inline TeX remains source plus warning, not detached formulas claimed as inline support.
6. Change a disposable source document/resource, use Reload, and test watch refresh, missing-file/resource restoration, and failed refresh retaining the last good content. Confirm scroll/editor behavior during refresh.
7. Test remote Markdown rejection without local fallback, invalid/outside-root paths, malformed graphics, and unsupported resources. Confirm ordinary non-Markdown previews and folder expansion still work. External HTTP(S)/mailto handlers start only after an explicit click.
8. Close or replace a reader during slow work, change workspace, and quit normally. Verify owned helper/browser/worker cleanup and no late update. Source Markdown, unrelated layouts, shared state, keybindings, and normal app behavior must remain unchanged.
9. Record app/Node/platform versions, actions, observed results, failures, and private evidence locations. Do not mark acceptance complete from mocks, native descriptions, or fixed-state captures.

The owner may remove stale `<app-home>/data/markdown-reader/` only after closing old views/helper processes. The merged mod does not read, migrate, or delete it. Never remove source Markdown. To disable the new route, close readers/helpers and stop Herdr. Then restore the intended block to `content.mod: "files"` and remove only the owned Better Files link/cache.

## Retained support and security limits

- Native text/GFM, read-only code, compiled footnotes, display MathJax, official Mermaid.js, and static Vega-Lite are the intended support scope, not browser-identical SVG/CSS/font fidelity. Historical SVG parser/font warnings must not be hidden by a clean runtime status.
- Inline math is unavailable on the checked app. The earlier feasibility checks did not establish inline image baseline, wrapping, selection, or copy. Visible TeX plus a warning remains required; display math is not full LaTeX support.
- Vega-Lite has bounded inline data/compositions and selected transforms, not interactive tooltips, controls, animations, external data, expansive generators, or arbitrary expressions. Unsupported input shows source/errors rather than weaker execution settings.
- Canonical root containment, regular-file/identity checks, bounded reads, sanitized SVG, resource denial, and read-only source behavior remain required. No authored HTML/JavaScript/code fence runs. Authored resources cannot initiate network/file loads through a renderer. Explicit user-click external URLs can start another app or network activity.
- Canonical checks are not OS isolation against hostile concurrent workspace-directory replacement. Use a stable owner-controlled workspace. Do not describe the source review as a comprehensive security audit.
- Normal close/cancel, stale-result rejection, editor reuse/release, and lease renewal/release need merged regression evidence. Forced crashes are not normal cleanup proof. Helper deadlines, two-minute stale-job collection, and 60-second lease expiry are recovery boundaries; Herdr app quit allows only 250 ms for cleanup.

## Inline-asset maintainer handoff

Responsible role: Herdr/gpui-kit maintainer. Required capability: a supported installed-app inline-asset or Markdown-plugin/image-resolver API with explicit size and baseline, wrapping, selection, accessibility, and copy semantics. A newer local crate is not an installed SDK contract.

Before changing the inline-math claim, test adjacent formulas, narrow paragraphs, Chinese text, font/theme changes, baseline/wrapping, selection, and clipboard output in the actual app. No host change or upstream issue is claimed here. Other native platforms, forced crashes, and arbitrary SVG fidelity require their own evidence.

No live profile installation, data cleanup, Community publication, repository topic change, or gallery listing is established by this handoff. Publication needs separate explicit approval and all required sharing checks.
