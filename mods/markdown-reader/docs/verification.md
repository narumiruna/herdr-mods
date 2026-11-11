# Verification and external handoff

## Verified scope

The implementation uses a native GPUI reader with a local Node helper. It does not embed a browser in Herdr. Only Mermaid generation uses headless Chromium. No source was copied from Morsel's AGPL implementation, and no alternative Mermaid renderer is used.

Native evidence was generated and inspected on Apple Silicon macOS with Herdr App 0.1.15. The installed app bundles gpui-base 0.7.1. A newer crate in the local Cargo cache is not evidence of installed-app capabilities.

| Feature                                         | Evidence                                                                                                  | Boundary                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Prose, Chinese, bold, italic, strikethrough     | Light, dark, and narrow native captures                                                                   | Native typography, not browser CSS                                                    |
| Tables, nested lists, task markers, blockquotes | Prose/narrow native captures and AST fixtures                                                             | Task markers are read-only                                                            |
| Footnotes                                       | Compiled HTML reference, definition, and backlink in filtered native captures; registry/anchor unit tests | Native Markdown alone does not support these footnotes; this helper compiles them     |
| Code                                            | Native editor captures, syntax colors, line numbers, Chinese; state-allocation/copy-handler unit tests    | Clipboard round trips and interactive selection are not automated                     |
| Display mathematics                             | MathJax fraction/radical SVG in native light/dark graphics captures                                       | Full LaTeX documents and inline math are not supported                                |
| Mermaid                                         | Official renderer, Chinese flowchart/arrows in native graphics captures; real Chromium tests              | Host settings are fixed; authored resources and configuration directives are disabled |
| Vega-Lite                                       | Native SVG bar chart; worker tests for bounded compositions, datasets, and transforms                     | Static supported subset, not browser controls/tooltips                                |
| Relative files/images                           | Canonical-path, URL, image-signature/dimension, and containment tests                                     | Local root only; remote documents rejected before reads                               |
| Refresh and cleanup                             | Session, native-view, helper, worker, cache, and real-browser lifecycle tests                             | Active-profile interaction and forced app termination remain unverified               |
| Files integration                               | Generated clone passes native check; pure transform and click-routing tests                               | Installation/activation in the owner's profile is an external step                    |

Native screenshots are generated artifacts outside Git. The reproducible [native fixture guide](native-fixture.md) describes their locations, mode labels, SDK/source hashes, status output, timings, cleanup record, and host SVG/font warnings. Filtered captures are labeled; they do not claim complete-document scrolling or interaction tests.

## Source bundle

The mod root includes its rebuildable `RECIPE.md`, inspected actual `preview.png`, MIT license, and dependency notices. The PNG is a crop of the native graphic-card capture with the private file-path header removed. It is the only bundled image asset; no layout, keys snippet, generated SDK, dependency directory, or browser binary is distributed.

A standalone copy outside the repository installed its own runtime dependencies with scripts disabled, completed explicit browser setup, rendered all three sample SVG types without errors, passed `herdr-app check`, and reported zero npm audit findings. Its Mermaid dependency resolved inside that copy, not into the source checkout. The package retains the KaTeX override for standalone installs. The optional generated Files clone is not a separately distributed companion bundle.

Live-profile and manual interaction acceptance remain open, so Community sharing/publication readiness is not claimed. No repository topic or visibility was changed.

## Commands

Run from the repository root with Node.js 26 and installed Herdr:

```sh
npm ci
npm run setup:browser --workspace herdr-markdown-reader
npm run check:mod
npm run ci
npm run test:browser --workspace herdr-markdown-reader
npm run evidence:native --workspace herdr-markdown-reader
npm audit --omit=dev
git diff --check
```

Native checks create temporary fixture profiles. They do not install mods, change the active layout, write the live shared state, or invoke live file-click handlers. The real Chromium suite checks request denial before authored rendering, sanitization, malformed-input recovery, timeout/restart, cancellation, and process exit. The native evidence script uses a valid offline core protocol fixture instead of the owner's core.

The implementation review corrected these defects and added regression coverage:

- Native editor state was initially allocated during render. It is now prepared in initialization, event, or async-completion callbacks.
- Graphic toolbar elements were initially changed after attachment. Builders are now complete before their single-use parent insertion.
- Wide panes could exceed the renderer's width contract. Reader/helper bounds now agree at 2,048 pixels.
- Non-regular file opens could block before validation. Opens are now nonblocking, no-follow, and checked with file-handle metadata.
- Overlapping refreshes could cancel the newly displayed job during old-lease cleanup. Accepted jobs now leave the pending slot before cleanup awaits.
- Browser close could return before the owned process exit event. Cleanup now awaits exit and uses a bounded owned-process kill fallback.
- SVG dimensions also need an area bound before native rasterization. Each graphic now has a 16 million-pixel limit and each document a 64 million-pixel budget.
- Existing cache assets could be corrupt or symbolic links. Reuse now verifies file type, size, and digest; active leases protect both new assets and cache hits under the cache lock.

