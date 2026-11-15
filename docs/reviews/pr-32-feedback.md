# PR #32 feedback

## Scope and evidence

Target: [PR #32](https://github.com/narumiruna/herdr-mods/pull/32), `narumiruna/herdr-mods`.

- The checkout's `origin`, current branch, and PR repository match.
- Reviewed head: `b1960bb79bc2491c80c7f49cfe869069dee3674f`.
- Base: `45ddeb90e845c8e0a9bbe5af34087961d53c5d8f` on `main`.
- The goal is to remove `mods/layout-manager/` and update the root README and removal tooling. The user also asked for a root `AGENTS.md` rule that requires workbench and README updates when mods are added or removed.
- All 21 changed files and all 7,337 diff lines were read, including every deleted source and test line. The deleted preview has only a binary-deletion marker in the diff. The unchanged Mod Manager Gallery preview was inspected and still matches the dialog; this fix does not change UI code.
- All API pages were fetched: one commit, 21 files, one submitted review, one inline comment, three conversation comments, and one review thread with one comment. The REST lists have no next page. Both GraphQL connections end with `hasNextPage: false`.
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
- **Outcome:** Already addressed. The explicit rule is under Documentation in root `AGENTS.md`. The root README already removes the retired mod in this PR. No workbench content change is needed for this removal because no direct reference to the removed mod exists. Do not change an installed profile.

## Publication

The target PR was open after the ledger was complete. Publish this change on its current branch. The GitHub R1 reply records the published commit and verified thread resolution. R2 remains missing a completed security review; restoring account capacity is outside repository access. No separate UI or workflow issue was created. Existing native interaction and sharing limits remain open; this review does not declare any mod ready to share.
