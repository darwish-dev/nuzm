# S46 — IDE back end: Git, changes, tests, debugging (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
`git/git.store.ts` (plumbing only), `changes/change.service.ts` (safe diff, atomic, base/hash 409, secrets/canary/traversal/dependency checks, risks), `tests/*` (runner with junit/tsc/build parsers, `builder.build_minutes`, redacted logs), `test-fix.service.ts` + `debug-loop.ts` (5/15/3 limits), migration 1430; SCR-M10-01 submitted.

## Tests (files; results in `M10-report.md` §E)
`git.spec.ts` (5), `parsers.spec.ts` (9), `builder-s46.int.spec.ts` (17).

## Not done / NOT VERIFIED / BLOCKED
No Git HTTP route (SCR-M10-01 not approved). The browser IDE is UI work (see UI status in the M10 report).

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.

## Finish session: changes and test-fix on the real M09
`POST /v1/builder/projects/{id}/changes` (M09's path) is dispatched to the web-app patch pipeline for `webapp` projects (`ProjectDelegates`; 409 `base_mismatch`/stale base, `source: ai` refused with 403 `approval_required`); a `test-fix` run is a registered run kind (bounded loop, model patch through the checked pipeline, ends `fixed`). **PASS** (`m09-real.int.spec.ts`: lockfile added through the changes route, test-fix run fixes a failing scripted suite in one iteration). Git HTTP paths: still no code (SCR-M10-01 not approved).