## PR #24 review fixes

The [review ledger](review-feedback.md) records every feedback item and its scope decision. The fixes cover one-time entry fragments, empty self-links, unique heading IDs, missing-image recovery, Linux watch gaps, cache removal races, small read buffers, and native evidence startup/output handling.

After these changes, all 369 reader tests and all 7 real Chromium tests passed. Repository native mod/view checks and type checks passed. The revised evidence script completed all 10 isolated modes on Herdr 0.1.15/macOS. Both status samples per mode had no runtime errors. All captures were inspected. Final cleanup reported no owned processes. These captures still do not test live watch events or pointer/keyboard interaction.

## Inline mathematics: unavailable

The native feasibility fixture tested:

- HTML data-URL SVG with explicit dimensions.
- HTML local SVG and `file:` SVG.
- HTML data-URL PNG, inline and standalone.
- Markdown local SVG and data-URL PNG.
- Native `image(path)` SVG/PNG controls alongside them.

On the installed app, rich-text images were absent or changed the surrounding text into separate blocks. Native image controls displayed correctly. Thus decoding SVG alone is not the missing feature. Baseline, wrapping, and copy behavior did not pass the inline-math gate.

The reader keeps inline math as visible, selectable TeX source and displays a warning. It does not substitute detached formula cards and call them inline support. A release that claims complete inline mathematics remains restricted until the upstream capability and native checks below pass.

### Herdr maintainer handoff

Responsible role: Herdr/gpui-kit maintainer.

Prerequisite: a supported installed-app API for inline assets or a JavaScript Markdown-plugin/image-resolver bridge, including size and baseline metrics.

Action: review this capability request and provide an API that can place a formula image within native rich text without breaking wrapping or text selection. The local newer Rust crate's inline-image implementation is a reference only, not an installed API contract. No upstream issue or host code change is created by this PR.

Expected result: inline formula images render at the requested size and baseline; long paragraphs wrap correctly; accessibility and copying have a defined representation. Re-run native fixtures with adjacent formulas, narrow paragraphs, Chinese text, font/theme changes, and selection/copy tests before changing the support claim.

Unverified behavior: all typeset inline-math behavior. Release restriction: do not advertise full inline LaTeX mathematics until those tests pass.

## Profile owner handoff

Responsible role: the owner of the Herdr profile.

Prerequisite: repository dependencies/browser setup, passing checks, and a prepared personal Files/layout clone. Stop Herdr before changing installation links or copying prepared files.

Action: install/link the reader and the prepared personal clone, reopen Herdr, and activate the personal layout as described in [Files integration](files-integration.md). Verify Markdown clicks open the correct local file, another extension retains its preview, and the original layout still works. Check text selection, clipboard contents, scroll preservation, fragment navigation, and source/zoom controls in the live UI.

Expected result: click routing works in that profile without modifying shipped files or changing other layouts. Repository tests and isolated captures do not establish this live-profile result.

Unverified behavior: the owner's active-profile integration and manual interaction checks. Release restriction: do not claim that this PR installed or verified that profile. These external actions are not required to publish the implementation PR.

## Filesystem and platform boundary

Static escaping symlinks, traversal, malformed resources, and changed-file identities are tested. The helper revalidates paths and file identity before releasing content. This is not race-proof OS isolation against a hostile local process that can replace intermediate workspace directories concurrently. Use an owner-controlled stable workspace. No plain static-Markdown path to shell execution, automatic resource loading, or active SVG was found in the source review; this is not a comprehensive security-audit claim.

Ubuntu CI installs an AppArmor rule for the exact pinned Chromium executable because the runner restricts user namespaces for downloaded browsers and does not provide the expected system SUID helper. This rule permits that executable to create its sandbox. It does not use `--no-sandbox`, grant a wildcard path, or disable the global AppArmor/kernel restriction. The rule exists only on the disposable CI runner; the mod does not change the user's system policy.

Native Windows/Linux appearance, forced app crashes, and manual clipboard/selection/scroll behavior are unverified. The Chromium sandbox is not disabled to make a platform pass. An environment that cannot launch sandboxed Chromium must report the failure rather than use weaker browser settings.

## Recovery

Return to the original layout to disable the personal Files click route. Close reader panes before removing its development link or clearing its cache. Remove only the reader's cache directory when clearing generated assets. No source document writes, data migration, package publication, tags, or release workflows are part of this change.
