# Mod quality plan

## Goal

Improve all four mods against `RUBRIC.md`. Target at least 95/100 per mod, supported by independent subagent review and verifiable evidence. Do not substitute fixture tests for native interaction evidence or declare an incomplete bundle ready.

## Status

The independent implementation-review target is met: GitHub 97, Layout 97, Manager 97, Reader 95. Required physical interaction and daily-workflow acceptance remain blocked on a profile owner or an isolated native input/display test environment. Keep this plan until the mandatory acceptance gate has evidence; implementation ratings do not make a bundle complete for sharing.

## Plan

- [x] Inspect all four mod roots, baseline tests, Herdr 0.1.15, and sharing gates.
- [x] Delegate focused implementation to four subagents; use two different subagents for independent review and one for isolated native previews.
- [x] Add shared source-bundle validation, tests, the missing GitHub workspace, and CI coverage.
- [x] Pass repository CI, all four SDK type checks, 82 native entry/description checks, seven real Chromium tests, and bundle checks. Inspect 17 final native captures and verify owned-process cleanup.
- [x] Correct independent findings and record category scores, deductions, and evidence in `docs/mod-quality-review.md`.
- [x] Retain exact native interaction prerequisites, checks, and restrictions in the review and each mod's recipe.

## Completion Checklist

- [x] Each mod has an independent assessment using the five unchanged weights.
- [x] Local checks pass: 1,501 JavaScript/shared tests, 207 Python tests, seven Chromium tests, all type/native/source-bundle checks, and whitespace validation.
- [x] All four roots include recipes, runtime files, licenses, and inspected actual previews; links and source structure pass validation.
- [x] Scores, remaining deductions, and unverified acceptance are recorded separately.
- [x] Independent implementation ratings reach at least 95 for every mod.
- [ ] Mandatory native interaction and unchanged daily-workflow acceptance have recorded passing results. Blocked: owner/tester action described below and in `docs/mod-quality-review.md` is required.

## Constraints

Do not change the user's live profile, layouts, installation links, shortcuts, or credentials. The later request to open a pull request permits its branch push and PR creation, not merging, changing repository topics, or Community publication. Do not fabricate previews, successful checks, or scores. Keep the five rubric areas and weights unchanged. `RUBRIC.md` provides no detailed point scale, so the review must state its scoring method and deductions.

## External Handoff

Responsible role: profile owner or tester with an isolated native input/display environment. Prerequisites: the checked source/dependencies, Herdr, disposable profiles/layouts, and owner approval for any account access or actual-profile installation. Perform the per-mod acceptance procedures in `docs/mod-quality-review.md` and the recipes. Expected result: actual input, cancellation, recovery, and integration work without changing terminal sessions, unrelated files, shortcuts, or accounts. Native screenshots establish appearance only; pointer, keyboard, clipboard, real watch/reload, and daily-use acceptance remain unverified. All four bundles remain incomplete for sharing until the applicable mandatory checks pass. No further feature work is required for the recorded implementation scores. Publication requires separate approval.
