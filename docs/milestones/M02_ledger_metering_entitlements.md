# M02 — Ledger, Metering & Entitlements

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| | |
|---|---|
| Sprints | S05–S07 (3 sprints) |
| Depends on | M01 **H** (M03/M04 not required) |
| Produces | `LedgerPostingService`, `MeteringIngestService` + `emitUsage()`, price books/rating, entitlement/quota check, spend limits/approvals, single `commerce.quotes`, usage/billing-core UIs |
| Gate | Gate Review per docs/03 §5; migration range `M02: 0200–0299` |
| Specs | docs/11 (ledger, recipes), docs/12 (metering, full) — implement exactly |
| Response format | CLAUDE.md §10 |

## 1. Objective
Build the money and usage core: an append-only double-entry ledger with the chart of accounts of docs/11 §3, plan/entitlement/price-book model, the centralized metering pipeline (ingest → dedupe → aggregate → rate), quota and spend control with approvals, the unified `/v1/quotes` mechanism, and the customer/admin screens for plans, usage, ledger and price books. No payment collection, invoices, tax or ZATCA (M03).

## 2. Preconditions & mocked interfaces
| Interface | Provider milestone | Mock in M02 | Label |
|---|---|---|---|
| Tax estimate for quotes | M03 `invoicing` tax engine | `TaxEstimator` returning configured rate from `invoicing`-agnostic config seed; quote shows `taxEstimate.status="provisional"` | NOT VERIFIED — M03 |
| Residency evaluation on quotes | M04 | allow-all stub; quote `residency.status="not_evaluated"` | NOT VERIFIED — M04 |
| Payment authorization/capture | M03 | Ledger-only credits (admin grant) and `authorizations` of kind `credit` | NOT VERIFIED — M03 |
| Meter producers | M05–M11 | Synthetic producer in `packages/testing` + dev-only `scripts/emit-usage` | fixtures only |
| Provider cost records | M05 | Admin manual import (CSV with evidence file) + fixtures | NOT VERIFIED — M05 |
| Pricing policy/VAT display/credit policy | HG-02-01, D-23, D-25 | Seed price book v0 flagged `DRAFT-NOT-APPROVED` with placeholder values clearly marked; cannot be activated in production | BLOCKED (HG-02-01) |

## 3. Requirement IDs closed
FR-LED-01, FR-LED-02, FR-LED-03, FR-LED-04, FR-LED-05, FR-MTR-01, FR-MTR-02, FR-MTR-03, FR-MTR-04, FR-MTR-05, FR-MTR-06 (capture; reconciliation use in M03), FR-MTR-07, FR-MTR-08 (consistency checks library; finrec runs in M03), FR-UI-xx for UI-M02-01..16.

## 4. Automatable engineering tasks
**S05 — Ledger, plans, entitlements.**
1. `billing` schema: `ledger_accounts` (seed docs/11 §3 chart), `ledger_transactions` (`id, org_id?, idempotency_key, kind, description, source_event_id, created_by, occurred_at`), `ledger_postings` (`transaction_id, account_id, direction, amount_minor, currency, dimensions`). Append-only enforcement (grants + trigger). Deferred constraint trigger: Σdebit = Σcredit per transaction and currency.
2. `LedgerPostingService.post(recipe, params, idempotencyKey)`; recipes as typed code with property tests; **only** this service writes postings. Recipes implemented in M02: promotional/admin credit grant, wallet consume, adjustment (reversing), provider cost accrual, usage charge (wallet-debit mode). Others (invoice, payment, refund, credit note, top-up) are registered as interfaces and implemented in M03.
3. Plans: `plans`, `plan_versions` (immutable once published), `entitlements` (rows with `scope = plan | org_override`: meter limits/allowances, feature flags). docs/05 has no org→plan assignment table before M03 `subscriptions`; M02 records the assignment as an `entitlements` row with `source = plan_assignment` and no new table (spec-issue to report). `EntitlementService.resolve(orgId)` = plan + overrides + marketplace view placeholder.
4. Wallet projection `wallet_balances` maintained by transactional outbox consumer from 2100 postings; drift test.
5. Admin plan CRUD via `/v1/admin/billing/plans`. docs/04 defines no endpoint for per-org entitlement overrides; M02 supports overrides only through plan-version variants and seed/admin DB tooling, and lists the gap in the report (do not invent an endpoint).

