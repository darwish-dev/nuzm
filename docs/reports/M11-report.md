# M11 report — Automation, marketplace and partner programs (S51–S54)

Status: **IMPLEMENTED for everything that does not need M09, a provider, an artifact store, a PSP, a person or an owner decision; gate review prepared, NOT SIGNED; milestone NOT DONE.** Branch `claude/m11-automation-2a587e` (cut from `main` 676df74; `main` 4f5f754 incl. M09 and the console redesign merged in on 2026-11-18), local only, never pushed, never merged into `main`. Sprint reports: [S51](S51-report.md) · [S52](S52-report.md) · [S53](S53-report.md) · [S54](S54-report.md). Also: [M09 assumptions](M11-m09-interface-assumptions.md) · [spec change requests](M11-spec-change-requests.md) · [delegation threat model](M11-delegation-threat-model.md) · [gate review](M11-gate-review.md) · [evidence index](evidence/M11/README.md) · [UI notes](evidence/M11/ui-notes.md).

## A. Repository findings and assumptions
- **Owner-directed exception (recorded as required):** the M11 prompt says "stop if M09 is missing"; the owner started M09–M12 in parallel and told this session to use the prompt's mocked interfaces. M09 was not on `main` when M11 was cut (676df74); it has since been merged into `main` and into this branch, but the ports below are NOT yet wired to it. Everything touching AI runs, `builder.projects`, deployments, website/app template install and the artifact store is behind **ports with "unavailable" defaults + test fakes** and is **NOT VERIFIED** ([assumptions](M11-m09-interface-assumptions.md)). M09's PROPOSED contract (branch `claude/m09-ai-builder-a33bbe`) was read; differences (event topic names, run kinds, approvals) are listed there, not silently reconciled. No M09-owned table is created or referenced.
- **Owner decisions untouched:** D-24 (reseller issuer model) stays `disabled` — code constant `APPROVED_ISSUER_MODEL = null`, database CHECK accepts only `disabled`, any other request resolves to BLOCKED; D-26/HG-11-01: **no payout path exists** (accrual only); no named third-party connector; no HG/D item was marked granted/decided.
- **Spec change requests SCR-M11-01..08** are written ([document](M11-spec-change-requests.md); rows `PA-M11-04..08` added to docs/04 §2.13; PA-01..03 already there). **None of those endpoints exists.** SCR-M11-01 (revocation) is a **pre-S54 blocker**: S54 was implemented around it (service-level revocation, tested) and `agency.enabled` must stay OFF in shared environments.
- **Conflicts recorded (higher source followed):** `residency_denied` keeps its registry status 403 (prompt: 422); event allow-list = docs/05 §5 names (`ai.run.completed`, `site.deployed`) while M09 plans `ai.run.<state>`/`deployment.<state>`; the prompt's "409 duplicate dedupeKey returns original" is implemented as 200 + original; the table's "402 payment" on purchase is not returned (payment is the buyer's separate M03 call); 12 interpretations are listed in the SCR document.
- **Environment:** this session's Postgres on :54353 (`NUZM_PGPORT`/`DATABASE_ADMIN_URL`/`NUZM_TEST_ADMIN_URL` set explicitly). **Incident:** the first `pnpm db:migrate` ran without `DATABASE_ADMIN_URL`; the CLI defaults to :54329 (the owner's dev DB), connected, found an already-applied higher migration, **aborted before applying anything** (verified: it throws before the first unapplied migration). Nothing was changed there. Browser E2E was never run (ports held by the owner's servers). Redis is not installed here (not needed).

## B. Plan and changed files
| Area | Files |
|---|---|
| Pure core | `packages/domain/src/automation/**` (expression language, workflow DAG validator, SSRF guard + guarded client, signing, retry, limits, cron) |
| Automation | `apps/api/src/modules/automation/**` (workflows, versions, engine, actions, connectors, webhook endpoints, triggers, abuse, jobs, 5 controllers), `apps/worker/src/automation-consumers.ts` |
| Marketplace | `apps/api/src/modules/marketplace/**` (publishers, listings, scans, moderation, purchases, installs, 2 controllers) |
| Programs | `apps/api/src/modules/programs/**` (agencies, acting-as, resellers, price-rule validation, statements, issuer gate, 2 controllers) |
| Migrations | `packages/db/migrations/{automation 1600,1601; marketplace 1602; programs 1603; billing 1604,1606; invoicing 1605}` + `.down.sql` (DEV ONLY) |
| Shared files edited (APPEND-ONLY blocks unless noted) | `spec/openapi/openapi.yaml` (paths block before `components:`, parameter, schemas, tags), `errors.yaml` + `apps/api/src/common/errors.ts` (10 codes at the end), `spec/db/ownership.yaml` (table lists of `automation/marketplace/programs` EDITED to add 4 tables, classification/protection/exceptions blocks), `spec/compliance/residency-hooks.yaml` (tables block; hook `m11-connectors` flipped to enforced + `m11-marketplace` added), `spec/openapi/planned-paths.yaml` (M11 entries removed: now implemented), `docs/04` (PA-M11-04..08), `apps/api/src/app.module.ts` (3 modules), `apps/api/src/platform-scope.spec.ts` (allow-list), `apps/api/src/common/access.ts` (`Delegable`, `ActingContext`, `AccessContext.acting`), **`apps/api/src/modules/access/access.guard.ts` (NOT append-only: the "refuse the header" block became the acting-as branch)**, `apps/api/src/modules/audit/internal/db-audit.sink.ts` (1 line), `packages/platform/src/operations.ts` (`defer`, `finishCancelled`) + `index.ts` (`uuidv7`), `apps/worker/src/main.ts`, `packages/db/src/residency-hooks.spec.ts`, `packages/sdk/src/schema.ts` (**regenerated: regenerate again after merging**) |
| Owner-module PRs | billing: `recipes.publisherAccrual`, `EntitlementService.resolve` marketplace slot, `ResellerPriceRuleService`; invoicing: `issueOrderCharge`, `creditedMinor`, `usageNetForPeriod`, `billing_entities.issuer_model`; commerce: `QuoteService.internal`; tenancy permissions seeded by the M11 migrations |
| Docs | S51–S54 reports, this report, gate review, SCR doc, M09 assumptions, threat model, runbooks `workflow-abuse`, `marketplace-moderation`, `delegation-incident`, `reseller-statements`, `demo-m11` |
| UI | see [ui-notes](evidence/M11/ui-notes.md) |

## C. Implemented features, API and UI screens
- **API (all in docs/04 §2.11, 22 operations + 1 inbound-webhook convention route):** workflows (create/list/get/PATCH/versions/executions), workflow executions, connectors (+authorization), webhook endpoints, marketplace listings/versions/purchases/installations, admin moderation, agencies (profile, clients, delegated access), resellers (profile, sub-organizations, price rules, statements). All default OFF behind `automation.enabled`, `webhooks.enabled`, `marketplace.enabled`, `agency.enabled`, `reseller.enabled`.
- **Engine guarantees (tested):** versions immutable; dedupe key = one execution; at-least-once with exactly-once effect for idempotent steps; non-idempotent steps never auto-retried; durable delay/retry; DLQ + idempotent replay; revoked connector stops a running execution at the next step; secrets redacted before persistence; SSRF/egress guard; webhook HMAC with timestamp window, rotation overlap and a 24 h retry window.
- **UI:** see UI notes (built by a separate pass; reviewed by typecheck/lint/unit tests only; Playwright specs written, **NOT RUN**; admin screens UI-M11-20/21/22 and UI-M11-14 are BLOCKED states by SCR).

## D. Migrations and rollback
| Migration | Content | Rollback |
|---|---|---|
| 1600 | `automation.workflows/workflow_versions/executions/execution_steps/dead_letters/anomaly_cases`, `enqueue_execution()`, permissions | `.down.sql` DEV ONLY; production forward-fix (customer data/evidence is never dropped) |
| 1601 | `connectors/connector_authorizations/webhook_endpoints/webhook_deliveries` (append-only) | same |
| 1602 | `marketplace.*` (9 tables + view `v_entitlements`) | same |
| 1603 | `programs.*` (6 tables), guard triggers, permissions | same |
| 1604 | `billing.reseller_price_rules` (append-only) | same |
| 1605 | `invoicing.billing_entities.issuer_model` (CHECK = `disabled`) | same; widening the CHECK is a deliberate later migration after D-24 |
| 1606 | quota group `automation` → meter `automation.executions` (no limit) | `DELETE` row |
All tables have RLS (org isolation + admin-scope read), `data_region` where region-bearing, immutability triggers where stated, and every column is classified (2200 columns / 178 tables).

## E. Tests run with actual results
Environment: Postgres 16 on :54353, throwaway database per integration file; Node 22. Commands and results from THIS session:
- `pnpm --filter @nuzm/domain test`: **217 passed** (46 are the new automation core: expression, workflow schema, SSRF incl. a 60-payload corpus, signing, retry, limits, cron).
- `apps/api` unit (`vitest run`): **721 passed** (38 files; includes the errors registry sync and the platform-scope guard).
- Integration, M11 (`vitest run --config vitest.integration.config.mts src/modules/{automation,marketplace,programs}`): see the evidence index for the final run; per file: `automation.int` 11, `automation-faults.int` 16 (210 fault runs, 31 connector fixtures), `automation-triggers.int` 15, `marketplace.int` 20, `programs.int` 19, `delegation-audit.int` 1; worker `automation-consumers.int` 4.
- Full integration (`pnpm -r --no-bail run test:integration`): db 43 passed, platform 32 passed, worker 12 passed, api: see evidence index.
- `pnpm spec:lint` clean · `pnpm spec:drift` OK (319 routes) · `pnpm sdk:generate` + `pnpm sdk:check` up to date · `pnpm db:test-rls` OK · `pnpm compliance:classification-coverage` OK (2200 columns / 178 tables) · `pnpm compliance:residency-hooks` OK · `pnpm compliance:ropa-coverage` OK · `pnpm compliance:claims-guard` OK · `pnpm scan:secrets` OK (0 hits) · `pnpm zatca:guard` OK · ESLint clean on all M11 files · Prettier applied to all M11 files · `pnpm --filter @nuzm/{api,worker,db,platform,domain} build` OK.
- **NOT RUN:** `pnpm test:e2e`, `pnpm verify:full`, Playwright specs, axe, screenshots, load tests (1,000 concurrent executions / 100 per s / webhook 500 per s), anything against a real provider, receiver, PSP, OAuth server, artifact store or M09.

## F. Security, tenant isolation, billing, residency verification
- **Tenant isolation:** every automation/marketplace/programs route refuses another organization's id with 404/403 (tested per family); RLS on every table, with two-sided policies on links/grants whose transitions are enforced by triggers; the agency boundary matrix + route sweep + random-tuple test ([threat model](M11-delegation-threat-model.md)).
- **Secrets:** vault references only; a tenant can only reference secrets under `tenant-<orgId>-…` (no confused-deputy over platform secrets); execution/step I/O redacted before storage (token never in stored rows — asserted).
- **Billing:** purchase = order + invoice (4400) through M03; accrual Dr 4400/Cr 2600 through the posting service; refund reverses once; every ledger transaction balances; metering only via the outbox; reseller price rules append-versioned; statements reconcile to the ledger (variance 0 on fixtures).
- **Residency:** enforced hooks `m11-connectors` (declared target region per HTTP step/connector) and `m11-marketplace` (purchase/install); fail closed. The declared region is the tenant's statement, **NOT VERIFIED** against where a host really runs; listings carry the unverified `sa-pending` region until a verified artifact region is configured (then purchases/installs are denied by design).

## G. Human gates and live checks still needed
| Gate | Needed for |
|---|---|
| **SCR-M11-01 approval** (and wiring) | revoke routes → AC-M11-06, enabling `agency.enabled` anywhere shared |
| SCR-M11-02..08 | webhook delivery log/replay, listing detail, connector disable, admin reads/verification, purchases list, consolidated billing, sub-org creation |
| D-24 + HG-03-04 | any reseller issuer model (AC-M11-10); tax treatment of reseller/credit-note/marketplace invoices (scenario pack prepared) |
| D-26 / HG-11-01 | publisher agreement, revenue share (the 70 % is a placeholder), payout route (none built); marketplace terms (AC-M11-11) |
| HG-04-01 | counsel: marketplace content liability, PDPL role for workflows processing personal data, agency/reseller data-sharing notices |
| D-33 | billing legal entities (placeholders) |
| D-34 | retention of execution inputs/outputs and webhook payloads; **DSR export/erase of automation data NOT IMPLEMENTED** |
| Publisher verification procedure | human/ops step (service-level only) |
| M09/M10 wiring | AI-run, deployment and website/app-template install (ports) |
| Network egress proxy | production egress control beyond the in-process guard |
| PROPOSED-HG-11-02 | only if named third-party connectors are ever added |

## H. Acceptance checklist
| ID | Status | Evidence |
|---|---|---|
| AC-M11-01 | **PASS** (fault-injected; effect ports are fakes that dedupe on key like a compliant receiver) | `automation-faults.int.spec.ts`: 210 seeded runs (≥ 100 simulated kills, retries, 503s), 0 duplicate effects, metering exact |
| AC-M11-02 | **PASS** | 31 fixtures, 0 reached a target |
| AC-M11-03 | **PASS** (guard + fakes; real network/proxy NOT VERIFIED) | domain corpus 60 payloads, API 43×2, runtime 9; 0 transport hits |
| AC-M11-04 | **PASS** (artifact store/installer are fakes) | 62 attempts, 0 successes |
| AC-M11-05 | **PASS** | concurrent duplicate purchases/callbacks → 1 of each |
| AC-M11-06 | **BLOCKED (SCR-M11-01)** — matrix evidence exists and passes for the implemented scope; the revoke path has no route | `programs.int.spec.ts`, [threat model](M11-delegation-threat-model.md) |
| AC-M11-07 | **PASS** | accrual transaction balances, = floor(net × share); ledger imbalance 0 |
| AC-M11-08 | **PASS** | schema/config/code/OpenAPI search test |
| AC-M11-09 | **PASS** on fixtures (variance 0; below-cost rejected) | `programs.int.spec.ts` |
| AC-M11-10 | **BLOCKED (D-24, HG-03-04)** | posture tests only (disabled/BLOCKED; scenario pack prepared) |
| AC-M11-11 | **BLOCKED (HG-11-01, HG-04-01)** | no legal terms exist |
| AC-M11-12 | **PASS** | signature/replay/rotation/retry/DLQ tests |
| AC-M11-13 | **NOT VERIFIED** | screens per ui-notes; Playwright/axe/screenshots NOT RUN; UI-M11-14/20/21/22 BLOCKED by SCR |
| AC-M11-14 | **PASS** | chaos runs assert usage events == execution count and == succeeded billable step rows (variance 0) |

Compliance checklist (M11 §15): `data_region` on region-bearing tables + residency hooks enforced ✔ · cross-border `transfer_assessment` reference stored on connectors, **not auto-created** · consent hook for marketing: **N/A today** (M08 blocks marketing email) · execution I/O retention + DSR erasure **NOT DONE** · audit events queryable by actor org and acting org ✔ (`acting_org_id` column + client's own audit log) · marketplace takedown process documented (runbook; human-owned) ✔ · agency/reseller data-sharing notices for counsel **NOT drafted** (only the threat model).

## I. Next-milestone handoff and open decisions
- **M12:** delegated-access, marketplace and workflow surfaces enter pen-test scope (threat model attached); reseller/marketplace statements enter billing-close reconciliation (RC-05/RC-06); the `automation.steps` meter counts succeeded billable attempts only (confirm); the in-memory rate limiters need a shared store for multi-instance.
- **M09/M10 sessions:** implement the four ports (assumptions doc); publish event topic names so the allow-list can be extended; mark delegable routes with `@Delegable()` if agencies should manage sites/domains.
- **Open decisions for the owner:** SCR-M11-01..08; D-24; D-26/HG-11-01 (publisher share rate placeholder 70 %); D-33; D-34 retention of automation data; whether a reseller may create sub-organizations and who owns them; the delegable-scope catalogue; marketplace principal-vs-agent invoicing; whether `automation.steps` should bill failed attempts.
