# Merge Markdown Reader into Better Files

## Goal

Make `mods/better-files/` the only installable mod for the file browser and embedded Markdown reader. Move all reader runtime dependencies into this bundle. Use `data/better-files/` for requests, assets, metadata, and leases. Do not retain or migrate the old `data/markdown-reader/` namespace.

## Context

- Better Files already mounts `reader/main.js` with `cx.new`; it keeps Markdown navigation in the same pane.
- Its host adapter still calls `mods/markdown-reader/helper.mjs`. The session and license have sibling-source parity tests.
- Herdr rejects sibling-mod source imports. The merged mod must resolve all runtime files within its own root.
- The working tree has existing repository-wide CRLF changes. Preserve unrelated files and do not change installed links, layouts, keys, or profiles.
- Node.js 26.6.0, npm 11.18.0, dependencies, and Herdr App are available through Windows PowerShell. Existing documentation records Windows-specific reader test failures; record a fresh baseline before migration.

## Architecture

- Keep the Files entry and embedded reader UI/session/host adapter.
- Put the Node helper, document parser, file validation, cache, and renderer workers under `better-files/reader/`.
- Keep tests, fixtures, native evidence tools, and dependency notices within the Better Files mod root.
- Retire the standalone reader Open/dialog/tab entry and the personal Files-clone preparation tool. Do not redirect old reader commands to the Files entry, which does not accept standalone reader props.
- Keep canonical path checks, remote rejection, bounded resource use, Chromium sandboxing, cancellation, stale-result rejection, and lease cleanup unchanged.

## Plan

- [x] Inspect the source boundaries and Windows tool availability; record the merge scope and new data namespace in this plan.
- [x] Record baseline Better Files and Markdown Reader checks before changing their source. Windows: 132 Better Files tests passed; reader had 369 passes, 25 failures, and 3 errors, with lingering process work after its report. Isolated Linux snapshot with Node.js 26.6.0: Better Files 127 passed/5 platform skips; reader 394 passed. Baseline logs are outside the repository in the session temporary directory.
- [x] Move reader backend, fixtures, dependency notices, and backend tests into Better Files. Linux full suite passes; namespace regressions reject old requests/assets and preserve old sentinel data.
- [x] Adapt reader lifecycle tests and native fixture/evidence tools to the embedded reader. Linux lifecycle/process tests pass; Windows Herdr 0.1.15 entry plus 7 Files and 9 reader fixtures pass.
- [x] Consolidate package settings, lockfile, CI, and shared evidence imports. Linux bundle/type checks pass; standalone dependency install resolves inside its own folder and renders three graphics through the installed helper link.
- [x] Remove the retired mod root and update Better Files documentation and repository links. Recipes, root README, CI, and evidence tooling use Better Files; owner-managed retirement and cleanup are retained in docs/verification.md.
- [x] Add unmodified Backspace to the existing Back action. New regressions failed before the fix and pass afterward; 57 Windows keyboard/lifecycle tests, 331 selected Windows regressions, Linux full mod tests, type/bundle/format checks, and all 17 Windows native checks pass. The owner subsequently reported Backspace works; other physical acceptance remains open in verification.md.
- [ ] Complete all repository gates without a waiver. Linux LF snapshot tests, types, bundles, and formatting pass; Windows native, browser, and 331 selected regressions pass. Plain source-checkout diff/format gates still fail on existing CRLF differences; Windows full-suite/platform and shared bundle-checker baseline failures remain. Resolve those separately or obtain an explicit scoped exception; no gate is waived.
- [x] Record verified evidence, remaining failed/unavailable checks, native version, preview limits, and external acceptance restrictions in mods/better-files/docs/verification.md. Independent read-only review found no material merge regression.

## Completion Checklist

- [x] Only Better Files supplies the reader runtime, dependencies, and required bundle assets; bundle checks and standalone installation/rendering resolve without the old mod.
- [x] Request validation, helper output, manifest validation, assets, leases, and fixtures use `data/better-files/`; old-namespace rejection and untouched-old-data regressions pass.
- [x] Same-pane Markdown and link navigation, Back/Escape, non-Markdown previews, remote rejection, and cleanup retain regression coverage. After the Backspace follow-up: Better Files Linux 507 passed and 5 Windows-only skips; Windows selected regression suite 331 passed.
- [ ] Required agent checks pass, or an explicit authorized exception is recorded; unrelated baseline failures remain visible and do not silently waive repository gates.
- [x] Documentation states Herdr App 0.1.15 Windows, the unchanged actual file-list preview, dependency setup, retired entry points, recovery steps, and unresolved owner acceptance.

## Rollback / Recovery

No source document or installed profile is changed. The owner must close reader views and helpers, then stop Herdr. After Herdr stops, restore the Files block to `content.mod: "files"` and remove only the Better Files installation link. To restore the former standalone reader, restore the previous reviewed source revision and its dependencies. Do not reuse new request/lease files with an old helper. The owner may remove old `data/markdown-reader/` only after all old reader views and processes are closed; migration does not delete it.

## External Handoff

The profile owner must stop Herdr before removing a stale `mods/markdown-reader` link or changing any layout that names the retired mod. Existing standalone Open/dialog/tab commands are not retained. Expected result: only Better Files is installed and selected for file browsing; unrelated layout state is unchanged.

The profile owner must verify physical Markdown clicks, Back/Escape, scroll/selection/copy, source/zoom controls, refresh, remote rejection, and normal app use in a disposable profile. Automated fixture checks and captures do not verify these interactions. The mod remains incomplete for sharing until all repository-required bundle, native, preview, and owner checks pass. The owner approved a separate implementation pull request. Community publication and gallery/topic changes are not authorized.

Native capture tools that require macOS cannot prove Windows visual acceptance. Record the available Windows native checks and any unavailable capture check with its platform requirement.
