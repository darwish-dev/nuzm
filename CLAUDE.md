# CLAUDE.md — Nuzm All-in-One Hybrid Cloud & AI Platform

Shared rules for every agent session in this repository. Milestone prompts in `docs/milestones/` add milestone-specific work; they never override this file. Read this file, then the one milestone prompt you were given.

## 1. Project state
- Status: M01 and M02 signed by the owner with deferrals ([M01-deferrals](docs/reports/M01-deferrals.md), [M02-deferrals](docs/reports/M02-deferrals.md)). Documentation approval recorded in `docs/reports/HG-00-01-approval.md` (2026-11-15). Decisions made: D-01 local-only git (no remote yet), D-02 one team sequential, D-30 SLO proposals accepted, D-32 Arabic default. PA-01..16, provider selections and legal/tax reviews remain pending. If that file is ever missing, do not write product code.
- Stack (proposed → binding once ADR accepted): pnpm + Turborepo monorepo; NestJS (`apps/api`, `apps/worker`); Next.js (`apps/web`, `apps/admin`); PostgreSQL (schema-per-module + RLS); Redis/BullMQ; OpenAPI contract-first.
- Commands (verified 2026-11-17; see `docs/reports/S01-preflight-report.md`, `S02-report.md`): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` = `pnpm test:unit` (DB-free unit tests only, never browsers; turbo concurrency 2, override with `TEST_CONCURRENCY=n`), `pnpm build`, `pnpm spec:lint`, `pnpm spec:drift`, `pnpm scan:secrets`, `pnpm sdk:generate|sdk:check`, `pnpm verify` (all of those incl. `sdk:check`, `scan:secrets`, `zatca:guard`; no services, no browsers: this is what CI runs). Local data services (no Docker; macOS 13): `pnpm services:start|stop|status` (project-local Postgres :54329; Redis :6390 once installed), `pnpm db:migrate`, `pnpm db:dev-logins` (dev-only LOGIN for runtime roles), `pnpm db:test-rls`, `pnpm compliance:classification-coverage` (every column has a data class; needs the migrated DB), `pnpm compliance:ropa-coverage|residency-hooks` (need the migrated DB), `pnpm compliance:sync-controls` (loads `spec/compliance/controls.yaml`; `db:migrate` does it too), `pnpm compliance:collect-evidence [collector…]` (hashed evidence; idempotent), `pnpm compliance:claims-guard` (no claim words, controls.yaml valid; part of `verify`), `pnpm test:integration` (needs services running), `pnpm verify:full` (everything incl. browser E2E; exit 0 at M02 close, ~6 min; the E2E needs ports 3000/3001/4000/4010 free), `pnpm test:e2e` (builds both consoles, runs Playwright `ar`+`en` against a throwaway DB; needs services running and Chrome; a preflight names any process holding its ports and stops instead of Playwright's generic error), `pnpm test:e2e:isolated` (the same E2E on free ports and a throw-away database of its own, so it can run beside a dev stack; rebuilds both consoles; `scripts/e2e-isolated.sh`), `pnpm verify:full:isolated` (verify:full with the isolated E2E), `scripts/e2e-stack.sh start|run|restart|stop` (persistent isolated stack for running single specs; see `scripts/README.md`; E2E state at R6 close: `docs/reports/R6-report.md`), `pnpm --filter @nuzm/api dev:stack` (API + dev IdP). **Test databases (mandatory):** integration and E2E runs need an isolated leased environment: `source scripts/session-env.sh <name>` (or `node scripts/testenv/testenv.mjs acquire`); `NUZM_TEST_ADMIN_URL` is required and preflighted (no default database, never the owner's `:54329`); see `scripts/README.md`. Heavy commands go through `scripts/heavy-slot.sh`. Toolchain: Node 22, pnpm 10.34.9, Postgres 16. Never claim a command passed unless you ran it and saw the output.

## 2. Source of truth (precedence, highest first)
1. Accepted ADRs (`docs/adr/`) and owner decisions recorded in `docs/07-open-decisions-and-blockers.md`.
2. Machine-readable `spec/` (OpenAPI, `db/ownership.yaml`, `milestones/milestones.yaml`, `providers/`, `events/`). Before bootstrap: `docs/04`, `docs/05`, `docs/03`.
3. `docs/01-master-prd.md`, `docs/02-system-architecture.md`, `docs/06-sprint-roadmap.md`, track docs (`10`–`14`).
4. Milestone prompt.
5. Code.
If two sources conflict, stop, record the conflict in the milestone report, follow the higher source, and open an ADR/decision item. Never silently reconcile. Prompts must not rename endpoints or tables; change the spec first (with owner approval), then code.

## 3. Operating loop (every milestone)
1. **Establish state:** read `CLAUDE.md`, your milestone prompt, referenced docs, prior milestone reports and gate reviews, migrations, tests. Do not assume files/features exist.
2. **Plan briefly:** impacted modules, migrations, dependencies, mocked interfaces, human gates (HG) hit, risks. Ask the owner only for items that truly block (credentials, approvals, decisions). Everything else: proceed with the documented default and record the assumption.
3. **Implement in small reviewable commits**, spec first (OpenAPI/ownership manifest), then migrations, then code, then UI, then tests, then docs.
4. **Verify:** run lint, typecheck, unit, integration, contract, e2e, security scans available at that point. Record exact commands and results in the report.
5. **Report** using the response format in §10 and update `docs/reports/Mxx-report.md`. Mark status per §6.

## 4. Non-negotiable engineering rules
- **Tenant safety:** org context only from verified auth. Every tenant table has `org_id` + RLS. Every query path is covered by a cross-tenant test.
- **Money:** integer minor units + currency; no floats. Only `billing` posting service writes ledger rows; ledger and audit are append-only (corrections are reversing entries). Financial flow: quote → authorize → record → reconcile.
- **Idempotency & durability:** `Idempotency-Key` on side-effecting POSTs; webhooks deduped by provider event id; long work = `platform.operations`; after a timeout/uncertain result **reconcile before retry**.
- **Providers:** only through adapter interfaces (`docs/09`). Never invent API methods, regions, plans, prices, rights or results. Capabilities come from probes; unknown = unsupported. Offers shown only if verified for that account, plan and region.
- **Metering:** every billable action emits a metering event via the central pipeline (`docs/12`); no module bills directly.
- **Compliance hooks:** every region-bearing resource carries `data_region`; call `ResidencyPolicyService` before placing data or calling models/email/payment vendors; classify new personal-data fields; log mutations to audit.
- **Secrets:** vault references only; no secrets in code, logs, fixtures, prompts, or screenshots. Test credentials only in non-production vault.
- **AI/untrusted code:** run only in isolated sandboxes without platform secrets; budget caps; human approval for destructive or paid production actions.
- **API & DB:** follow `docs/04` conventions; no cross-schema FKs/writes; migrations per `docs/05` (forward-only, documented reversal, expand/contract).
- **UI:** every user-facing screen is Arabic (RTL) + English, keyboard-accessible, WCAG 2.1 AA targets, uses `packages/ui`, handles loading/empty/error/forbidden states, and is covered by an e2e test and a screenshot.
- **Feature flags** for every new capability; default off until acceptance.
- **Observability & audit:** trace id in every request/operation; audit event for every mutation; metrics and alerts for every worker/reconciler.

## 5. What the agent may and may not do
**Automatable by the agent:** code, migrations, tests, mocks/sandbox adapters, docs/runbooks, CI config, UI, spec updates, local demos, analysis of provider documentation (cited), probes against **sandbox/test** credentials the owner supplied.
**Never without explicit human action (record as BLOCKED / PENDING HG):** obtaining or generating real credentials/accounts; production provider calls that create billable resources; live PSP charges; ZATCA production onboarding/submission; registrar purchases; app-store submissions; signing with production keys; certifications, audits, pen tests, legal/tax sign-off, regulatory filings; go/no-go decisions; deleting production data; force-pushing or rewriting history; disabling safeguards.
Live vendor checks are **never** run unless the owner has granted the HG for that environment, and are labeled `LIVE-VERIFIED` (with evidence) or `NOT VERIFIED`.

## 6. Status vocabulary (use exactly)
`PASS` (evidenced) · `FAIL` · `BLOCKED (HG-xx/D-xx: reason)` · `NOT VERIFIED` (implemented but live/third-party validation missing) · `DEFERRED (approved change-log entry)`. A milestone is `DONE` only when every acceptance row is PASS, or BLOCKED/NOT VERIFIED rows are non-critical-path, explicitly listed in the gate review, and the owner has signed. Never convert BLOCKED to PASS using mocks.

## 7. Definition of done (per feature)
Spec updated · migration + rollback note · authz + RLS · idempotency · audit + metering + residency hooks · unit/integration/contract/e2e tests incl. failure, timeout, concurrency, cross-tenant, duplicate-webhook · UI states + i18n/RTL · docs/runbook · feature flag · evidence recorded.

## 8. Conventions
TypeScript strict; no `any` without comment; module boundaries enforced by lint (import only a module's public `index.ts`); Conventional Commits; PRs small and mapped to sprint tasks; ADR for any architectural change; error codes from the registry; logs structured, no PII; dates UTC; ids UUIDv7; `camelCase` JSON; SQL `snake_case`.

## 9. Repository map
`apps/{api,worker,web,admin}` · `packages/{contracts,db,domain,adapters,ui,i18n,config,testing,telemetry,sdk}` · `spec/` · `docs/{adr,runbooks,reports,milestones}` · `infra/`. Docs index: `docs/README.md`.

## 10. Response format (end of every milestone/sprint report)
A. Repository findings and assumptions · B. Plan and changed files · C. Implemented features, API and UI screens · D. Migrations and rollback · E. Tests run with actual results · F. Security, tenant isolation, billing, residency verification · G. Human gates and live checks still needed · H. Acceptance checklist (PASS/FAIL/BLOCKED/NOT VERIFIED with evidence links) · I. Next-milestone handoff and open decisions.

## 11. When unsure
Prefer the more restrictive, reversible choice; record the assumption; ask the owner only for decisions that change cost, legal exposure, security posture, or public contracts.
