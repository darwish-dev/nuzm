# REPORT-06 — Session 06: Preview, Hosting and Deployment

- Session: 06 · Branch `feature/ai-deployment` · Worktree `.claude/worktrees/ai-deployment` · Postgres port 54346 (db names `nuzm_s06_*`) · Migration ids 1980–1999 (none used yet)
- Baseline commit: `9d16e7f3` (cut from `integration/ai-engine`, code baseline `f81872d5`)
- Last updated: 2026-11-24 (checkpoint 1: audit)
- Labelling rule used everywhere: a deployment made through the in-memory publisher is **SIMULATED** (`AI_LOCAL_REFERENCE=true`, URLs on the reserved `.invalid` TLD, nothing reaches a hosting node). It is never reported as VERIFIED for a real node. Real deployment stays BLOCKED (HG-05, HG-06).

## 1. Audit (what exists today, read from code at the baseline)

| Area | Where | State |
|---|---|---|
| Website deploy pipeline: approval (kind `publish`, bound to version+target+environment) → `platform.operations` job → build → stage → smoke (staged) → activate → smoke (live) → auto-rollback | `apps/api/src/modules/deploy/internal/deploy.service.ts` | implemented, 14 integration tests in `deploy.int.spec.ts` (success, approval binding, expiry, viewer, inactive/non-static/cross-org target, staged/live smoke failure, rollback, 50-parallel idempotency, one-in-flight, cross-tenant matrix, 422 without publisher, metering, CMS binding) |
| Publisher port (`SitePublisherPort`): `UnavailableSitePublisher` (prod: 422 `unsupported_capability`), `InMemorySitePublisher` (fault injection) | `deploy/internal/ports.ts` | the only publish path; **no real node-agent artifact command** (EXTERNAL-BLOCKED: HG-05-01/02, HG-06-01) |
| Web-app deploy (health gate, release store, supply-chain gates, approvals, auto-rollback, rollback) | `appbuilder/internal/deploy/*` (**Session 05's files**) dispatched through `WebappDeployDelegate` | implemented; tests in `appbuilder/builder-s47.int.spec.ts`, `appbuilder/m09-real.int.spec.ts` (publish to hosting site via `SitePublisherPort`) |
| Live preview of a web app | `appbuilder/live-preview.controller.ts`, `internal/preview/*` (Session 05) | out of my ownership; I only consume its contract in UI |
| Hosting domains, SSL lifecycle (verify, managed cert, renew at notAfter−30d, CA rate limit backoff, custom cert in vault) | `hosting/*` + `hosting-domains-ssl.int.spec.ts` | implemented and tested (fake CA adapter); real CA/registrar = EXTERNAL-BLOCKED |
| Customer UI | `apps/web/components/AppDeployments.tsx` (web apps), `BuilderDeployments.tsx` (websites), `apps/web/app/**/deployments/page.tsx` | implemented; no SIMULATED label |
| E2E | `e2e/tests/10-app-builder.spec.ts` deploy leg | was skipped (no hosting fixture); now a separate spec, see §8c |

### Gaps found (classification)
| # | Gap | Class | Plan |
|---|---|---|---|
| G1 | E2E deploy/rollback leg skipped: no seeded hosting node/plan/site | MOCKABLE | seed fixture `e2e/tests/fixtures/deploy.ts`, un-skip |
| G2 | UI never says the deployment is simulated | READY | banner + i18n (`dep.*`) |
| G3 | No cancellation of a queued/in-flight website deployment | READY (needs a state in a CHECK: migration + CONTRACT) | migration 1980, `POST /v1/deployments/{id}/cancel` |
| G4 | No per-deployment environment variables | MOCKABLE | migration 1981 (vault refs only), CONTRACT |
| G5 | Cancellation/unauthorized/cross-tenant/status sync API cases for web-app deploys not asserted at HTTP level | READY | new integration test file in `deploy/` |
| G6 | Health history / recovery of a stuck deployment (worker died mid-run) | READY | `recover()` for deployments whose operation is gone/stale |
| G7 | Web-app deploy cancel (service in Session 05's files) | DEPENDENT | request to Session 05 via Master (see §Escalations) |
| G8 | Real publish to a CloudPanel / Alibaba / Huawei / Contabo node | EXTERNAL-BLOCKED | HG-05-01/02, HG-06-01 |

## 2. Completed (code written, committed; test status per §8)
- G2 SIMULATED labelling: `SitePublisherPort.simulated` (in-memory = true), `simulated` field in the website `Deployment` DTO, banner in `AppDeployments.tsx` (reads `simulated` or a `.invalid` URL host) and `BuilderDeployments.tsx`, i18n `dep.simulated.*` (ar + en).
- G1 E2E: the deploy cases are their own spec `e2e/tests/10-deploy-simulated.spec.ts` (no AI build; projects created through the API, hosting node/plan/active site seeded with SQL in `e2e/tests/fixtures/deploy.ts`, AI wallet credited because a release build needs sandbox budget). The deploy leg of `10-app-builder.spec.ts` was removed (that test skipped it because the scripted mock model never finishes a web-app build). All SIMULATED. Result in §8c.
- UI status-sync defect fixed: after a web-app rollback the list re-reads, so the rolled-back row no longer shows a stale "live".
- `SimulatedHealthProbe` (deploy module, unit-tested, 2/2 pass) + CONTRACT-1 (one registration line in `appbuilder.module.ts`, Session 05's file).
- G3 cancellation of website deployments: migration 1980 (`cancelled` terminal state), `POST /v1/deployments/{id}/cancel`, engine checkpoints (before build / stage / switch), `SitePublisherPort.discard`, UI cancel button + `cancelled` label, audit `deploy.deployment.cancelled`. CONTRACT-2.
- G6 recovery: `tick()` now recovers orphans (operation cancelled / flagged with no live lease → `cancelled`; operation ended without finishing the deployment → `failed` `operation_lost`); an expired lease is re-claimed as before (reconcile before retry).
- G5 integration tests written: `apps/api/src/modules/deploy/deploy-s06.int.spec.ts` (status sync + simulated flag + log resume; cancel queued; cancel running at the checkpoint; too late after the switch; 401/403/404; orphan recovery ×2; dead worker re-claim; authorization and tenant matrix). passes (§8).

## 3. Remaining
Nothing READY/MOCKABLE is left. The E2E result is in §8c.

## 4. Blocked
- G4 environment variables: DEPENDENT. A static website publish has no runtime to receive variables; the web-app pipeline (Session 05) only lists names in `nuzm.app.json` (`deploy.env`) and its target port has no environment channel. A store with no consumer would be dead code. Needs: a consumer in the app-builder deploy path (Session 05) or a node-agent environment command (HG-05-01/02).
- G7 web-app deployment cancel: DEPENDENT on Session 05 (`appbuilder/internal/deploy/deployment.service.ts`); the website cancel answers 422 `unsupported_capability` for a web-app deployment.
- G8 real publish to CloudPanel / Alibaba / Huawei / Contabo nodes, real CA/registrar: EXTERNAL-BLOCKED (HG-05, HG-06). Nothing real is deployed.
- Preview lifecycle (live preview, preview sessions, URLs): lives in Session 05's `appbuilder/internal/preview/*` and `live-preview.controller.ts`; not touched.

## 5. Modified files
`apps/api/src/modules/deploy/{deployments.controller.ts,index.ts,internal/deploy.service.ts,internal/ports.ts}`, new `deploy/internal/simulated-health.{ts,spec.ts}`, new `deploy/deploy-s06.int.spec.ts`; `apps/web/components/{AppDeployments,BuilderDeployments}.tsx`; `e2e/tests/10-app-builder.spec.ts` (deploy leg + header), new `e2e/tests/fixtures/deploy.ts`; `packages/i18n/src/messages.ts` (delimited block `>>> Deployment (S06)` at the end of `ar` and `en`; keys `dep.simulated.title`, `dep.simulated.body`, `dep.cancel`, `bld.dep.state.cancelled`); new migration files (§6); this report and the CONTRACT files.

## 6. New migrations
| id | file | what |
|---|---|---|
| 1980 | `packages/db/migrations/deploy/1980__deploy__deployment_cancelled.sql` (+ `.down.sql`) | `deploy.deployments.state` CHECK and finished_at CHECK gain `cancelled`; transition guard treats it as terminal. No new table or column, so no data-class or ownership change. Reversal: dev-only `.down.sql` (production is forward-fix). |

## 7. Contract-change requests
- CONTRACT-1 `simulated health probe wiring` (one line in `appbuilder.module.ts`): PROPOSED.
- CONTRACT-2 `deployment cancel` (OpenAPI route + `Deployment` schema: `cancelled` state and `simulated`; SDK regeneration): PROPOSED. Until applied, `pnpm spec:drift` lists the new route.

## 8. Test commands and ACTUAL results
Own Postgres: `NUZM_PGPORT=54346 pnpm services:start` (Postgres started; redis not installed, not needed), `NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54346/postgres DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54346/nuzm_dev`, run from `apps/api`.
| Command | Result |
|---|---|
| `npx vitest run --config vitest.integration.config.mts src/modules/deploy` (after DEFECT-4 fix) | **2 files, 22 tests passed** (`deploy.int.spec.ts` 12 + `deploy-s06.int.spec.ts` 10) |
| `... src/modules/deploy/deploy.int.spec.ts src/modules/appbuilder/m09-real.int.spec.ts` (before the DEFECT-4 change) | 2 files, 31 tests passed (regression check: the `simulated` field and the port change broke nothing in the web-app deployment tests) |
| `npx vitest run src/modules/deploy/internal/simulated-health.spec.ts` | 2 passed |
| `npx vitest run` in `packages/i18n` | 9 passed |
| `pnpm --filter @nuzm/api typecheck` | 1 error, pre-existing and not mine (`cloud/internal/adapter-registry.ts(69,33) TS2345`); none in deploy files |
| `npx tsc --noEmit` (apps/web), `npx tsc -p e2e/tsconfig.json --noEmit`, `npx eslint` + `prettier` on touched files | clean |
| E2E `10-deploy-simulated` | **PASS on the Master's isolated stack**, 8 passed (ar 4, en 4), see §8c |
| Not run: `pnpm spec:drift` / `sdk:check` (they would flag the cancel route until CONTRACT-2 is applied), `compliance:*` checks (full-DB) |
The `ownership.yaml` migration range for 1980-1999 is committed on integration (`S06-DEPLOY`; the Master removed my duplicate key). Nothing local is left uncommitted.
Note: workspace package `dist` folders did not exist in the fresh worktree; `turbo run build --filter=@nuzm/api^...` restored them from the turbo cache before the typecheck.

### 8b. After the Master's authorization (merge of integration/ai-engine, CONTRACT-2 applied by me)
- Merged `integration/ai-engine` twice (second time resolved one conflict in `spec/db/ownership.yaml`: kept the Master's `S06-DEPLOY` key and my `DEP` key, both `1980-1999`, plus both `extended_by` entries and every other range).
- `spec/openapi/openapi.yaml`: added `/v1/deployments/{id}/cancel`, `cancelled` in the `Deployment.state` enum, `simulated`. I did not touch `packages/sdk` (the Master regenerates).
- `pnpm spec:lint`: exit 0. `pnpm spec:drift`: exit 1, but ONLY three Session 03 routes (`GET/POST /v1/admin/ai/benchmarks`, `GET /v1/admin/ai/benchmarks/runs/{id}`); my cancel route is no longer reported.
- `npx vitest run --config vitest.integration.config.mts src/modules/deploy` on the merged tree: 2 files, **22 passed**.
- `pnpm --filter @nuzm/api typecheck`: 1 error, `cloud/internal/adapter-registry.ts(69,33)` (pre-existing, not mine).
- (at that time) E2E leg not run: load average 24 and CONTRACT-1 not yet on the branch. Superseded by §8c.

### 8c. E2E of the deploy cases (run by the Master on the isolated integration stack; I did not run a browser myself)
Spec: `e2e/tests/10-deploy-simulated.spec.ts` (+ `fixtures/deploy.ts`). Result after the fixes below: **ar 4 passed, en 4 passed (8 passed, 1.2 min)**:
1. web app: SIMULATED deployment succeeds, status syncs without a reload, a second release supersedes the first, rollback restores it (production asks for an approval first; SIMULATED notice and `.invalid` URL shown);
2. web app: a failing build ends FAILED (`build_failed`, log mentions the build) and nothing goes live;
3. website: a queued SIMULATED deployment is cancelled from the console (operation `cancelled`, second cancel 409, nothing live);
4. authorization and tenant isolation: a viewer is refused (403) deploy, rollback and cancel; the same person in their own organization gets 404 for the other organization's deployment, logs and list.
Defects the first runs found, all in my files and fixed: (a) the spec did not credit the AI wallet, so every release build was refused with `budget_required` (the failing-build test then passed for the wrong reason; it now checks the reason); (b) the English "Deploy" button name is ambiguous with the workspace top bar (scoped to the form); (c) fixed site token violated `sites_token_key`; (d) UI defect: after a second release the older row kept showing "Live" because the list was not re-read when a deployment finished (`AppDeployments.tsx`); (e) wrong column name (`state`) in the spec SQL.
Observation for Session 05 (no change made): a release build needs AI credit on the wallet, because the sandbox create checks the AI budget.
**This proves the console + API + pipeline plumbing against the in-memory fake node. It is SIMULATED and NOT evidence about a real hosting node: HG-05/HG-06 are open and nothing real was deployed.**

## 9. Security findings
- **DEFECT-4 (from Session 07, medium) FIXED**: confirming a publish approval (`POST /v1/deployments` with `approvalId`) now requires a signed-in person (`actor.kind === 'session'`); an API key may ask for the approval but its confirmation answers 403 `forbidden`, creates nothing and leaves the approval `pending`. Test: `deploy-s06.int.spec.ts` "DEFECT-4 …" (passes). Session 07's `it.fails` test in `qa-deploy-approval.int.spec.ts` should now turn red and lose `.fails`; their "CONFIRMED TODAY" control must be deleted. Not changed, **owner decision needed**: (a) a `developer` role holds `deploy:write` and can self-confirm a production publish, whereas the M10 engine requires owner/admin for `production_deploy`; (b) rollback reuses the earlier approval and needs no new one (M10 has a separate `production_rollback`).
- No new secret handling. The cancel route needs `deploy:write`; cross-tenant ids answer 404; a cancellation never touches the live site; a viewer cannot cancel (tests written).
- `SimulatedHealthProbe` answers only for the reserved `.invalid` TLD (cannot resolve anywhere) and only when wired under `AI_LOCAL_REFERENCE`; every other URL keeps the real probe's SSRF rules.
- Pre-existing observation (Session 05's code): the web-app health gate resolves the customer-controlled domain from the control plane; its SSRF guard (`HttpHealthProbe`) is in place and unchanged.

## 10. Integration requirements
Module registration unchanged (DeployModule already registered). Any new route needs the Master to apply the OpenAPI patch (see CONTRACT files).

## 11. Delivery completion: ~95 % (all READY/MOCKABLE API/UI items implemented; API tests and the SIMULATED E2E pass) · Readiness: READY for merge · NOT VERIFIED on real infrastructure (HG-05/HG-06 open)

## 12. Next available tasks
None required of me. Optional (not in my ownership): a read-only preview-lifecycle status page.

## 13. Heavy-run requests
- None open. The targeted E2E run was done by the Master (§8c).

## 14. Escalations
Owner decisions (not blocking): developer self-confirmation of a production publish and rollback-without-approval (see §9). Master: CONTRACT-1, CONTRACT-2 (incl. the `ownership.yaml` migration range) are required before this branch can merge and before the E2E leg can pass.
