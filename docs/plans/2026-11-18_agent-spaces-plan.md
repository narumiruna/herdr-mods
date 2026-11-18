# Agent Spaces implementation plan

## Goal

Add the selected Spaces design: overlapping agent icons on the left and a working/total count with one status ring on the right. Preserve the shipped Spaces actions in a separate mod.

## Context

- The installed Herdr App is 0.1.16. Its Spaces source has 552 lines and has no expanded-row agent status.
- `agents()` supplies live agent identities, machine-qualified space IDs, status, and program icons. It triggers native re-renders.
- Preserve selection, menus, drag order, Git details, worktree nesting, machine groups, and the compact rail.
- The existing workspace has repository-wide CRLF-only differences. Do not normalize or discard these files. The initial `git diff --check` fails on these existing line endings.

## Plan

- [x] Add `mods/agent-spaces/` from the inspected installed Spaces source, with local assets and required license notices.
- [x] Add tested activity grouping and bounded overlapping icons. Count `working` agents only; keep idle, blocked, and done agents in the denominator. Use native spinner animation and live host data.
- [x] Update `layouts/workbench.json`, `README.md`, and the npm workspace lock. Add the adjacent rebuild recipe and package check scripts.
- [x] Run model and interaction fixture tests, SDK/native view checks, repository checks, and source-bundle checks. Record exact procedures and results under `.verifications/agent-spaces/<run-id>/`.
- [x] Capture and inspect native UI states in a disposable profile if safe isolation is available. Use an actual inspected capture for `preview.png`, never the design mockup.
- [x] Record all failures and blocked acceptance checks, review intended changes, and report the local evidence path.

## Completion Checklist

- [x] Tests prove space-ID isolation, distinct repeated program icons, agent additions/removals, status transitions, and bounded icon overflow.
- [x] Tests prove existing Space selection, context menu, drag order, machine groups, and compact rail behavior.
- [x] Native checks pass for empty, working, idle, attention, missing-icon, overflow, narrow, and worktree states.
- [x] Native screenshots are inspected, all required bundle assets exist, and unfinished checks remain explicit.
- [x] No live profile, unrelated source, keybinding, or installed mod is changed by verification. Installation was not run.
- [ ] Required repository gates pass or receive an explicit owner exception. Windows baseline formatting, shared-script tests, other workspace tests, and bundle path handling still fail; do not waive them.

Evidence: `.verifications/agent-spaces/20261118T163256Z/report.md`. The mod has 67 passing tests, passing native checks and type checks, 19 inspected native screenshots, and an inspected actual preview. This plan remains open because the required repository gates have no approved exception.

## External Handoff

The profile owner must install or link `agent-spaces` and select the updated layout with Herdr stopped when changing links. This change does not edit the owner's installed profile. The owner must verify real agent state transitions, agent additions/exits, physical selection, menus, dragging, hover tooltips, and normal input in a disposable profile. These acceptance checks remain unverified and block sharing. The retained checklist is in `mods/agent-spaces/RECIPE.md#done-when`. Repository maintainers must rerun required gates on a supported environment or approve the recorded baseline exceptions before this plan can close. The user approved a commit and feature-branch push. A default-branch merge and Community gallery publication are not approved.
