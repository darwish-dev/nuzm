# Phase 2 delivery report — AI Engine, real integration and production readiness (offline engineering)

Branch `integration/ai-engine`. Tested code revision: **`506a02bd`** (E2E, integration) and **`5cf41f67`** (verify, generated-app spec; the commits between them change only test/lint configuration, one integration spec and regenerated evidence). Final head at report time: `e0670133` (evidence only). `main` was not modified; nothing was pushed.

Status vocabulary per CLAUDE.md §6. Phase 2 is **engineering-accepted offline**. It is **not** production-ready and nothing here is LIVE-VERIFIED (see section 6).

## 1. Exact results on the final revision

| Check | Revision | Command | Result |
|---|---|---|---|
| lint, typecheck, unit (all packages), build, spec:lint, spec:drift, sdk:check, scan:secrets, zatca:guard, compliance:claims-guard, testenv:test | `5cf41f67` | `pnpm verify` | **exit 0** (52/52 + 28/28 tasks) |
| Unit counts | `5cf41f67` | (inside verify) | web 930 (76 files), api 1386 (99), domain 1715 (79), admin 420 (27), worker 60 (6), db 59 (6), adapter-model 247, ui 24, adapter-knowledge-store 26, adapter-data 18, adapter-contracts 19, i18n 9, sdk 9, adapter-runtime 10, adapter-costs 7, telemetry 3, platform 1; allocator suite 26/26 |
| Spec drift | `5cf41f67` | `pnpm spec:drift` | 527 implemented routes, all declared (527) |
| Secret scan | `5cf41f67` | `pnpm scan:secrets` | 3056 files, 10 rules, 0 hits |
| Integration (serial, per package, leased DB) | `506a02bd` | `pnpm -r --no-bail --workspace-concurrency=1 --if-present run test:integration` | api **2818 passed, 2 failed, 2 skipped** (125 files passed, 1 failed, 1 skipped); other packages all passed (102, 32, 92 tests) |
| The 2 integration failures | fixed in `29b2e615`, re-run on `5cf41f67` | `vitest run src/modules/appbuilder/generated-app.int.spec.ts` | **7/7 passed**. Cause: my per-lease database password was not carried into the spec's clean child environment (a defect in the allocator work, not in the product) |
| Browser E2E ar + en, isolated | `506a02bd` | `pnpm test:e2e:isolated` | **112 passed, exit 0**, 44.5 min (includes the four formerly failing agent-screen specs and axe checks) |

Limits of this evidence, stated plainly:
- The full api integration suite was **not** re-run after `29b2e615`; only the affected spec was. The changed files are one spec, eslint globals, an error `cause` and the allocator test, none of which touch product code.
- The first verify attempts on the final head failed for reasons found and fixed during this run: lint on my allocator scripts (`console`/`URL` globals, missing error cause), then one web spec `lib/builder-client.stream.spec.tsx` ("a 404 is final") that timed out once while 76 web files ran together (passed 3/3 alone and in the later full run; **no timeout or assertion was changed**), then my allocator suite when executed inside a leased shell (inherited database variables; fixed in `5cf41f67`). The web spec is load-sensitive (1 s `waitFor`); it should be rewritten without wall-clock waits (follow-up to S05, not a product defect).

## 2. Defects (docs/security/DEFECT-REGISTER.md)

DEFECT-1..17 (Phase 2): fixed and re-tested. Since then: DEFECT-18 (preview `%25` 500→404), 19 (testenv default DB outside a lease), 20/20b (agent screen: fixture lacked `ai.enabled`, duplicate heading), 20c (unknown run wording), 20d (builder gate named the wrong flag), all fixed and covered by the E2E above. DEFECT-21 (language-link label-in-name) and 22 (favicon 404) are fixed on the P3-S04 branch and will land with the Phase 3 reconciliation.

## 3. Infrastructure delivered in this phase

Central test-environment allocator (`scripts/testenv`): atomic unique port leases, per-lease PostgreSQL cluster, scram password and data directory, protected ports (the owner's dev database `:54329`, system Postgres) never leasable, mandatory explicit database URLs with no fallback (vitest `globalSetup` guard, `packages/db` CLI, dev tools, E2E preflight), CI policy, capacity from CPU and memory, safe release, and 26 regression tests proving that port collisions and cross-session or default-database access are rejected. Weighted FIFO scheduler `scripts/heavy-slot.sh`. Non-destructive check of the owner's development database: no damage found; leaked throwaway `nuzm_test_*` databases are listed for the owner to remove (not deleted by me).

## 4. Owner policy switches shipped (all default to previous behaviour)

`deploy.production_publish_roles` (O-1), `deploy.rollback_requires_own_approval` (O-2), `builder.billing_admin_content_access` (O-9, proposed policy gated until the owner approves), `builder.billing_separation` (default off), and the builder flags. O-10 dev-cloud tooling is in place.

## 5. Implemented / simulated / tested / live-verified / blocked

| Area | Implemented | Simulated | Tested (offline) | Live-verified | Blocked / needs owner | Production-ready |
|---|---|---|---|---|---|---|
| Provider adapters, benchmarks | yes | yes | yes | no | D2, D5, D6, D4, D3, D9 | no |
| Sandbox / execution gateway | yes | yes | yes | no | Linux runtime node, D-21, HG-10-02 | no |
| Builder tools and agent loop | yes | n/a | yes | no | flag rollout (D-AG-ROLLOUT) | no |
| Deployment (policy, approvals) | yes | provider side | yes | no | HG-05/06, HOST-TRANSPORT | no |
| QA / security | yes | n/a | yes | no | pen test and legal sign-off | no |
| Test infrastructure | yes | n/a | yes | n/a | none | n/a |

## 6. Not done in Phase 2 (explicit)

No live provider calls, no paid execution, no real infrastructure, no production deployment, no merge or push to `main`. All real-world qualification tracks remain `BLOCKED` on the owner approvals listed in `OWNER-APPROVAL-PACK.md`.

## 7. Handoff

Next: create `integration/phase3` from this revision (not into `main`), reconcile the nine Phase 3 branches and the prepared Hestia hosting join, apply the pending shared contracts, and re-run this regression on the reconciled head.
