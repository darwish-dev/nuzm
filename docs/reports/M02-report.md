# M02 Milestone Report — Ledger, Metering & Entitlements

Format: CLAUDE.md §10. Sprint reports: [S05](S05-report.md) · [S06](S06-report.md) · [S07a](S07a-report.md) · [S07b](S07b-report.md) · [S07c](S07c-report.md). Gate review: [M02-gate-review.md](M02-gate-review.md). Demo: [demo-m02](../runbooks/demo-m02.md).
Status: **READY FOR GATE REVIEW WITH LISTED GAPS. NOT DONE (owner has not signed).** BLOCKED and NOT VERIFIED rows are listed in §H; none was converted to PASS using a mock.

## A. Repository findings and assumptions
- Approved documentation (HG-00-01) governs; M01 was signed with deferrals (2026-11-16). Local-only git (D-01); one team, sequential sprints (D-02).
- **Conflicts and gaps recorded (never silently reconciled):**
  1. M02 prompt `source = plan_assignment` vs docs/05 `source = 'plan'`: docs/05 followed (S05).
  2. docs/04 says money is `{amount, currency}`; implemented as `…Minor` integer strings + `currency` since S05 (owner to align or keep).
  3. `plan` quotes: the prompt lists them available, but plans have no price before M03 subscriptions; answered `kind_not_available` rather than inventing a fee (S07b).
  4. No endpoint in docs/04 for provider-cost import, a platform-wide raw-events view, adjustment listing/approval sub-resources, a rating trigger, or per-org entitlement overrides: none was invented (admin tooling / service level only).
  5. Entitlements limit a "meter group" while a group mixes units: one measuring meter per group (`billing.quota_meters`, placeholder mapping for five groups); unmapped groups report `measured: false`.
  6. Rated usage and aggregates carry no project: project spending caps see approved spend only; usage has no project filter until M05.
  7. Late-event grace of 72 h and the quote TTL (15 min), approval TTL (24 h), tax estimate (15 %, `[VERIFY]`) are proposals/config.
- **Latent M01 defects found and fixed during M02:** `audit.verify_chain` skipped its scope check with no scope set (NULL comparison; `audit/0011`); the browser client lacked `X-Nuzm-Org` for members who never switched organization (`ActiveOrgCookie`).
- Pricing, limits and plans are DRAFT-NOT-APPROVED placeholders (HG-02-01); the quote and rating paths refuse the placeholder book in a production profile.

## B. Plan and changed files
S05 ledger, plans, entitlements · S06 metering, price books, rating, provider cost · S07a usage API, quotas, spending limits, approvals · S07b commerce quotes/orders/authorizations, adjustments · S07c UIs, demo, closing. Migrations `billing/0200, 0202, 0203, 0205`, `metering/0201`, `commerce/0204`, `audit/0011`. New modules `billing`, `metering`, `commerce`; worker consumers for `ledger.posted` and `usage.recorded` and a partition job; spec grew from 55 to 83 operations; SDK regenerated; five runbooks plus quotas, demo.

## C. Implemented features, API and UI screens
- **Ledger:** append-only double-entry (`billing.post` is the only writer), chart of accounts per docs/11 §3, recipes (credit grant, wallet consume, usage charge, provider cost accrual, adjustment, reversal; invoice/payment/refund/credit-note/top-up registered → M03), wallet projection by outbox consumer.
- **Plans/entitlements/price books:** immutable published versions, effective limits, price books with four-eyes publishing, exact-decimal rating (flat, graduated, volume, allowance) with re-rating deltas.
- **Metering:** 31 meters (identical to docs/12 §3), internal ingest endpoint (service keys), outbox ingest, immutable partitioned events, replayable aggregates, provider cost + margin view.
- **Control:** quotas (80/100 % notices, hard = new consumption only), spending limits, spend approvals (four-eyes, step-up, expiry), single quote mechanism with pricer registry (`ai-credit` live), orders with authorizations, two-person ledger adjustments.
- **API:** 28 operations added (83 total, spec ↔ code two-way drift check). **UI:** customer UI-M02-01..09 and admin -10, -11 (list/publish), -12 (read), -13, -15 in Arabic (RTL) and English.

## D. Migrations and rollback
`0200–0205` (+ `audit/0011`), each with a dev/staging-only `.down.sql`; production is forward-fix, and ledger, usage, quote, order, approval and adjustment tables are never dropped by down scripts in a production profile. Rebuild paths: wallet projection (`billing.refresh_wallet`), usage aggregates (`metering.aggregate`), quota projection (recomputed on read) — see runbooks.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run: lint, typecheck, build; **168 unit** (api 82, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3); **E2E 6 passed** (ar+en: customer, admin incl. billing administration, billing flow; axe 0 violations, screenshots stored); spec lint clean; spec drift OK (83); `sdk:check`; `scan:secrets` 784 files / 0 hits; `db check` OK; **integration 432** on real PostgreSQL (db 43, platform 32, worker 8, api 349). Per sprint: ledger 25 + billing API 14 (S05), metering 35 + worker 5 (S06), quotas/spend 28 (S07a), commerce 24 (S07b), generated cross-tenant coverage for every new `{id}` route.
Not run: load/SLO fixtures (1M/10M events), live providers, real PSP or tax engine, keyboard-only and screen-reader walkthroughs.

