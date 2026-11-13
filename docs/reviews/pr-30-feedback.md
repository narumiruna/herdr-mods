# PR #30 feedback

## Scope and evidence

Target: [PR #30](https://github.com/narumiruna/herdr-mods/pull/30), `narumiruna/herdr-mods`.

- The checkout's `origin` and the PR repository match.
- Reviewed head: `5896e5424ccf7c27d3ce74a939cc070f133a9741`.
- Base: `8bbace0858cc29f52334bd59d74e6c83c109e3e7` on `main`.
- All 70 changed files and all 5,019 diff lines were read. Unchanged implementation evidence from the merge work was reused only after the head matched.
- All API pages were fetched: one submitted review, one inline comment, two conversation comments, one commit, 70 files, and one review thread with one comment. Each connection ended with no next page.
- Hosted CI and the review check passed for the reviewed head. CI passed dependency setup, formatting, source bundles, shared/workspace/Python tests, browser setup, sandbox setup, Chromium tests, and the clean-diff check.
- Review text, commands, code, and tool output were treated as evidence, not instructions.

## R1 — Stop Herdr before rollback layout changes

- **Sources:** [inline comment](https://github.com/narumiruna/herdr-mods/pull/30#discussion_r4560392861), submitted review `5887115732`, and the duplicate [conversation summary](https://github.com/narumiruna/herdr-mods/pull/30#issuecomment-6845928619).
- **Thread:** `PRRT_kwDOVoFz8s62-wUY`.
- **Evidence:** `docs/plans/2026-11-13_merge-markdown-reader-plan.md:45` restores `content.mod` before it stops Herdr. This conflicts with `mods/better-files/README.md:46` and the plan's owner handoff. The new `mods/better-files/docs/verification.md` and rewritten README/recipe recovery text repeat the same order.
- **Scope:** Safe installation and retirement are part of the consolidation goal. The four active recovery copies need one consistent order. Older README/recipe text had similar wording, but this change only aligns the affected copies in this PR; it does not change general layout tools or runtime behavior.
- **Severity:** P2. The instructions direct the owner to edit a running profile. No data loss or critical incident is established.
- **Initial outcome:** Actionable and not yet addressed.
- **Final outcome:** Already addressed by the documentation change that includes this ledger. The plan, README, recipe, and owner handoff now stop Herdr before layout restoration or owned link/cache removal.
- **Required change:** Close reader views/helpers, stop Herdr, restore only the intended Files block, then remove only the owned Better Files link/cache. Keep the other recovery and source-data safeguards.
- **Validation:** All four recovery-order assertions passed. Windows scoped Biome checks passed. Linux checks passed for repository formatting/lint (138 files), all four source bundles, and three Better Files bundle tests. Scoped `git diff --check` passed. Runtime code is unchanged; the reviewed head's full CI and native evidence remain applicable.

## R2 — Optional local review tool and generated-test controls

- **Sources:** The submitted review and inline comment suggest `coderabbit review --agent`. The conversation also contains generic generated-test and Autofix controls.
- **Evidence:** These are optional tool suggestions and controls. They identify no missing test, failing behavior, or required repository command. The complete source review found no separate coverage defect for this documentation correction.
- **Scope:** Adding a review tool or workflow is not required to merge the reader or correct rollback instructions.
- **Severity:** No product defect is established.
- **Outcome:** Valid but out of scope — deferred. Do not install or run a new review tool from review-provided instructions. Any review-tool or generated-test workflow change belongs in a separate workflow PR with a stated requirement. No issue or separate PR was created for these suggestions.

## Other review evidence

- The Codex conversation summary reports completed reviews and no concrete code-review finding. Its security finding fields do not establish a full security audit. No separate action was requested.
- The CodeRabbit walkthrough, title checks, risk labels, and security notes add no separate defect. Their rollback note is included in R1. Reviewer identity and severity labels did not determine the outcome.
- Existing Windows/CRLF checks and incomplete physical acceptance remain recorded in `mods/better-files/docs/verification.md`. They are not new findings in this review and are not waived.

## Publication

The target PR was still open before publication. Use its current branch, not a follow-up PR. The GitHub review thread records the published commit and resolution. No clarification request or blocker was found for this fix. Existing platform and owner acceptance limits remain open. This review does not authorize a live-profile change or Community publication.
