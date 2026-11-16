# S07b report — Commerce (quotes, orders, authorizations) and manual adjustments (M02 sprint 3, part 2)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** S07c (billing UIs, demo runbook, M02 report) remains.

## A. Repository findings and assumptions
- **Plan quotes (deviation from the M02 prompt, recorded):** the prompt lists `plan` as an available kind, but docs/05 and the S05 design give plans **no price** (price books are per meter) and subscriptions arrive in M03. Quoting a plan would mean inventing a fee, so `plan` is registered and answers `kind_not_available` with an explicit reason. `ai-credit` is priced for real from the price book (meter `ai.credits_consumed`).
- **Money shape:** docs/04 §1 says money is `{amount, currency}`; S05–S07 responses use `…Minor` string fields plus `currency` (integer strings in minor units). Kept for consistency with the committed contract; owner decision to align (ADR) or keep.
- **Adjustments, one endpoint:** docs/04 defines only `POST /v1/admin/billing/adjustments`; two-person approval needs a second step. Following the price-book precedent, the same endpoint takes two bodies (request vs decision). No new path was invented. Proposed for the owner: a `GET` list and an `…/{id}/approvals` sub-resource.
- **Quote permissions:** new `quote:create` (owner, admin, billing_admin, developer) and `quote:read` (same); viewers cannot read quotes. New platform permission `admin:billing:approve` (finance, platform_admin).
- **Tax estimate:** configurable (`QUOTE_TAX_ESTIMATE_BPS`, default 1500 = the 15 % of docs/11 §4 which is itself `[VERIFY]`), always labelled `provisional`. Residency is `not_evaluated` (M04).
- **Spend and orders:** orders are not counted in the month's spend (only rated usage and approved approvals are); how one-time purchases and consumption commitments are counted is for M03/M05. Consequently concurrent orders under the cap are not serialized. A first design held an advisory lock plus nested connections and deadlocked the pool under 10 parallel orders; it was replaced by checks followed by one short insert transaction arbitrated by unique constraints.
- `credit` authorizations (wallet holds) are not implemented; only `spend_approval` authorizations exist in M02.

## B. Plan and changed files
- Migrations `commerce/0204` (schema, quotes, quote_items, orders, order_items, authorizations, immutability triggers, RLS, `quote:*` permissions) and `billing/0205` (`adjustment_requests`, `admin:billing:approve`); `.down.sql` for both (dev only); `spec/db/ownership.yaml`.
- `apps/api/src/modules/commerce`: `quote.service.ts`, `order.service.ts`, `pricers.ts` (registry, `AiCreditPricer`, `PlanPricer`), `tax-estimator.ts`, controller, module. `apps/api/src/modules/billing`: `adjustment.service.ts`, `admin-adjustments.controller.ts`. `apps/api/src/common/pricing.ts` (pricing helpers shared with rating).
- Spec: `createQuote`, `getQuote`, `adminBillingAdjustment`; error code `kind_not_available`; SDK regenerated. Runbook `reversing-adjustment.md` rewritten; `.env.example` (`QUOTE_TTL_MINUTES`, `QUOTE_TAX_ESTIMATE_BPS`).

## C. Implemented features and API
| Area | What exists |
|---|---|
| Quotes | `POST /v1/quotes` (Idempotency-Key required), `GET /v1/quotes/{id}`; priced by the kind's registered pricer from the price book version effective now; provisional tax; hard-quota refusal (`quota_exceeded`); `requiresApproval` from the spend cap; TTL; immutable (trigger) |
| Registry | `QuotePricerRegistry`: owning milestones register compute/hosting/domain/database/storage/email/marketplace; until then `kind_not_available` (422) |
| Orders | `OrderService.createFromQuote` (no HTTP endpoint; typed create endpoints of M05–M08 call it): expiry (410 `gone`), one order per quote (409), quota and spend re-check at commitment, spend-approval authorization used once |
| Adjustments | request + two-person decision on one endpoint; reversal or balanced lines; idempotent request (key + payload hash) and idempotent posting (`adjustment:<id>`); final decisions; platform-only visibility |

## D. Migrations and rollback
`commerce/0204` and `billing/0205` create the tables, triggers (including always-refusing TRUNCATE guards), forced RLS and grants. Dev-only `.down.sql`; quotes, orders, authorizations and adjustment requests are financial/approval records and are never dropped in production (forward fix).

## E. Tests run (actual)
- Full API integration (`vitest run --config vitest.integration.config.mts`, real PostgreSQL): **15 files, 348 tests passed** (24 new in `commerce.int.spec.ts`, 3 new generated cross-tenant cases). Spec lint clean, spec drift OK (**83** operations), `sdk:check` up to date, `db check` OK.
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line; an earlier run stopped at lint on an unused import left by moving the pricing helpers, fixed). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **135 unit tests** (api 82, i18n 9, db 9, ui 7, domain 6, web 5, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **4 passed**; spec lint clean, spec drift OK (83 operations), `sdk:check` up to date, `scan:secrets` 760 files / 0 hits, `db check` OK; integration on real PostgreSQL **431** (db 43, platform 32, worker 8, api 348).
- Defects found by the tests and fixed in this sprint: nested-connection pool deadlock in order creation (restructured); the adjustment-request TRUNCATE guard did not fire (statement triggers have no row; replaced by a dedicated always-refusing function).
- Highlights: AC-M02-08 path at service level (over the cap refused, a second person's approval for exactly that quote and a covering amount lets it through, used once, not reusable by another quote, a denied or too-small approval does not authorize); AC-M02-09 (every UPDATE/DELETE/TRUNCATE of quotes refused for all roles; expired quote refused); 10 parallel orders for one quote → exactly one; adjustment replay, requester≠approver, approval exactly-once with crash reconciliation.

## F. Security, tenant isolation, billing, residency verification
RLS forced on every new table; cross-tenant generated tests cover `GET /v1/quotes/{id}`; adjustment requests are visible to the platform scope only (an organization-scoped session sees none); no ledger write path other than `billing.post`; money as integer strings; quotes never expose provider cost. Residency: `not_evaluated` until M04 (flagged in every quote).

## G. Human gates and live checks still needed
HG-02-01 (approved price book v1) BLOCKED — the only book is the placeholder, which the quote path refuses in a production profile; AC-M02-15 (tax/residency verified on quotes) NOT VERIFIED until M03/M04; D-23/D-25 OPEN.

## H. Acceptance (S07b rows)
| Row | Status |
|---|---|
| Single quote mechanism, immutable, TTL, provisional tax, residency stub | PASS |
| Quote kinds `ai-credit` | PASS; `plan` NOT AVAILABLE (deviation recorded); other kinds registry-ready, `kind_not_available` by design |
| Spending cap blocks quote→order without approval; approved path proceeds; four-eyes | PASS (service level; no order HTTP endpoint until M05+) |
| Adjustments: two-person, reversing/balanced entries only, idempotent | PASS |
| Adjustments list/read endpoint; `credit` authorizations; orders in month spend | NOT DONE |
| Cross-tenant suite for new `{id}` routes | PASS |

## I. Handoff and open decisions
- S07c: customer/admin billing UIs (UI-M02-01..16), demo runbook `demo-m02.md`, E2E and screenshots, `M02-report.md`, gate review.
- Owner decisions: plan quote semantics (price source) with M03; money response shape (`…Minor` vs docs/04 `{amount,currency}`); adjustment list/approval endpoints; whether `viewer` may read quotes; counting of orders in month spend.
