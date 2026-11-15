---
name: verify-repo-changes
description: Verify changes in this repository before reporting completion, including UI changes that require inspected screenshots and functional changes that require reproducible steps and results, with traceable local evidence under .verifications/<topic>/.
---

# Verify Repository Changes

Verify the changed behavior and keep enough evidence to identify the tested source and repeat each check.
Do not report a required check as passed without direct evidence.

## Prepare the Run

1. Read `AGENTS.md`, the changed files, the relevant README files, and the applicable package scripts.
   - For mod changes, also follow `.agents/skills/share-herdr-mod/SKILL.md`; this skill does not replace its bundle, preview, native, or publication checks.
2. Define acceptance checks and classify the change.
   - UI changes include appearance, layout, visible content, and user interaction; screenshots are required.
   - Functional changes include behavior, commands, state, data, and error handling; a recorded verification procedure is required.
   - Apply both sets of requirements when a change affects both UI and behavior.
   - For documentation-only changes or configuration changes that do not affect UI, check the affected rules, links, structure, or configuration behavior and record why UI checks do not apply.
3. Choose a descriptive lowercase kebab-case `<topic>` and a unique UTC `<run-id>`, such as `20261113T081500Z`.
   - Put all run evidence in `.verifications/<topic>/<run-id>/`, relative to the repository root.
   - Create a new run directory for each attempt; never overwrite earlier evidence or failed attempts.
4. Create `report.md` with the request, acceptance checks, start time in UTC, and the person or tool that performs the checks.
   - Record the Git commit, branch or detached HEAD, workspace status, relevant changed and untracked paths, and SHA-256 hashes of the tested files.
   - Save reviewed diffs or source snapshots for relevant uncommitted files so that the tested state is not identified by HEAD alone.
   - Record the OS, relevant tool and app versions, test fixtures, and test mode, including mocks or a disposable profile.
   - Use non-sensitive fixtures; do not save credentials or private user data in evidence.
   - Record any omitted or redacted source or output and the resulting limit on reproduction.

## Verify UI Changes

1. Run the changed UI in the intended app and exercise each affected acceptance state.
   - Use an isolated test profile; do not change the user's live installation, layout, or keybindings.
   - Record the launch command, setup, fixture, window or viewport size, theme when relevant, and ordered interaction steps.
   - Include affected loading, empty, error, focus, and responsive states when they apply.
2. Capture PNG screenshots from the running UI and save them in the run directory with names that identify the check and state.
   - Use screenshots from this run and tested source, not old images, generated images, design mockups, or placeholders.
   - If a capture tool writes elsewhere, copy the evidence into the run directory and record its original location and capture command or tool call.
3. Open and inspect every required screenshot.
   - Compare the visible result with the acceptance check and record the expected result, observed result, image path, and pass or fail decision.
   - Check for clipping, overlap, unreadable content, and incorrect state; an image file alone does not prove success.
   - Record interaction results separately; a static screenshot cannot prove that an action works.
4. Keep required gallery assets such as `mods/<name>/preview.png` separate from run evidence.
   - A gallery preview does not replace a current verification screenshot, and this skill does not remove required bundle assets.

If the app or screenshot capability is unavailable, mark UI verification `blocked` and state the action needed to capture and inspect the screenshots.
A DOM assertion, fixture render, or successful build does not replace the required screenshot check in the intended app.

## Verify Functional Changes

1. Select checks from the inspected repository scripts and the acceptance criteria.
   - Test the changed behavior, relevant failure cases, and affected existing behavior.
   - Run applicable automated checks and direct behavior checks; explain any check that does not apply.
   - The root README documents `npm run check:mod`, `npm run ci`, and `git diff --check`; inspect their prerequisites before running them.
   - Use `uv run python` for Python checks.
2. Save the complete verification procedure and output in the run directory.
   - For each command, record the working directory, exact command, non-secret environment settings, start and end times in UTC, exit code, and stdout and stderr.
   - For tool-driven or manual checks, record the exact tool inputs or ordered actions, fixtures, expected result, observed result, and supporting logs or files.
   - Save required output even when an existing script writes it outside the run directory; record the original output location.
   - Preserve the original check's exit code when logging through a pipeline.
3. Assign each check an ID and `pass`, `fail`, or `blocked` status in `report.md`.
   - Link the ID to its procedure, expected and observed results, and evidence files using paths relative to the report.
   - Do not use a bare success statement, command list without results, or screenshot alone as functional evidence.
   - Keep failed and blocked checks visible when recording a later successful run.

## Close the Run

1. Finish `report.md` with these sections so that another person can follow the evidence.
   - **Scope:** request, change classification, acceptance checks, and exclusions with reasons.
   - **Source:** commit, branch, workspace state, tested paths and hashes, and saved diffs or snapshots.
   - **Environment:** operator or tool, versions, fixtures, profile, and UI capture settings when applicable.
   - **Checks:** check IDs, exact procedures or links to them, expected and observed results, status, and evidence links.
   - **Result:** start and end times in UTC, overall status, failures, limits, blockers, and the action needed for each unfinished check.
2. Confirm that every evidence link resolves inside the run directory and record SHA-256 hashes of its screenshots, logs, and saved source evidence in `checksums.sha256`.
   - Recheck the tested source hashes after verification; if a relevant source file changed, create a new run before claiming the new state is verified.
3. Confirm that Git excludes the evidence.
   - The root `.gitignore` must contain `/.verifications/`.
   - Run `git check-ignore -v -- .verifications/<topic>/<run-id>/report.md` with the actual run path and confirm that the root rule matches.
   - Run `git ls-files -- .verifications` and `git diff --cached --name-only -- .verifications`; both must return no paths.
   - Never force-add or commit verification evidence; `.gitignore` does not remove files that Git already tracks.
   - If evidence is tracked or staged, stop and report the paths that must be untracked or unstaged without deleting the local evidence.
4. Run `git diff --check` and review the intended change paths without changing unrelated work.
5. Report the result and the local `report.md` path.
   - Keep verification incomplete if a required check failed, is blocked, or lacks evidence; name the action needed to finish it.
   - Local evidence is ignored by Git and is not part of a commit or pull request; do not imply that other people can access it through Git.