**S06 — Metering pipeline.**
6. `metering` schema per docs/12: `meters` (seed catalogue §3), `usage_events` (append-only, monthly partitions), `usage_aggregates`, `rated_usage`, `provider_cost_records`.
7. `MeteringIngestService` (validation, dedupe, residency tag, late policy, skew flags), `emitUsage()` helper (outbox), internal endpoint `POST /v1/internal/metering/events` (service credential + per-source key, mTLS config documented).
8. Aggregator + sampler framework (idempotent per bucket), replay tool (staging run + diff), producer completeness checker.
9. Price books: `price_books`, `price_book_versions`, `price_items` (meter, tier model: flat/graduated/volume, unit price minor units per unit, included allowance, rounding); rating engine resolving version at bucket time; `rated_usage` versioned by `rating_run_id`; re-rating delta logic.
10. Provider cost capture API (internal service + admin import) and `v_margin` view.

**S07 — Quotas, spend control, quotes, UI.**
11. Quota enforcement (docs/12 §7): `QuotaService.check(orgId, meterGroup, projected)`; soft thresholds → notifications (M01) at 80/100% (proposal); hard → `restricted` flag blocking *new* consumption only.
12. Spend limits (org/project monthly caps, alert thresholds), `spend_approvals` workflow (request → approve/deny by `billing_admin`/`owner`, four-eyes if above configurable amount; expiry), `commerce.authorizations` (kind `spend_approval|credit|payment` — payment in M03).
13. `commerce` schema: `quotes`, `quote_items`, `orders`, `order_items`, `authorizations`. `POST /v1/quotes` for kinds `compute|hosting|domain|database|storage|email|ai-credit|plan`; **immutable once issued**, TTL (proposal 15 min, config), items priced from price book version snapshot, includes `taxEstimate` (provisional), `residency` (not evaluated), `requiresApproval` flag. Kinds without provider catalog (everything except `plan` and `ai-credit`) return `422 kind_not_available` until owning milestone registers a `QuotePricer` — framework + registry delivered now.
14. Usage API/UI, billing-core UI, admin UIs; demo with synthetic producer: events → aggregate → rate → ledger wallet-debit → statement.
15. Runbooks: metering replay, ledger inspection, price-book release, reversing adjustment. `docs/reports/M02-report.md`.

## 5. Human approvals & external gates
| ID | Item | Agent meanwhile | Default status |
|---|---|---|---|
| HG-02-01 | Pricing/margin policy, VAT-inclusive display rules, approved price-book v1 | Build with `DRAFT-NOT-APPROVED` placeholder price book; block activation flag in production profile | PENDING / BLOCKED for production activation |
| D-23 | Pricing policy, currencies, margin, free tier, billing units | Proposed defaults (SAR base; units per docs/12 §3) | OPEN |
| D-25 | Credits/wallet policy (expiry, refundability) | Implement configurable expiry nullable; no refund path until M03/advisor | OPEN |
| D-30 | Ingest SLO targets | Proposals in docs/12 §12 | OPEN |
| D-31 | Reconciliation thresholds | Used by M03; library stores thresholds config only | OPEN |

