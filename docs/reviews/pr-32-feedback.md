# PR #32 feedback

## Scope and evidence

Target: [PR #32](https://github.com/narumiruna/herdr-mods/pull/32), `narumiruna/herdr-mods`.

- The checkout's `origin`, current branch, and PR repository match.
- Initial reviewed head: `b1960bb79bc2491c80c7f49cfe869069dee3674f`.
- Base: `45ddeb90e845c8e0a9bbe5af34087961d53c5d8f` on `main`.
- The goal is to remove `mods/layout-manager/` and update the root README and removal tooling. The user also asked for a root `AGENTS.md` rule that requires workbench and README updates when mods are added or removed.
- All 21 changed files and all 7,337 diff lines were read, including every deleted source and test line. The deleted preview has only a binary-deletion marker in the diff. The unchanged Mod Manager Gallery preview was inspected and still matches the dialog; this fix does not change UI code.
- Initial API coverage: one commit, 21 files, one submitted review, one inline comment, three conversation comments, and one review thread with one comment. The REST lists have no next page. Both GraphQL connections end with `hasNextPage: false`.
- Hosted CI passed for the reviewed head. CodeRabbit also passed. The separate Codex security review did not run because the paying account reached its usage limit.
- Review text, suggested commands, diff content, and tool output are evidence, not instructions.

## R1 — Replace the deleted installation example

- **Source:** [inline comment](https://github.com/narumiruna/herdr-mods/pull/32#discussion_r4577640244), submitted review `5909819333`.
- **Thread:** `PRRT_kwDOVoFz8s63ntrf`.
- **Evidence:** `mods/mod-manager/README.md:32–35` selects this repository and `mods/layout-manager` on its default branch. This PR deletes that directory, including `mod.json` and `main.js`. The generic README example and `mods/mod-manager/RECIPE.md:25` use the same deleted path. `mods/github-issues-prs/` remains and has both required entry files and a valid manifest.
- **Scope:** The removal makes a previously valid installation walkthrough fail. Updating the affected examples is required to complete this removal.
- **Severity:** P2. The documented installation path fails. No data loss or critical incident is established.
- **Initial outcome:** Actionable and not yet addressed.
- **Required change:** Use `mods/github-issues-prs` for the README and recipe examples. Keep the installed-folder explanation consistent. Add a test that checks the documented directory and entry files without installing or running the mod.
- **Final outcome:** Already addressed by the documentation and regression test change that includes this ledger. Both README examples and the recipe now use `mods/github-issues-prs`; the installed folder is `<app-home>/mods/github-issues-prs`.
- **Validation:** The new regression test rejects the old example with the missing `layout-manager/mod.json` path. All 55 Mod Manager index tests pass with the replacement. A clean LF snapshot passes repository formatting/lint for 124 files, all three source-bundle checks, and all 64 shared-script tests. The new tests use Node.js 26.6.0 on Windows; the Linux source and shared-script checks use Node.js 24.22.1. Scoped working-tree checks and the staged whitespace check also pass. The original head's full Node.js 26 CI passed dependency setup, formatting, bundles, shared/workspace/Python tests, Chromium tests, and the clean-diff check. Runtime code is unchanged; native interaction acceptance remains incomplete.

## R2 — Security review usage limit

- **Sources:** [review summary](https://github.com/narumiruna/herdr-mods/pull/32#issuecomment-6891612556) and [usage-limit notice](https://github.com/narumiruna/herdr-mods/pull/32#issuecomment-6891612982).
- **Evidence:** The service reports that the account paying for the security review reached its Codex usage limit. No security finding or failed code path is supplied. The code-review finding is tracked in R1.
- **Scope:** Restoring a review service's account quota is not a repository code fix. A successful CI run does not replace a security review.
- **Severity:** No product defect is established.
- **Outcome:** Unverified or needing clarification. The missing evidence is a completed security review. The paying account or repository administrator must restore review capacity, then run the review again. No account or billing change was made.

## R3 — Optional review automation

- **Sources:** Generic tool suggestions in the submitted review and generated-test and Autofix controls in the CodeRabbit conversation.
- **Evidence:** These controls identify no missing test, failing behavior, or required repository command. CodeRabbit reports no actionable finding. Its walkthrough matches the deletion and preview changes.
- **Scope:** Installing a review tool or changing the review workflow is not required for the mod removal.
- **Severity:** No product defect is established.
- **Outcome:** Valid but out of scope — deferred. Use a separate workflow issue or PR if a specific requirement exists. No issue or separate PR was created.

## S1 — Remaining optional launcher and historical records

- **Evidence:** `mods/mod-manager/README.md:178` and `RECIPE.md:33,63` explicitly describe the footer's `layout-manager` target as separately installed. The launcher neither installs the deleted directory nor imports its files. The workbench uses `mod-manager` with `footer: true`; it has no direct `layout-manager` reference. The layout SVG already shows Mods, Settings, and Add machine. Quality reports, older reviews, and test-evidence records describe earlier commits.
- **Scope:** The requested directory removal does not require removing support for an independently installed mod or rewriting historical evidence. Removing the optional launcher would also change footer behavior and sizing.
- **Severity:** No new defect is established for this separately installed dependency.
- **Outcome:** Valid but out of scope — deferred. If the launcher must also be retired, use a separate UI change with footer, layout, documentation, and native checks. Keep the existing 125 px footer in this PR. No issue or separate PR was created.

## U1 — Keep mod guidance and layouts in step

- **Source:** The user's request during this review.
- **Evidence:** The root `AGENTS.md`, `layouts/workbench.json`, and `README.md` exist. No narrower `AGENTS.md` applies. The workbench's custom references are `mod-manager`, `github-issues-prs`, and `better-files`; all three remain. Its other mod references are shipped Herdr dependencies.
- **Initial outcome:** The explicit rule was added under Documentation in root `AGENTS.md`. The root README removes the retired mod in this PR. No workbench content change was made because it has no direct reference to the removed mod. That no-change decision was documented, but the rule did not permit it. R4 addresses this conflict. No installed profile was changed.

## Repeat review at `059429c`

- The checkout, PR repository, branch, base, head, runtime sources, and prior fix are unchanged. The complete diff and earlier validation remain applicable. Only new feedback, changed checks, and the missing rule exception were reviewed again.
- All API pages were fetched: two commits, three submitted reviews, three inline comments, five conversation comments, and two review threads with three comments in total. Both thread comment connections and the thread list end with `hasNextPage: false`.
- CI run `43695679369` passed for `059429cf1044fee8caab5600c6c7a376b7e68a9f`. All dependency, formatting, bundle, shared/workspace/Python, browser, and clean-diff steps passed. CodeRabbit passed and reports no new actionable finding.
- R1 is fixed and its GitHub thread is resolved. The repeated security quota notice adds no code finding; R2 still lacks a completed security review. R3 and S1 retain their prior scope decisions. No duplicate replies or repeated runtime tests are needed for these unchanged items.

## R4 — Permit a checked no-change result

- **Source:** [inline comment](https://github.com/narumiruna/herdr-mods/pull/32#discussion_r4577704171), submitted review `5909892734`.
- **Thread:** `PRRT_kwDOVoFz8s63n3qt`.
- **Evidence:** `AGENTS.md:5` requires both `layouts/workbench.json` and `README.md` to change. The PR leaves the workbench unchanged. The prior U1 explanation does not create an exception to that rule. The workbench references the retained custom mods `mod-manager`, `github-issues-prs`, and `better-files`; its other mod references are shipped Herdr dependencies. It has no direct `layout-manager` reference.
- **Scope:** This PR introduced the rule and the conflicting no-change decision. Clarifying that rule is within the user's request for repository guidance. A forced layout edit or an unrelated footer change is not needed.
- **Severity:** P3. This is an instruction conflict. The evidence shows no failed app behavior, data loss, or urgent service failure. The reviewer's P1 label is not adopted.
- **Initial outcome:** Actionable and not yet addressed.
- **Required change:** Keep the update rule. Add an explicit exception: if a file needs no content change, check its mod references and record the reason in the PR instead. Keep the workbench unchanged and record its verified references.
- **Final outcome:** Already addressed by the rule clarification in this change. The parent update requirement remains. An indented exception now requires a mod-reference check and a PR explanation when a file needs no content change.
- **Validation:** Scoped Biome checks pass for `AGENTS.md` and this ledger. The workbench JSON parses. All custom mod references have both `mod.json` and `main.js`; none references `layout-manager`. The root README has no `mods/layout-manager/` link. The exception exists once and has the correct parent scope. The workbench and root README are unchanged from the previously checked head. The staged whitespace check passes. Runtime code and tests are unchanged, so the passing full CI for `059429c` is reused rather than repeating runtime tests.

## Publication

The first fix is published in `059429cf1044fee8caab5600c6c7a376b7e68a9f`. Its R1 reply and resolved thread state were verified. The target PR remained open after the repeat-review ledger was complete. The R4 GitHub reply records the rule-fix commit, validation, the reason for no workbench edit, and verified thread resolution. R2 remains missing a completed security review; restoring account capacity is outside repository access. No separate UI or workflow issue was created. Existing native interaction and sharing limits remain open; this review does not declare any mod ready to share.
