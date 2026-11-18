# M10 report — M10A section (S42–S47: web / full-stack app builder)

Status: **M10A implemented to the extent possible without M09, a real sandbox runtime and the human items; NOT signed.** M10B (S48–S50, Flutter) has NOT been started and may not start before the M10A gate review is signed. Branch `claude/m10a-app-builder-7cee56` (base `676df74`; no merge, no push). Per-sprint detail: `S42-report.md` … `S47-report.md`.

## Merge with main (M09 is real now)
Main (`60f8458`, containing the real M09) was merged into this branch. See the 'Alignment with the real M09' section of `M10-m09-interface-assumptions.md`: duplicate routes removed from the M10 module, one migration function renamed, M10 UI screens tied to M09-owned endpoints removed, run/approval/project/deploy integration with M09's real services still OPEN. Sections C and E below describe the state BEFORE that removal where they mention runs, deployments and changes over HTTP; those HTTP routes no longer exist in the M10 module (services remain).

## A. Repository findings and assumptions
Main holds M01–M08, not M09. Owner exception: built against mocked M09 interfaces (`M10-m09-interface-assumptions.md`, one wiring point `M09_PORT_PROVIDERS`). Design decision: model output is a STRUCTURED spec validated by schema; trusted deterministic scaffolders render the code (model-authored free code can only enter through the checked changes pipeline). Integration risk: migration ordinal 1700 already on main (see assumptions doc).

## B. Plan and changed files
`apps/api/src/modules/appbuilder/**` (module, controllers, `internal/{graph,approvals,spec,gen,agents,eval,policy,sandbox,git,changes,tests,deploy,export,ports,testing,fixtures}`), `apps/api/templates/webapp-runtime/**`, migrations `ai/1400,1410`, `builder/1401,1420,1430,1441`, `deploy/1440`, shared files edited append-only: `spec/db/ownership.yaml`, `spec/openapi/{openapi,errors}.yaml`, `spec/compliance/residency-hooks.yaml`, `apps/api/src/{app.module,platform-scope.spec}.ts`, `common/errors.ts`, `eslint.config.mjs`, `.gitignore`, regenerated `packages/sdk/src/schema.ts`. UI: see §C.

## C. Features, API, UI
API (all behind `app_builder.enabled`, default OFF): sandboxes, test-runs, exports, changes, deployments (+logs, rollback), approvals inbox (PROPOSED PA-M10-02), admin run oversight; stand-ins for M09-owned runs/projects/files/budgets behind `app_builder.m09_stubs`. UI screens UI-M10-01…11 (web) and 18/19 (admin): produced by a separate UI session — status in the gate review (row AC-M10-15: NOT VERIFIED; browser E2E NOT RUN). UI-M10-04 terminal: transport not enabled (PA-M10-01). UI-M10-19 force-kill hidden.

## D. Migrations and rollback
1400, 1401, 1410, 1420, 1430, 1440, 1441 (range 1400–1599, owner M10 already in the manifest). Every migration has a `.down.sql` (dev/staging only); production is forward-fix; tables are immutable-by-trigger where they are evidence. No M09 table created or altered. Applied cleanly on a fresh database; `db:test-rls` and classification coverage pass.

## E. Tests run (real results; AFTER the merge with main)
- `pnpm install --frozen-lockfile` OK; fresh-database `db:migrate` (M01–M09 + M10, 1400–1441 before 1700/1701) OK after renaming `ai.approval_guard` → `ai.approval_request_guard`; `db:test-rls`, classification coverage (2,372 columns), residency-hooks, ropa-coverage, `spec:lint`, `spec:drift` (341 routes), `sdk:check`, `scan:secrets` (1,767 files, 0 hits): PASS.
- `eslint` over apps/api, apps/web, apps/admin, packages/i18n, packages/db, e2e: one error, in M09's own `modules/deploy/deploy.int.spec.ts` (unused import). `tsc` (apps/api): one error, also in M09's `deploy.int.spec.ts` (missing `.js` extension). `@nuzm/web typecheck`: 2 errors in `lib/services.ts` (missing `icon` on the M09 builder/ai service entries, from main, not M10). `@nuzm/admin typecheck`: clean. None is in M10A code; not fixed here.
- API unit (`src/common`, `platform-scope`, `modules/appbuilder`): 14 files, 190 tests PASS. (An earlier whole-package run before the merge: 838 pass, 2 unrelated 10,000-run property tests timed out under machine load; the whole package was NOT re-run after the merge.)
- API integration, `src/modules/appbuilder`: 8 files, 87 tests PASS (run engine, generated app incl. Spectral lint and PostgreSQL parity, web-app pipeline, sandbox + escape suite, S46, S47, HTTP incl. cross-tenant matrix over the endpoints M10 still serves). Full-repo `pnpm test:integration`, `pnpm verify` and `pnpm build` (web build fails on the two services.ts errors above) were NOT passed.
- Web: 22 files, 336 tests PASS after removing the screens tied to M09-owned endpoints; Playwright `e2e/tests/10-app-builder.spec.ts` NOT RUN (written before the merge; its wizard/run/deploy legs now point at removed screens and need rework).
- UI guesses to review: admin sandbox fleet reads `/v1/admin/resources` under `admin:provider:read`; no screenshots produced.