## 6. API specifications (docs/04 §2.2 — exact)
| Endpoint | Authz | Request → response key fields | Errors / idempotency / async |
|---|---|---|---|
| GET `/v1/billing/plans` · GET `/v1/billing/plans/{id}` | any member | plan, version, price summary resolved for caller's price book, entitlements | 404 |
| GET `/v1/billing/entitlements` | `billing:read` (owner, admin, billing_admin, developer, viewer read-only summary) | effective limits per meter group, features, source (plan/override) | |
| GET `/v1/billing/ledger` | `billing:read` | cursor list of customer-visible postings (statement lines: date, description, debit/credit, balance, reference) | filters date/kind; no platform-only accounts exposed |
| GET `/v1/billing/balance` | `billing:read` | wallet balance, credits, committed spend, currency | |
| GET/PUT `/v1/billing/spending-limits` | read: `billing:read`; PUT: owner, billing_admin | `{scope:org|project, projectId?, monthlyCapMinor, currency, alertThresholds[]}` | If-Match; 422 cap below current month spend needs approval |
| POST/GET `/v1/billing/spend-approvals` | request: any developer+; list: billing_admin/owner | `{quoteId|operationId, amount, reason}` → `{id,status}` | Idempotency-Key; expires |
| POST `/v1/billing/spend-approvals/{id}/decision` | owner, billing_admin (not requester when four-eyes) | `{decision:approve|deny,note}` | 409 already decided; step-up MFA |
| GET `/v1/usage` · GET `/v1/usage/summary` | `usage:read` | aggregates by meter/project/resource/period, `granularity=hour|day|month`; summary includes rated amount, allowance used | cursor; org-scoped; `dataRegion` shown |
| GET `/v1/usage/events` | X: platform `finance`/`support`; C: own org, owner/admin, debug flag only | raw events (id, meter, qty, resource) | cursor; rate-limited |
| GET `/v1/quotas` | `usage:read` | per meter group limit, used, state `ok|soft|hard` | |
| POST `/v1/quotes` · GET `/v1/quotes/{id}` | `quote:create` (developer+), read same org | `{kind,items[],projectId?,preferences?}` → `{id,expiresAt,items[],subtotal,taxEstimate,total,currency,requiresApproval,residency,priceBookVersionId}` | **Idempotency-Key required**; sync 201 (no provider call in M02); 422 `kind_not_available`/`quota_exceeded`; quotes never mutated |
| GET `/v1/admin/billing/ledger-accounts` · GET `/v1/admin/billing/ledger-transactions` | finance, platform_admin, compliance_officer (read) | account tree, balances; transaction with postings | cursor; access audited |
| GET/POST `/v1/admin/billing/price-books` · POST `…/{id}/versions` | finance (create), platform_admin (publish needs second approver) | `{name,currency,items[]}`; version publish immutable | 409 overlapping effective dates |
| GET/POST `/v1/admin/billing/plans` · PATCH `…/{id}` | finance | plan + version draft/publish | published versions immutable (422) |
| POST `/v1/admin/billing/adjustments` | finance request, second finance/platform_admin approver | `{orgId,lines[],reason,reverses?}` | Idempotency-Key; reversing entries only; step-up |
| GET/POST `/v1/admin/meters` | platform_admin, finance | meter definition (unit, dimensions allow-list) | 409 duplicate id; unit immutable after first event |
Internal: `POST /v1/internal/metering/events` (not public; service credential): batch ≤ 500 events; per-event result `accepted|duplicate|rejected(reason)`; idempotent by `eventId`.

## 7. Database migrations (`0200–0299`)
| Schema | Tables / notes |
|---|---|
| `billing` | `ledger_accounts`, `ledger_transactions`, `ledger_postings` (append-only; deferred balance constraint; index `(account_id, created_at)`, `(org_id, created_at)`), `plans`, `plan_versions`, `price_books`, `price_book_versions`, `price_items`, `entitlements` (scope plan\|org_override, meter_id/feature, limit, allowance, mode soft/hard), `quotas` (materialized consumption state), `spending_limits`, `spend_approvals`, `wallet_balances` (projection, rebuildable). **Not created now:** `subscriptions`, `dunning_cases` (M03), `reseller_price_rules` (M11). |
| `metering` | `meters`, `usage_events` (append-only; unique `(org_id,event_id)`; monthly partitions), `usage_aggregates`, `rated_usage`, `provider_cost_records`, `metering_reconciliations` (**listed in docs/05; keep minimal and non-authoritative; see spec issue**) |
| `commerce` | `quotes` (immutable after issue; trigger), `quote_items`, `orders`, `order_items`, `authorizations` |
RLS: all org tables forced; platform accounts (`org_id` null) readable only by `finance`/admin DB role. Seeds: chart of accounts (reference), meters (docs/12 §3), `DRAFT-NOT-APPROVED` price book, sample plans (free/starter placeholder, flagged). Reversal: dev `.down.sql`; production forward-fix; ledger/usage tables never dropped by down scripts in prod profile. Rebuild scripts for projections (`wallet_balances`, `usage_aggregates`).

