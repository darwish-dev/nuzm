# S05 report — Ledger, plans, entitlements (M02 sprint 1)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M02 continues with S06 (metering) and S07 (quotas, spend control, quotes, UI); this sprint delivers the ledger core and the plan/entitlement model only.

## A. Repository findings and assumptions
- **Gate:** the owner signed M01 with deferrals on 2026-11-16 ([M01-gate-review.md](M01-gate-review.md), [M01-deferrals.md](M01-deferrals.md)). Open owner decisions and BLOCKED items carry over.
- **Spec conflict (recorded):** the M02 prompt says the org→plan assignment is an `entitlements` row with `source = plan_assignment`; docs/05 (higher precedence) says `source = 'plan'`. Implemented per docs/05: the assignment row has `kind = 'plan_assignment'`, `source = 'plan'`, `scope = 'org_override'`; plan rows are `scope = 'plan'`; overrides are `source = 'override'`. No new table.
- **Wallet VAT** (VAT at top-up vs at consumption) is `[VERIFY]` with the tax advisor (D-25): the consume recipe takes an optional VAT amount (default 0 = not applied here) and posts it to 2300 when given.
- **Seed plans are placeholders** (`free`, `starter`, `placeholder = true`, "DRAFT-NOT-APPROVED", HG-02-01): the values are examples, not a price list. They carry no prices (price books arrive in S06).
- **Admin credit grants and reversing adjustments** have recipes and a service but **no HTTP endpoint yet**: docs/04 exposes them only through `POST /v1/admin/billing/adjustments` (finance request + second approver), which needs the four-eyes machinery built in S07 with spend approvals. The ledger service is exercised by tests today.
- **M01 defect found and fixed during this sprint:** `audit.verify_chain` skipped its scope check when no scope was set (NULL comparison); a forward-fix migration `audit/0011` and a regression test were added. The same class of bug in the new `billing.post`/`refresh_wallet` was caught by the new tests before release.

## B. Plan and changed files
- Migration `billing/0200` (+ `.down.sql`, dev only) and `audit/0011` (+ down); `spec/db/ownership.yaml` (tenant-less: `billing.plans`, `billing.plan_versions`).
- `apps/api/src/modules/billing`: `recipes.ts`, `ledger.service.ts`, `plan.service.ts`, `entitlement.service.ts`, `billing-read.service.ts`, two controllers, module.
- `apps/worker`: wallet projection consumer for the `ledger.posted` outbox topic; integration test config.
- Spec: 10 operations + schemas; error codes `insufficient_funds` (402) and `recipe_not_implemented` (501); `x-nuzm-global-reference` extension for plan catalogue routes (excluded from the per-org 404 generator).