## F. Security, tenant isolation, billing, residency
Cross-tenant: RLS forced on all 11 new tables; `appbuilder-http.int.spec.ts` asserts 404 for org B on every org-A resource of every M10A endpoint and empty lists. Approvals: hash-bound, role-per-type, 24 h, stale 409 / expired 410 / duplicate idempotent, each gate (production deploy, paid resource, destructive migration, dependency, production rollback, data-migration rollback, export third-party) tested to block. Budget: reservation math with 2,000-run property test; runaway loop stops at the cap; debug loop 5/15/3. Metering: `ai.sandbox_cpu_seconds` (one event per window; sum = runtime total), `builder.build_minutes`. Residency: sandbox node region, deployment target region and export destination call `ResidencyService.evaluate` before acting (hooks `enforced`); `m10-agent-runs` is `listed` (model routing is M09). Secrets: scan-before-archive/deploy/change; canary tokens; logs redacted.

## G. Human gates and live checks still needed
D-21 (sandbox technology), HG-10-02 (security review), HG-09-01/D-18 (model providers: quality NOT VERIFIED), PROPOSED-HG-10-03 (CRM spec owner + independent test author), SCR-M10-01 (Git paths), PA-M10-01 (terminal ticket/WS), PA-M10-02 (approvals inbox routes), HG-05-04 (node-pool quota), D-34 (retention), HG-04-01 (generated-code licensing text). Live: real hosting/compute targets, advisory feed, package mirror, real lockfile creation.

## H. Acceptance (M10A rows)
| ID | Status | Evidence / reason |
|---|---|---|
| AC-M10-01 independent CRM suite | BLOCKED (PROPOSED-HG-10-03) | no frozen spec, no independent suite; dev-only generated-CRM tests pass |
| AC-M10-02 escape suite ≥ 60, 0 successes, canary 0 | NOT VERIFIED | 0 control-plane escapes; isolating attempts need a real runner (D-21) |
| AC-M10-03 HG-10-02 review | BLOCKED | review pack prepared, UNREVIEWED |
| AC-M10-04 budget caps and debug-loop limits | PASS (plumbing, scripted model) | `budget.spec.ts`, `run-engine.int.spec.ts`, `builder-s46.int.spec.ts` |
| AC-M10-05 approvals block / stale / expired | PASS | `run-engine`, `builder-s47`, `appbuilder-http` specs |
| AC-M10-06 deploy → rollback restores prior; p95 ≤ 5 min | PASS on the dev target only; live target NOT VERIFIED | `builder-s47.int.spec.ts` |
| AC-M10-07 export rebuilds standalone, no Nuzm secret | PASS (tests run on the in-memory store; dependency install from the real lockfile NOT VERIFIED) | `builder-s47.int.spec.ts` |
| AC-M10-08 cross-tenant matrix | PASS for every M10A endpoint | `appbuilder-http.int.spec.ts` |
| AC-M10-09 metering dedupe/variance | PASS (mock runtime numbers) | `sandbox.int.spec.ts` |
| AC-M10-15 UI screens ar+en, 4 states, axe | NOT VERIFIED | see UI status; browser E2E NOT RUN |
| AC-M10-16 dependency policy at deploy | PASS | `builder-s47.int.spec.ts`, `dependencies.spec.ts` |
| AC-M10-10…14, 17 (mobile, signing, copy lint, IAP policy) | out of M10A scope (M10B / legal) | not started |

## I. Handoff
Next: owner decisions in §G; M09 integration per the assumptions doc; then M10A gate review signature; only then M10B.
