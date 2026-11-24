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
| E2E | `e2e/tests/10-app-builder.spec.ts` deploy leg | **skipped** (no hosting fixture: `hasSite` false) |

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

## 2. Completed
- Checkpoint 1: audit and this report.

## 3. Remaining
G1–G6 above, in that order.

## 4. Blocked
G7 DEPENDENT on Session 05; G8 EXTERNAL-BLOCKED (no real deployment is allowed).

## 5. Modified files
(none yet beyond this report)

## 6. New migrations
none yet (range 1980–1999)

## 7. Contract-change requests
none yet

## 8. Test commands and ACTUAL results
none run yet. Machine load average was 76–85 at start (limit for heavy work: 12), so nothing was executed.

## 9. Security findings
none so far.

## 10. Integration requirements
Module registration unchanged (DeployModule already registered). Any new route needs the Master to apply the OpenAPI patch (see CONTRACT files).

## 11. Delivery completion: ~10 % · Readiness: not ready (audit only)

## 12. Next available tasks
G1, G2.

## 13. Heavy-run requests
- One targeted E2E run: `10-app-builder` (ar and en) on the isolated stack with `scripts/e2e-stack.sh`. Not yet requested (spec not changed yet).

## 14. Escalations
none.
