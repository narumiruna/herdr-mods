# Mod quality review

Review date: 2026-11-12. Checked host: Herdr App 0.1.15 on macOS. The later [PR #26 feedback ledger](reviews/pr-26-feedback.md) records new findings, fixes, validation, and unresolved acceptance limits.

This review records historical scores, checks, and acceptance limits. It does
not describe the current set of mods. The standalone Markdown Reader was merged
into Better Files, and Better Files was later removed.

## Scope and scoring method

The five areas and weights come from [RUBRIC.md](../RUBRIC.md): Practical Value /30, Intuitive UI/UX /25, Workflow Integration /20, Performance /15, and Reliability /10. The rubric has no detailed point scale. Scores below are independent reviewer judgments with explicit deductions, not a new official scale.

Four implementation subagents inspected and improved one mod each. Two different review subagents inspected the resulting sources, tests, changes, and actual images. A further subagent prepared and inspected isolated native captures. The main agent fixed review findings and reran repository checks.

Scores assess the implementation supported by source, regression tests, and observed native appearance. They do not establish daily-use acceptance. Test quantity and feature quantity do not earn points. Missing interaction evidence is not a confirmed code defect, but it remains an acceptance gate. Data loss or serious workflow disruption would block acceptance regardless of score.

## Independent scores

The two independent final reports together rate all four implementations at least 95. Implementation self-scores are not used in this table. Baselines refer to commit `27be6fa` and are reconstructed from inspected sources and differences, not historical native sessions.

| Mod                 | HEAD baseline | Value /30 | UI/UX /25 | Workflow /20 | Performance /15 | Reliability /10 |  Final |
| ------------------- | ------------: | --------: | --------: | -----------: | --------------: | --------------: | -----: |
| GitHub Issues & PRs |            89 |        29 |        24 |           19 |              15 |              10 | **97** |
| Layout Manager      |            87 |        29 |        23 |           20 |              15 |              10 | **97** |
| Mod Manager         |            90 |        30 |        24 |           19 |              14 |              10 | **97** |
| Markdown Reader     |            87 |        28 |        24 |           19 |              14 |              10 | **95** |

### Remaining deductions

- **GitHub:** Value −1 because discussion, diffs, and CI follow-up still require GitHub; UI −1 because advanced qualifier examples are in a tooltip; Workflow −1 because optional tab-bar integration needs two configured copies and exact panel IDs. Evidence: its README integration/limitations sections, `main.js` search tooltip, and `tabs.js` panel discovery.
- **Layout:** Value −1 because cross-axis moves preserve sizing constraints without conversion or resize editing; UI −1 because drop-only side zones resemble lower save-action buttons; UI −1 because Props starts below the placement/reference fold in the inspected viewport. Evidence: `tree.js`, `main.js` side targets/render order, and the actual native captures.
- **Manager:** UI −1 because From GitHub needs the exact case-sensitive directory; Workflow −1 because verified file changes cannot guarantee runtime reload/unload without a separate restart; Performance −1 because check and prepare each clone the source and sibling mods repeat that work. Evidence: `main.js` directory form, `operations.py` clone paths, and the restart handoff.
- **Reader:** Value −2 because inline math remains literal TeX; UI −1 because first open needs two absolute paths; Workflow −1 because natural Files clicks need a version/hash-pinned personal clone; Performance −1 because prose waits for the sequential graphics batch. Evidence: `document.js`, `main.js` Open form, `integration.js`, `helper.mjs`, and actual light/dark/narrow captures.

No remaining confirmed severe runtime defect was found by the independent reviewers. Reliability points are review judgments supported by safeguards and regression evidence, not a guarantee against failures. Physical interaction and daily-workflow acceptance remain unverified regardless of the numeric scores.

## Changes and corrected findings

### GitHub Issues & PRs

- Added the missing private npm workspace, native/type checks, recipe, local license, and bundled fixed icons. Root checks no longer skip this mod.
- Added close cleanup, request invalidation, bounded CLI diagnostics and response validation, and machine-scoped recovery.
- Made applied search and drafts distinct, retained normal modified navigation keys, and guarded tab/panel integration.
- Independent review found authentication instructions available only in hover tooltips. Both full and compact error states now show wrapped machine-specific recovery text. Regression tests and an actual error capture cover the change.

### Layout Manager

- Preserved props drafts by layout and mod across Refresh and stale-save recovery. Added explicit Close discard confirmation and keyboard inventory selection.
- Removed repeated full-tree destination scans from render eligibility; final save/release still revalidates current state.
- Native visual review found shallow schematic siblings vertically centered below a deep container. Row children are now top-aligned; a regression and replacement actual capture verify the correction.
- Independent review found that inspecting another mod could replace an unchanged retained new-view source's saved props with `{}`. The fallback now uses the captured layout's saved props. Keyboard and stored-source regressions cover this case.
- Added one **Undo last change** step for accidental insertion or placement. It uses existing ownership, current-layout, and compare-and-swap guards. It cannot overwrite an external edit, preserves later drafts, has no redo, and is cleared by Refresh, layout change, or close. Thirteen regressions and an enabled-Undo native description cover its limits.

### Mod Manager

- Made backend fallback globally read-only, with a visible reason and retry action. Exposed bounded discovery/recovery warnings.
- Added per-repository check progress and safe stopping between checks. Active file transactions are not canceled.
- Bounded private Git staging and removed per-file size subprocesses without weakening live publication/rollback safeguards. Retained workspaces when a preparation receipt may exist.
- Independent review found no direct selected-mod source-review path. Added a validated GitHub Source action that does not install anything.
- Follow-up review found that an update card initially opened the installed revision instead of its checked candidate. **Update source** now opens the validated update revision and exact recipe directory. Model and rendered-handler tests verify this without mutations.
- Native entry checks now use disposable profiles. Tests compare selected execution fields instead of printing inherited environment objects on assertion failure.

### Markdown Reader

- Added a native first-open form with explicit local file and workspace-root paths, without inferring a broader root or falling back from a remote identity.
- Added first-read and missing-link recovery, session-scoped watches, stale refresh guards, editor reuse, lease-renewal ordering, and partial helper cleanup.
- Removed repeated prior-link counting from token allocation.
- Independent review found an ineffective Source/Render toggle on error cards. Error cards now retain their source editor and Copy source action without that toggle; graphic cards still toggle.
- Native entry checks now use a disposable profile, with failure-cleanup regressions. The new empty-state form has actual native capture evidence.

## Verification evidence

The final repository CI command passed:

```sh
npm run ci
```

| Check                        | Result                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| Biome                        | 122 files checked                                           |
| Source bundle structure      | All four mod roots pass                                     |
| Shared-script tests          | 28 pass                                                     |
| GitHub Issues & PRs          | 98 tests pass                                               |
| Layout Manager               | 597 tests pass                                              |
| Markdown Reader              | 391 tests pass                                              |
| Mod Manager JavaScript       | 387 tests pass                                              |
| Mod Manager Python           | 207 tests pass                                              |
| Installed-SDK type checks    | All four workspaces pass                                    |
| Real Chromium renderer suite | 7 tests pass                                                |
| Production dependency audit  | Zero reported vulnerabilities; not a security certification |
| Whitespace                   | `git diff --check` passes                                   |

The JavaScript/shared total is 1,501. Browser and Python tests are separate. Source-bundle checks inspect required files, recipe links, JSON, imports, workspace scripts, licenses, and bounded PNG structure/inflation. They exclude development artifacts and are not full image decoding, an archive inspection, or an interaction test. Actual images were inspected separately.

### Native appearance

`npm run check:mod` passed all four entry checks and 78 eager native descriptions: GitHub 9, Layout 36, Reader 9, and Manager 24. These 82 checks are not physical interaction tests.

All captures use disposable profiles, public fixture data, an offline core, and real mod rendering. They do not change the owner's profile, installed links, layout, keys, account, or GitHub state. No physical input was automated on the user's display.

- Final three-mod evidence: `/tmp/herdr-previews-cQY7vB/` contains six captures, six native checks, twelve clean status samples, input hashes, final source audit, image inspection, and cleanup records. The selected three previews are exact copies of inspected captures. The earlier `/tmp/herdr-previews-FNo6zN/` run exposed shallow-node vertical alignment beside deep containers. A top-alignment fix, regression, and the final recapture confirm that those source/target nodes are now visible at the top of the schematic.
- Reader evidence: `/tmp/herdr-md-native-XWTg5J/` contains eleven captures, including first-open, light/dark, narrow, raw, loading/error, prose, graphics, and footnotes. Both status samples per mode had no runtime errors. All eleven captures were inspected. Full reader captures include a private source-path header and must remain outside Git; the bundled preview is the previously inspected graphic-card crop.
- Both cleanup records have no remaining owned groups and no cleanup errors.
- Layout emitted duplicate system-font warnings. Its deep schematic is clipped inside a scrollable canvas; the screenshots do not establish physical scrolling or destination access.
- The three-mod fixture denied six background `curl` calls for bundled update-notes media. No GitHub/account/file operation was performed. Command wrappers and the restricted environment are not an OS network sandbox.

| Preview at time of review            | Dimensions |
| ------------------------------------ | ---------- |
| `mods/github-issues-prs/preview.png` | 680 × 760  |
| `mods/layout-manager/preview.png`    | 1200 × 950 |
| `mods/better-files/preview.png`      | 600 × 525  |
| `mods/mod-manager/preview.png`       | 1100 × 850 |

## External acceptance and sharing restrictions

At the time of review, all four mods were **incomplete for sharing** until their
required native interaction checks passed. A numeric implementation score, eager
native description, or screenshot does not close those checks. An implementation
pull request is not Community publication or sharing approval.

The profile owner or a tester with an isolated native input/display environment must use disposable profiles and record the following results:

1. **GitHub Issues & PRs:** keyboard search/clear/type tabs; result/detail/Back/Escape; tab-bar selection, rename, close, reorder, and per-space panel restoration; approved read-only authentication/remote-machine failure paths; unchanged terminal input and shortcuts.
2. **Layout Manager:** real host parsing and divider geometry; physical drag/drop, keyboard placement, deep/hidden/inactive-node access, cancellation, props retention, Close discard, and guarded Undo; live reload without duplicate views or lost terminal sessions. Keep original disposable layout JSON for recovery.
3. **Mod Manager:** native search/focus/scroll and selected Source/browser routing; progress/Stop checks; confirmation cancellation; reviewed disposable-mod install/update/uninstall; read-only retry, recovery warnings, close-during-transaction, and footer coexistence. Preserve recovery receipts and archives.
4. **Better Files:** actual Markdown file clicks, Back/Escape, same-pane links/fragments, text selection, clipboard, scrolling, zoom, real watch/recovery, remote rejection, and unchanged terminal/Files use. The standalone reader Open/Cancel entry is retired. Inline typeset math remains unsupported.

For current prerequisites, expected results, and recovery procedures, see the
README and recipe for each mod still in the repository. This review makes no
compatibility claim for additional platforms. Do not run these checks against
the owner's live mods or account without separate approval. GitHub publication
requires explicit approval even after acceptance.
