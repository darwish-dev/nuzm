# REPORT-05 — Session 05, AI Builder Tools and Code Generation

- Session ID: 05 · Branch: `feature/ai-builder-tools` · Worktree: `.claude/worktrees/ai-builder-tools`
- Baseline commit: `9d16e7f3` (docs on top of `f81872d5`) · Current commit: see `git log` (this file is committed with each checkpoint)
- Postgres port 54345 (not started yet) · Migration ids 1960–1979: **none used so far**
- Machine load at start: ~64 (1-min). Targeted tests only.

## Assigned scope (priority order)
1 patch/diff/preview/rollback · 2 requirement analysis + decomposition + planning · 3 mock-driven review/repair loop · 4 context compression + project memory · 5 generation planners per product type · 6 UI.

## Where new code lives (ownership row 05)
Pure domain code: `packages/domain/src/ai/agent-tools/builder/**` (exported as namespace `builderTools` from the agent-tools index so no name collides with the domain root). API services: `apps/api/src/modules/appbuilder/internal/changes/**`, `.../internal/studio/**`. UI: `apps/web/components/Builder*.tsx`.

## Task status
| # | Area | Class | State |
|---|---|---|---|
| 1 | patch/diff/preview/rollback | READY | VERIFIED offline (domain 19 tests + API service 8 tests); endpoints parked behind CONTRACT-1 |
| 2 | requirement analysis + planning | READY | VERIFIED offline (16 tests); 6 of 14 product profiles so far |
| 3 | review/repair loop on MockBuildPort | MOCKABLE | VERIFIED offline against a scripted stand-in BuildPort (20 tests); wiring to the API run engine pending |
| 4 | context compression + project memory | READY | pending |
| 5 | generation planners per product type | READY | pending |
| 6 | UI | READY | pending |

## Existing building blocks found (extended, not replaced)
`ChangeService` (safe-diff apply, versions, git commits, checkpoints) · `ProjectsPort` (versions; `source: 'restore'` exists in the type) · website `ProjectService.restore` · S-AG2 read tools (`agent-tools`) · S-AG3 loop (`studio/agent-loop.ts`, domain `agent-loop`) · no unified-diff generator, no change preview, no web-app rollback existed.

## Modified files / new migrations / contract requests / tests / security / heavy-run requests / escalations
(see sections appended below as work lands)
