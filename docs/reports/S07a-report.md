# S07a report — Usage API, quotas, spending limits, spend approvals (M02 sprint 3, part 1)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M02 continues with S07b (commerce quotes/orders/authorizations, adjustments endpoint) and S07c (billing UIs, demo, M02 report).

## A. Repository findings and assumptions
- **Sprint split (assumption):** S07 as written (quotas, spend, quotes, adjustments, 16 UIs) is too large for one reviewable step; S07a covers APIs of usage, quotas, spending limits and approvals.
- **Meter group vs meter (spec gap):** entitlements limit a "meter group" (`compute`, `storage`) but a group mixes units. A group is measured by exactly one meter via `billing.quota_meters` (placeholder mapping for 5 groups). Unmapped groups are reported `measured: false`, never as ok.
- **Raw events permission:** docs/04 (`usage:events:read`: owner, admin, billing_admin) was followed over the M02 prompt's "debug flag only". The platform-wide view for finance/support under the same path is not implemented.
- **Project attribution:** `usage_aggregates` and `rated_usage` carry no project; `GET /v1/usage` has no project filter and project caps see approved spend only until M05 provides resource inventory.
- **Cap below spend:** docs/04 says "422 cap below current month spend needs approval". Implemented as 422 `spend_approval_required` for a new or lowered cap; keeping or raising a cap is always allowed so approved overspend cannot lock the limit.
- **Approvers:** members whose role has `billing:manage` (owner, admin, billing_admin). docs/04 names owner and billing_admin; `admin` also holds `billing:manage` in the M01 role matrix.
- New error codes `quota_exceeded` and `spend_approval_required` (both 422), registered in code and `spec/openapi/errors.yaml`.

## B. Plan and changed files
- Migration `billing/0203` (+ `.down.sql`): permissions `usage:read`, `spend:request`; `quota_meters`, `quotas`, `spending_limits`, `spend_approvals`; functions `effective_limits`, `evaluate_quotas`; approval guard triggers. `spec/db/ownership.yaml` (`quota_meters` tenant-less).
- `apps/api/src/modules/billing`: `quota.service.ts`, `spend.service.ts`, `billing-spend.controller.ts`, `quotas.controller.ts`, module wiring. `apps/api/src/modules/metering`: `usage.service.ts`, `usage.controller.ts`; ingest now re-evaluates quotas after aggregation. `common/etag.ts`.
- Spec: 9 operations (`listUsage`, `getUsageSummary`, `listUsageEvents`, `getQuotas`, `listSpendingLimits`, `putSpendingLimit`, `requestSpendApproval`, `listSpendApprovals`, `decideSpendApproval`), tag `usage`, schemas; SDK regenerated.
- Tests: `quotas-spend.int.spec.ts` (28); cross-tenant suite got an approval fixture and a valid decision body. Runbook `quotas-and-spend-approvals.md`; `.env.example` `SPEND_APPROVAL_TTL_HOURS`.

## C. Implemented features and API
| Area | What exists |
|---|---|
| Usage | `GET /v1/usage` (day/hour/month roll-up, filters, keyset cursor, 366-day window, `dataRegion`), `GET /v1/usage/summary` (per meter, rated amount/allowance when rated), `GET /v1/usage/events` (raw, `usage:events:read`, rate limited) |
| Quotas | `GET /v1/quotas`; `QuotaService.check/assertAllowed` for callers; threshold audit + in-app notification once per threshold |
| Spending limits | `GET/PUT /v1/billing/spending-limits` with ETag/If-Match (428/412) |
| Spend approvals | `POST/GET /v1/billing/spend-approvals`, `POST .../{id}/decision` (step-up, no impersonation, no API key); four-eyes by org threshold; expiry; one open request per subject; final decisions |
| Enforcement API | `SpendService.evaluate/assertAllowed` (used by quotes in S07b) |

## D. Migrations and rollback
`billing/0203` creates 4 tables, 2 functions, guard triggers, RLS (forced; platform read policy) and grants. `.down.sql` is dev/staging only; spend approvals are an approval record and are never dropped in production (forward fix).

## E. Tests run (actual)
- `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts` (full API integration, real PostgreSQL): **14 files, 321 tests passed** (28 new in `quotas-spend`, 7 new generated cross-tenant cases). Spec lint clean; spec drift OK (**80** operations); `sdk:check` up to date; `db check` OK.
- Highlights: soft quota announces 80 % and 100 % once each to billing managers only; hard quota denies only new consumption while existing usage stays visible; SQL limit resolution equals `EntitlementService.resolve`; four-eyes enforced in the service and by a table constraint; decided approvals cannot be updated, deleted or truncated; cap edit concurrency (428/412); injection attempts in filters rejected; org B sees none of org A's usage, quotas, limits or approvals.
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line; two earlier runs of this sprint stopped at the lint step because the hand-edited OpenAPI file needed Prettier formatting, fixed). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **135 unit tests** (api 82, i18n 9, db 9, ui 7, domain 6, web 5, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **4 passed**; spec lint clean, spec drift OK (80 operations), `sdk:check` up to date, `scan:secrets` 744 files / 0 hits, `db check` OK; integration on real PostgreSQL **404** (db 43, platform 32, worker 8, api 321).

## F. Security, tenant isolation, billing, residency verification
- RLS on `quotas`, `spending_limits`, `spend_approvals` (forced, org-scoped, platform read only); `evaluate_quotas` refuses an organization other than the caller's context; cross-tenant generated tests cover every new id route.
- Money as integer-minor strings end to end; floats, negatives, exponents refused. Approvals never leave `pending` except to one final decision.
- Residency: usage points expose `dataRegion` (placeholder tag `sa-pending`); no new personal data.

## G. Human gates and live checks still needed
HG-02-01 (approved limits/prices) BLOCKED; D-23/D-25 OPEN; step-up uses the dev IdP session MFA flag only (real MFA flow verified in M01 tests, not against a production IdP).

## H. Acceptance (S07a rows)
| Row | Status |
|---|---|
| Quota soft notifies / hard restricts new only | PASS |
| Spend cap needs approval; four-eyes enforced; requester cannot self-approve | PASS (service + API level; quote path in S07b) |
| Usage, quotas, limits, approvals APIs with cross-tenant tests | PASS |
| `GET /v1/billing/balance` committed spend and credits fields | NOT DONE |
| Spend alert-threshold notifications; quota sweeper for worker-ingested usage | NOT DONE |
| Platform-wide raw events view (finance/support); project filter on usage | NOT DONE |
| Export CSV, UIs UI-M02-01..09 | NOT DONE (S07c) |

## I. Handoff and open decisions
- S07b: `commerce` schema (quotes immutable after issue, orders, authorizations), `POST/GET /v1/quotes` with `QuotePricer` registry calling `SpendService.assertAllowed` and `QuotaService.assertAllowed`, `POST /v1/admin/billing/adjustments` (four-eyes). S07c: UIs, demo, M02 report.
- Owner decisions: confirm `admin` as an approver; quota-meter mapping per group; whether a quota sweeper belongs in the worker (needs notification delivery there).
