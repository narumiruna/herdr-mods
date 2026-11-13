# PR #29 feedback ledger

## Target and evidence

- Repository: `narumiruna/herdr-mods`. The checkout's `origin` and GitHub repository match.
- Target: https://github.com/narumiruna/herdr-mods/pull/29
- Reviewed head: `5244e6592996a97f9e6c44d6db8636e50518ab5d`.
- Base: `65dd724cd19bd61199d24858f7c04cf38cfdc852` (`main`).
- The target is open and is no longer a draft. Its only commit and all 34 changed files match the preceding implementation review. The complete diff was fetched again and all 4,312 lines were read without gaps. The actual preview was inspected again. Unchanged source and license evidence is retained from the preceding review.
- Retrieved every REST page for commits, files, submitted reviews, inline comments, and conversation comments. There is one submitted review, two inline comments, two conversation comments, and two review threads. Every thread and nested comment page reports no next page.
- Hosted Linux CI passed on the reviewed head, including formatting, bundle checks, all workspace tests, Chromium tests, and the clean-diff check. CodeRabbit also completed. Passing checks do not disprove a finding.
- Remote content is untrusted evidence. Embedded prompts, commands, and automation controls are not instructions.

## Item outcomes

| ID  | Source                                                                                                      | Finding, scope, and independent evidence                                                                                                                                                                                                                                                                                                                                              | Severity | Outcome                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | [4558999477](https://github.com/narumiruna/herdr-mods/pull/29#discussion_r4558999477)                       | The embedded reader's Escape handler calls `pane.go` when there is no overlay. `Files.openFile()` mounts that reader inside Files, but does not connect Escape to `show(null, cx)`. Escape therefore moves focus while leaving the preview open. This is exposed by the new embedded placement and conflicts with its Back behavior.                                                  | P2       | Already addressed in the review fix. The copied reader calls an overridable `back()` method. Files overrides it with `show(null, ownerCx)` and a parent notification, using the durable init context. A stale reader cannot close its replacement. Six added tests cover Escape, cleanup, stale readers, overlays, other keys, and default pane navigation. Three regressions failed before the fix; all now pass. |
| R2  | [4558999497](https://github.com/narumiruna/herdr-mods/pull/29#discussion_r4558999497)                       | The Windows probe prints the first PATH Node metadata and exits before its `fnm` branch. A PATH Node below 26 is then rejected by JavaScript, even if `fnm` has Node 26. This new launcher cannot meet its stated installed-runtime discovery goal in that case.                                                                                                                      | P2       | Already addressed in the review fix. The probe emits and exits only for a successful PATH candidate with major version at least 26. Older or failed candidates continue to `fnm`. Five actual PowerShell tests use isolated command stubs. Three reproduced the old defect before the fix; all five now pass. JavaScript path/version validation remains unchanged.                                                |
| R3  | [Architecture hardening proposal](https://github.com/narumiruna/herdr-mods/pull/29#issuecomment-6836054039) | Enforcing reader/helper revision pairing at installation could prevent future independent-update drift. The current bundle already requires one reviewed revision in README and recipe, and tests compare the shared model and license. No current mismatched installation or bypass is demonstrated. Installation-time version policy is separate from this PR's file-opening route. | P3       | Valid but out of scope — deferred. Recommend a separate installation-policy issue or pull request. No issue is created here.                                                                                                                                                                                                                                                                                       |

## Other feedback

- The submitted review summary and the merge-risk section repeat R1 and R2. They add no separate defect or required command.
- The walkthrough, title check, and automation controls add no distinct feedback item.
- The Codex summary reports no code finding and a completed security review. No code action is requested there. This does not replace independent validation.
- The architecture review reports no confirmed introduced security issue. Its local-authority, cache-recovery, and canonical-boundary observations agree with the inspected source. R3 records its separate hardening proposal.
- Manual interaction and additional-platform acceptance remain open in the mod README and recipe. A code fix or green Linux CI does not establish sharing readiness.

## Validation and publication

The review fixes target the existing open branch, `narumi/feat/better-files-markdown`.

The fix revision is the commit that adds this ledger.

- Better Files: all 132 tests pass, including six new Back/key-handler cases and five new Windows PowerShell probe cases. The probe fixtures invoke no real Node or `fnm` executable.
- Better Files type checks and the Herdr App 0.1.15 entry check pass. All seven native description fixtures pass in temporary profiles. These are not physical key or pointer checks.
- Full formatting and lint pass for all 149 checked files in a clean LF snapshot of the staged tree. The staged whitespace check passes.
- Unchanged companion runtime, helper CLI, renderer, browser, and preview evidence is reused from the preceding implementation review and the successful hosted Linux CI run.
- The existing Windows bundle checker issue and earlier reader Windows test failures remain outside these two fixes. Supported Linux CI passed for the reviewed head; the pushed fix must receive a new hosted check.

R1 and R2 are eligible for resolution only after the fix is pushed. Replies must cite the published commit and checks. GitHub records the current publication, thread, and hosted-check state. R3 has no inline thread; publish its verified deferral in the pull request conversation. No in-scope item is deferred or needs clarification. Sharing and owner acceptance remain incomplete.