## 8. UI screens
All: ar (RTL)+en, loading/empty/error/forbidden, axe clean, screenshot tests. Money formatting with locale digits, currency symbol, minor-unit exactness.
| ID | Portal | Route | Purpose / key states | Roles |
|---|---|---|---|---|
| UI-M02-01 | C A R | `/billing` | overview: balance, month-to-date usage, spend vs cap, alerts | billing_admin, owner, admin |
| UI-M02-02 | C A R | `/billing/plans` | plan catalogue, current plan/entitlements (change plan → M03) | member read |
| UI-M02-03 | C A R | `/billing/usage` | usage explorer: filters meter/project/resource, chart+table, export CSV; "data region" column | usage:read |
| UI-M02-04 | C A R | `/billing/usage/[meter]` | drilldown per resource; late-event note | usage:read |
| UI-M02-05 | C A R | `/billing/ledger` | statement with running balance; filters | billing:read |
| UI-M02-06 | C A R | `/billing/spending-limits` | caps/thresholds editor; conflict (412) state | owner, billing_admin |
| UI-M02-07 | C A R | `/billing/approvals` | pending/decided approvals; approve/deny dialog (step-up) | owner, billing_admin; developer sees own |
| UI-M02-08 | C A R | `/billing/quotas` | quota gauges, restricted banner | usage:read |
| UI-M02-09 | C A R | `/billing/quotes/[id]` | quote detail (provisional tax/residency badges, expiry countdown, approval-needed callout) | quote reader |
| UI-M02-10 | X | `/billing/ledger` | accounts tree + transactions explorer + posting detail | finance, platform_admin |
| UI-M02-11 | X | `/billing/price-books` | books, versions, diff view, publish with 2nd approver | finance, platform_admin |
| UI-M02-12 | X | `/billing/plans` | plans/versions/entitlements editor | finance |
| UI-M02-13 | X | `/billing/meters` | meter catalogue, producer health (completeness gauge) | finance, platform_admin |
| UI-M02-14 | X | `/billing/usage-events` | raw event search, replay (staging diff) | finance, support (read) |
| UI-M02-15 | X | `/billing/adjustments` | request/approve reversing adjustments | finance |
| UI-M02-16 | X | `/billing/provider-costs` | import CSV + evidence, margin view | finance |

## 9. Security, compliance & tenant-isolation requirements
- Ledger/usage/audit tables: `UPDATE`/`DELETE` revoked from all runtime roles; corrections via reversing postings only; test attempts under every role.
- Cross-tenant: statements, usage, quotas, approvals, quotes all RLS; platform accounts invisible to customer roles.
- Metering ingest trusts `orgId` only from authenticated producer context; internal endpoint rejects org mismatch with source key scope.
- Four-eyes: adjustments, price-book publish, approvals above threshold; requester ≠ approver; step-up MFA.
- Classification: `usage_events`, ledger = `financial`/`internal`; no content in events; `dimensions` allow-list enforced.
- Audit events: `ledger.posted`, `adjustment.requested|approved|rejected`, `pricebook.version_published`, `plan.version_published`, `quota.threshold_crossed`, `spend_approval.requested|decided`, `quote.issued`, `meter.created`, `usage.replay_applied`.
- Residency: `usage_events.data_region` mandatory; quotes carry `residency` block (stub).

## 10. Metering & billing hooks
This milestone *builds* the pipeline; meters catalogue seeded (all ids in docs/12 §3). Emit points implemented now: `ai.credits_consumed` via test producer only. Quota check points registered (`QuotaService`, `QuotePricer` registry) for use by M05–M11. Wallet-debit mode usable by M09 AI credits before M03 invoicing.

## 11. Automated tests
| Layer | Cases |
|---|---|
| Property | `ledger_tx_always_balanced` (random recipes), `rating_sum_of_parts_equals_total`, `aggregate_equals_sum_of_distinct_events`, `replay_is_noop` |
| Unit | recipe postings per docs/11 §3.1; graduated/volume tier math; rounding half-up per price item; allowance then overage; price-version resolved at bucket time |
| Integration | `duplicate_event_no_effect`, `out_of_order_events`, `late_after_close_goes_next_period_with_ref`, `clock_skew_flagged`, `unknown_meter_rejected`, `forbidden_dimension_rejected`, `wallet_projection_matches_ledger`, `quote_immutable`, `quote_ttl_expiry`, `spend_cap_requires_approval`, `four_eyes_enforced`, `quota_soft_notifies_hard_restricts_new_only` |
| Concurrency | 100 parallel `emitUsage` same eventId → 1 row; 50 parallel wallet consumes cannot overdraw (serializable or row-lock; test) ; concurrent price-book publish |
| Cross-tenant | org A cannot read B usage/ledger/quotes/approvals; spoofed `orgId` in internal endpoint rejected; platform account hidden |
| Failure | ingest worker crash mid-batch (outbox redelivery), DB failover, aggregator restart idempotent |
| Contract | OpenAPI conformance, problem+json codes `quota_exceeded`, `spend_approval_required`, `kind_not_available` |
| E2E (ar+en) | synthetic producer → usage page shows → rated → wallet debit → statement; spending-limit hit → approval → decision → quote proceeds |
| Load | 10M events aggregation fixture within SLO proposals (record result; SLO is a proposal under D-30) |
| Security | grants test (no UPDATE/DELETE), SQL injection on filters, export CSV formula-injection escape |

