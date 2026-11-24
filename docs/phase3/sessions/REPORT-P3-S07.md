# REPORT P3-S07 — Hestia hosting join and real deployment preparation (interim, written at a usage limit)

Labels: SIMULATED / NOT VERIFIED / PASS (a command run and seen). Nothing real was provisioned, deployed, purchased or called.

## A. Join branch `p3-s07-hosting-join` (local, never pushed, `main` untouched)
Commit `d1bfc558` = `main` @ `70b2ba3a` merged into `ce16599d`. Edits to Master-owned shared files (granted exception, join branch only): `spec/db/ownership.yaml` (conflict resolved: main's 1900-1999 ranges kept, `AG-JOIN: 2210-2219` added to `ai` and `deploy`, `PROV`/`AG-S03`/`AG-S04`/`AG-S05`/`S06-DEPLOY` removed, `S06-DEPLOY2` kept), `docs/07-open-decisions-and-blockers.md` (conflict resolved: D-51..D-55 and D-AG-ROLLOUT both kept), migrations renamed 1900/1920/1921/1980 -> 2210/2211/2212/2213 (up+down, headers note the old ordinal), `docs/adr/ADR-067-execution-gateway.md` -> `ADR-069-...` plus 30 referencing files (hosting ADR-067/068 references untouched), `docs/parallel/MIGRATION-REGISTRY.md`, `PHASE-2-PLAN.md`, `OWNER-APPROVAL-PACK.md`, `RUNTIME-QUALIFICATION.md`, `STAGING-DEPLOYMENT-PLAN.md` (ADR wording), `apps/web/lib/api-docs/*.json` (regenerated with `pnpm docs:generate`; `docs:check` was stale after the merge). OpenAPI, SDK schema and `pnpm-lock.yaml` merged without a conflict and needed no edit: `sdk:check` "up to date"; `pnpm install --lockfile-only --offline` changed nothing.
Verified (seen): `spec:lint` clean, `spec:drift` 585/585, fresh DB `db:migrate` applied 1..2213 without collision, `db:test-rls`, classification (3535 columns/279 tables), ROPA, residency hooks OK; `@nuzm/db` unit 59 pass; API `tsc --noEmit` exit 0; unit deploy/lifecycle/hestia 16 files 185 pass; integration: deploy 4 files 48 pass, hosting 10 files 165 pass (run per file; one capacity-fuzz failure seen only in a single combined run under load, passes alone), migration round-trip 9, Execution Gateway QA 79 pass; the real `HestiaHostingAdapter` interface and `FilesService` compile against my structural types (temporary type check, removed).
NOT RUN: web/admin typecheck on the join (a type error in my domain spec stopped turbo; fixed since, not re-run), `docs:check` re-run after regeneration, full `pnpm lint`, E2E ar/en, scan:secrets. No test touched removed hosting agent code (grep found none).
Join-run caveat: another session's `pkill -f "tsc -p tsconfig.json --noEmit"` killed my typechecks twice; I asked that session to scope it.

## B. Feature branch `claude/p3-s07-hosting-5674e8` (commit `dec6e900`), all SIMULATED
Domain: `FileManagerArtifactTransport` (+ sim stand-ins) passes T-01..T-19; switch refuses without a docroot port. Deploy: `FileManagerSiteTree`, `HestiaSiteOps`, `staging-checklist` (+CLI; simulated: rows 1-11 PASS, row 12 NOT VERIFIED; real: BLOCKED exit 3 without HG-05/HG-06, target, node port and real transport), `health-check`, `preview-domain-workflow`, `server-app-target` (refuses), optional health policy on `HostingTargetPublisher`. Tests: domain 41, deploy new specs pass (health 13, preview 9, hestia-ops 5, checklist 13, file-manager-deploy 4, site-tree 7, server-app 8, hosting-target 12). Lint clean on new files.
Not done: re-running the whole deploy suite on the feature branch after commit, merge-check of this branch into the join branch, deploy UI, real HTTPS probe, wiring (see CONTRACT-P3-S07-1).

## G. Gates still needed
HG-05, HG-06, HOST-TRANSPORT decision incl. docroot-command allow-list, B-DOMAIN, hosting exports `FilesService`. H1-H4 stay NOT VERIFIED; H6 holds (real mode refuses, exit 3).

## Verification after the quiet window (2026-11-24, all via `heavy-slot.sh`; no database was used by these checks)
Feature branch `claude/p3-s07-hosting-5674e8`:
- PASS: `packages/domain` `vitest run src/deploy-transport`: 2 files, 41 tests. `apps/api` `vitest run src/modules/deploy/internal`: 13 files, 146 tests.
- PASS: `tsc --noEmit` in `packages/domain` (exit 0) and `apps/api` (exit 0). The first API run FAILED with 5 TS2345 errors in `preview-domain-workflow.ts` (nullable preview domain used as a string); fixed in `575936b2`, then exit 0.
- PASS: eslint on `packages/domain/src/deploy-transport` and `apps/api/src/modules/deploy/internal` (exit 0).
- PASS: `git merge-tree --write-tree p3-s07-hosting-join claude/p3-s07-hosting-5674e8` merges with no conflicts (tree `dbbefe6c`); nothing was committed onto the join.
Join branch `p3-s07-hosting-join` (`d1bfc558`):
- PASS: `turbo run typecheck` for web, admin, ui, i18n, domain: 8 tasks successful (4 cached), exit 0.
- PASS: `pnpm docs:check`: "api docs are up to date (345 operations, 31 tags)".
Not run: full repo `pnpm lint`, E2E, `scan:secrets`, integration specs on the feature branch (none of the feature code touches the database). Everything above is SIMULATED/unit-level; no live node, panel or DNS was contacted.