## C. Implemented features and API
| Area | What exists |
|---|---|
| Ledger | Chart of accounts (docs/11 §3) with lazily created per-org and per-provider sub-accounts; double-entry, append-only, balanced per currency; integer minor units as strings; idempotent per `(org, key)`; only `billing.post()` writes (runtime roles have no INSERT/UPDATE/DELETE) |
| Recipes | credit grant, wallet consume, usage charge (wallet-debit mode), provider cost accrual, admin adjustment, reversal. **Registered but not implemented (M03):** invoice issued, payment captured, refund, credit note, wallet top-up → `recipe_not_implemented` |
| Wallet | Overdraw guard under row locks (50 parallel consumes of 100 against 1000 → exactly 10 succeed); projection `wallet_balances` rebuilt by the outbox consumer; drift tested |
| Plans | `plans`/`plan_versions`/`entitlements`; versions immutable once published (API 409 + DB triggers, even for the table owner); one draft at a time; branch a new draft from the latest published |
| Entitlements | `EntitlementService.resolve` = assigned (or default `free`) plan + overrides (newest wins) + marketplace placeholder |
| Endpoints | `GET /v1/billing/plans`, `/plans/{id}`, `/entitlements`, `/ledger`, `/balance`; `GET /v1/admin/billing/ledger-accounts`, `/ledger-transactions`, `/plans`; `POST /v1/admin/billing/plans`; `PATCH /v1/admin/billing/plans/{id}` |
- Permissions: plans/entitlements need `org:read` (every member; the spec's "billing:read with a summary for others" is simplified); ledger/balance need `billing:read` (owner, admin, billing_admin); admin reads need new `admin:billing:read` (finance, platform_admin, compliance_officer); plan writes need `admin:billing:manage` (finance).

## D. Migrations and rollback
`billing/0200` creates schema `billing`, 7 tables, 6 functions, triggers, RLS (forced; owner policy for the SECURITY DEFINER functions), grants and seeds (10 platform accounts, 2 placeholder plans). `.down.sql` drops the schema for dev/staging **only**; production ledger data is never dropped (forward fix). `audit/0011` replaces one function (down is a no-op marker).

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0 in 194 s** (read from the run's own log line; a first run failed because the platform-scope boundary test had not been told that the billing module legitimately uses the admin scope, now an explicit allow-list entry).
- Lint, typecheck, build: 18/18, 19/19 and 11/11 turbo tasks. Unit tests: **102** (api 49, of which 24 are the recipe property/table tests; i18n 9, ui 7, db 9, domain 6, web 5, admin 5, worker 5, sdk 4, telemetry 3).
- Integration on real PostgreSQL: db 43, platform 32 (incl. the NULL-scope regression), worker 3 (outbox → projection), **api 247** (ledger 25, billing API 14, +existing) = **325**.
- Highlights: 50 parallel wallet consumes against a balance of 1000 → exactly 10 succeed, never negative; 100 parallel posts with one idempotency key → one transaction; direct writes by `nuzm_app`/`nuzm_worker` and owner UPDATE/DELETE/TRUNCATE are refused; unbalanced transactions rejected at COMMIT.
- `spec:lint` clean; `spec:drift` OK (65 operations, two-way); `sdk:check` up to date; `scan:secrets` 704 files, 0 hits; `db check` OK.
- Not run: browser E2E (no billing UI yet), load smoke, real PSP/tax checks (M03).

## F. Security, tenant isolation, billing, residency verification
- **Ledger integrity:** no runtime-role writes (tested as `nuzm_app` and `nuzm_worker`); the owner cannot UPDATE/DELETE/TRUNCATE (triggers); an unbalanced transaction is rejected at COMMIT and leaves nothing; `billing.post` refuses an organization other than the caller's context (and an unscoped caller).
- **Isolation:** a customer sees only postings on their own accounts; platform accounts and other organizations are invisible (RLS) and absent from API output; admin routes refuse tenant credentials (generated test).
- **Money:** every amount is an integer string end to end; floats, negatives, zero, exponents and overflow are rejected (property + table tests).
- **Atomicity:** posting, its audit row and its wallet-refresh outbox event commit together; a refused posting leaves none of them.
- Residency: not applicable to the ledger itself; `data_region` on usage arrives in S06.

## G. Human gates and live checks still needed
HG-02-01 (pricing/margin policy, approved price book v1) **BLOCKED** for production activation; D-23 (pricing policy/currencies), D-25 (credits/wallet policy, VAT treatment) OPEN; M01 BLOCKED items unchanged. Nothing here has been verified against a real PSP or tax authority (M03).

## H. Acceptance (S05 rows)
| Row | Status |
|---|---|
| Ledger accounts/transactions/postings, append-only, balanced, idempotent | PASS |
| Recipes: credit grant, wallet consume, adjustment/reversal, provider cost, usage charge | PASS (M03 recipes registered, intentionally 501) |
| Wallet projection via outbox consumer + drift test | PASS |
| Plans/versions immutable once published; entitlements; `resolve` | PASS |
| `GET /v1/billing/*` and `GET/POST/PATCH /v1/admin/billing/*` for ledger and plans | PASS |
| `POST /v1/admin/billing/adjustments` and `GET/POST /v1/admin/meters`, price books | NOT DONE here (S07 / S06) |
| Property tests, concurrency (no overdraw), cross-tenant ledger tests | PASS |
| Price summary in plan responses | NOT DONE (needs price books, S06) |
| Billing UIs (UI-M02-xx) | NOT DONE (S07) |

## I. Handoff and open decisions
- S06: `metering` schema, ingest, aggregation, price books and rating (rated usage will call `usageChargeWallet` for wallet-debit mode), provider cost capture via `providerCostAccrual`.
- S07: quotas/spend limits/approvals (four-eyes), `commerce.quotes`, the adjustments endpoint, billing UIs, M02 report.
- Owner decisions: confirm the spec-conflict resolution (docs/05 over the prompt) and the `org:read` permission for plan/entitlement reads; D-23/D-25 inputs.