## 12. Deliverables
Modules `billing` (core), `metering`, `commerce`; migrations 0200–0299 + reversal notes; OpenAPI for §6 (implemented); `spec/events/usage.recorded.json`; seed packs; synthetic producer; screens §8; runbooks (`metering-replay`, `ledger-inspection`, `pricebook-release`, `reversing-adjustment`, `rebuild-projections`); `.env.example` additions; demo `docs/runbooks/demo-m02.md`; `docs/reports/M02-report.md`; gate review; list of spec issues found.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M02-01 | Ledger balance property: 100% of 10,000 generated transactions balanced; unbalanced insert rejected by DB | test output | PENDING |
| AC-M02-02 | `UPDATE`/`DELETE` on ledger/usage/audit rejected for all runtime roles | test output | PENDING |
| AC-M02-03 | Duplicate/replayed events (≥1,000 duplicates in fixture) change aggregates by 0 | test output | PENDING |
| AC-M02-04 | Rating fixtures: all tier/allowance/rounding cases match expected minor units exactly (0 diff) | fixture report | PENDING |
| AC-M02-05 | Price-version-change mid-period test attributes each bucket to correct version | test | PENDING |
| AC-M02-06 | Wallet projection equals Σ2100 postings after 10k random ops (RC-06 library check) | test | PENDING |
| AC-M02-07 | No overdraw under 50 concurrent wallet consumes | test | PENDING |
| AC-M02-08 | Spending cap blocks quote→order path without approval; approved path proceeds; requester cannot self-approve (four-eyes) | e2e | PENDING |
| AC-M02-09 | Quote immutability: any UPDATE after issue rejected; expired quote refused | tests | PENDING |
| AC-M02-10 | Cross-tenant suite passes for all new `{id}` routes and RLS coverage = 100% of new tables | test report | PENDING |
| AC-M02-11 | Ingest-to-visible p95 < 60 s and aggregation lag p95 < 5 min on 1M-event fixture (SLO proposal; result recorded) | perf report | PENDING |
| AC-M02-12 | All 16 screens: axe 0 serious/critical; ar+en screenshots | reports | PENDING |
| AC-M02-13 | Every meter in docs/12 §3 exists in seed with unit/allow-list; producer checklist doc present | seed diff | PENDING |
| AC-M02-14 | Approved production price book v1 active | HG-02-01 evidence | BLOCKED (HG-02-01), not satisfiable by mocks |
| AC-M02-15 | Tax and residency on quotes verified against real engines | M03/M04 | NOT VERIFIED until M03/M04 |
| AC-M02-16 | Provider cost import/RC-04 against real provider bills | M05 + HG-05-xx | BLOCKED until M05 |

## 14. Handoff to next milestones
M03: `LedgerPostingService` recipe registry (invoice/payment/refund/credit-note/top-up to implement), `rated_usage` as invoice input, `commerce.authorizations` payment kind, `finrec` to consume metering consistency checks, `TaxEstimator` to replace mock. M04: residency block in quotes, `data_region` tags. M05–M11: `emitUsage()`, `QuotePricer` registry, `QuotaService`, producer checklist (docs/12 §11). Open decisions: D-23, D-25, D-31, HG-02-01.

## 15. Compliance hooks checklist
- [ ] Residency: every usage event tagged; quote residency block present (stub flagged)
- [ ] PII: ledger/usage hold ids not personal content; classification annotated
- [ ] Consent: n/a (no new personal data collected)
- [ ] Audit: events in §9 implemented; admin reads audited
- [ ] Retention: ledger/usage retention placeholder tied to D-34; no deletion jobs

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Mark missing approvals, credentials or decisions as BLOCKED, never simulate them. The agent may not mark any HG item as granted; only the owner records evidence. Report using CLAUDE.md §10.