## F. Security, tenant isolation, billing, residency verification
- **Isolation:** forced RLS on every new tenant table (`db check` fails the build otherwise); spec-generated cross-tenant tests (404 for foreign ids, session and API key); organization-scope guards inside SQL functions; platform-only tables for adjustments.
- **Integrity:** ledger, usage events, quotes, authorizations, approvals and adjustment requests refuse UPDATE/DELETE/TRUNCATE for every role (tested, including the owner); an unbalanced transaction cannot commit; idempotent posting, ingest and adjustment approval; parallel consumers cannot overdraw.
- **Money:** integer minor units end to end; money input parsed by string arithmetic; CSV export formula-injection safe.
- **Four-eyes:** price-book publish, spend approvals above the threshold and adjustments all refuse the same person twice (service check and, where it matters, a table constraint).
- **Residency:** usage carries a `data_region` placeholder (`sa-pending`); quotes say `not_evaluated`: **NOT VERIFIED — M04.**

## G. Human gates and live checks still needed
HG-02-01 (approved pricing, margin policy, price book v1) **BLOCKED** (placeholder book refused in production); D-23 (pricing policy/currencies), D-25 (wallet/VAT policy), D-30/D-31 thresholds **OPEN**; D-12 (vault) for producer keys; mTLS between producers and ingress documented only; real tax and residency on quotes need M03/M04; provider cost against real bills needs M05. M01 BLOCKED items unchanged.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| AC-M02-01 ledger balance, 10,000 generated tx; unbalanced rejected | PASS | `recipes.spec.ts` (10,000 runs per property), `ledger.int.spec.ts` (rejected at COMMIT) |
| AC-M02-02 no UPDATE/DELETE on ledger/usage/audit for runtime roles | PASS | `ledger.int.spec.ts`, `metering.int.spec.ts`, M01 audit tests |
| AC-M02-03 ≥1,000 duplicates change aggregates by 0 | PASS | `metering.int.spec.ts` (1,000 replayed duplicates) |
| AC-M02-04 rating fixtures, 0 diff | PASS | `rating.spec.ts` (33), rating cases in `metering.int.spec.ts` |
| AC-M02-05 mid-period price version attribution | PASS | `metering.int.spec.ts` |
| AC-M02-06 wallet projection = Σ2100 after 10k random ops | PARTIAL | drift and consumer tests pass; the 10,000-op scale was not run: NOT VERIFIED at that scale |
| AC-M02-07 no overdraw, 50 concurrent consumes | PASS | `ledger.int.spec.ts` |
| AC-M02-08 cap blocks quote→order without approval; approved proceeds; four-eyes | PASS | `commerce.int.spec.ts` (service level, no order HTTP endpoint yet) + billing E2E (request → four-eyes refusal → second-person approval) |
| AC-M02-09 quote immutability and expiry | PASS | `commerce.int.spec.ts` |
| AC-M02-10 cross-tenant for all new `{id}` routes; RLS on 100 % of new tables | PASS | generated suite, `db check` |
| AC-M02-11 ingest/aggregation SLO on 1M events | NOT VERIFIED | not run (D-30 is a proposal) |
| AC-M02-12 all 16 screens axe-clean, ar+en screenshots | PARTIAL | 14 screens delivered (UI-M02-11, -12, -15 partial) with axe + screenshots; UI-M02-14 and -16 not built (no API) |
| AC-M02-13 every docs/12 §3 meter seeded; producer checklist present | PASS | 31/31 ids identical; checklist is docs/12 §11 (units/allow-lists not machine-diffed) |
| AC-M02-14 approved price book v1 active | BLOCKED (HG-02-01) | not satisfiable by mocks |
| AC-M02-15 tax and residency on quotes verified against real engines | NOT VERIFIED | M03/M04 |
| AC-M02-16 provider cost import / RC-04 against real bills | BLOCKED | M05 + provider HG; capture and accrual exist, no import endpoint |
Requirement IDs: FR-LED-01..05 and FR-MTR-01..07 implemented with the tests above; FR-MTR-06 capture only; FR-MTR-08 partial (`verify_aggregates`, projection drift tests; the finrec library check arrives with M03).
UI rows: UI-M02-01..09, -10, -13 PASS; -11 PARTIAL (no diff view, publish not click-tested); -12 PARTIAL (read-only); -15 PARTIAL (reversal request + decision, no list, no manual lines form); -14 and -16 NOT DONE.

## I. Next-milestone handoff and open decisions
- **M03:** `LedgerPostingService` recipe registry (invoice, payment, refund, credit note, top-up), `rated_usage` as invoice input, `commerce.authorizations` payment kind, `TaxEstimator` → tax engine, `finrec` consuming metering consistency checks, adjustment list/approval endpoints if approved. **M04:** residency block and `data_region` policy. **M05–M11:** `emitUsage()`, `QuotePricerRegistry`, `QuotaService`/`SpendService.assertAllowed`, producer checklist, order screens, provider-cost import.
- **Owner decisions (OPEN):** HG-02-01 and D-23/D-25; money response shape; `plan` quote semantics; endpoints for provider-cost import, platform-wide usage events, adjustment listing/approval; the `quota_meters` mapping per group; whether viewers may read quotes and whether `admin` is an approver; counting orders in the month's spend; 72 h late grace; carried from M01: additive contract changes, PA-12/17/18, `POST /v1/admin/organizations`, impersonation approval model, per-console OIDC clients.
