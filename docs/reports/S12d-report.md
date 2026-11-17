# S12d report — Admin finance screens (M03 sprint 12, fourth part)

Status: **implemented and verified.** `pnpm verify:full` exited **0** on 2026-11-18 (§E) including the browser E2E in Arabic and English with axe. Everything below runs on the **sandbox PSP and the SIMULATED, synthetic-profile e-invoicing pipeline**: no screen result is verified against a real PSP or ZATCA. Committed on `claude/m03-s12d-admin-5fd165` (not pushed).

## A. Repository findings and assumptions
- **Earlier S12d state:** commit `d201e20` built UI-M03-15..21 but could not run the E2E (ports held by another session) and left UI-M03-13/14 unbuilt and UI-M03-15 partial because docs/04 had no admin read API for invoices, payments or refunds.
- **Decision for this session (instruction from the orchestrating session, not an owner decision):** add the minimum read-only API surface, **spec first** (CLAUDE.md §2 asks for owner approval of spec changes; that approval is still **pending** and is listed in §G and in the gate review). Four read operations, all `GET`, all `admin:billing:read`, admin realm, platform-scope SELECT, **every read audited**:
  - `GET /v1/admin/billing/invoices` (filters org, status, number prefix, einvoiceState, from/to, cursor) → `AdminInvoice` (number, org, buyer name and VAT, status, totals, paid, tax-review flag, e-invoice state/environment/uuid).
  - `GET /v1/admin/billing/payments` (filters org, invoiceId, status, from/to) → `AdminPayment` (provider account, amounts, captured, refunded, event count).
  - `GET /v1/admin/billing/payments/{id}/events` → stored PSP events, oldest first, **redacted** (whitelisted payload, provider payment reference masked to its last four characters, secret-looking keys dropped), with `duplicateCount` / `lastDuplicateAt`.
  - `GET /v1/admin/billing/refunds` (filters org, paymentId, status) → `AdminRefund`.
  No write path was added; refunds are still created only by the existing POST (step-up, Idempotency-Key). No invoice detail endpoint was added (the list carries what the screen needs); no payment detail endpoint either.
- **Duplicate-event indicator needed data that did not exist:** a duplicate webhook used to be dropped (`ON CONFLICT DO NOTHING`) with no trace. Migration **0312** (M03 range) adds `psp_events.duplicate_count` and `last_duplicate_at`; the webhook insert now counts a redelivery (`ON CONFLICT … DO UPDATE`, `xmax = 0` to tell a fresh row from a counted one) and still returns `duplicate` with no business effect. Events stored before 0312 show 0.
- **Compliance officers** hold `admin:billing:read` (docs/04 lets them read finance data), so they can open the three lists; nothing on them writes. Support cannot (403).
- **Real E2E finding:** the seeded E2E staff are `platform_admin`, which by design has **no** `admin:billing:manage`; refunds, run-now and dunning holds need `finance`. The test now grants `finance` to its two staff (test tooling, like the existing MFA elevation). No product change.
- **Real latent test defects found and fixed (test-only):** (1) `finrec/reports.int.spec.ts` bounded a day with a bare `::date` in the database session time zone while the report service bounds it in UTC, so five tie-out tests failed between 21:00 and 24:00 UTC (the full run at 01:24 +03 hit it); (2) my own fixture ids were random UUIDv4, so a newest-first assertion was flaky (now UUIDv7). Both are in the commit log.
- Earlier S12d assumptions stand: reconciliation schedule is read-only text (the API has no schedule resource); the reporting-window gauge is computed over the loaded page; the ZATCA one-time password is typed, sent once with an approval, never with a rejection, never stored; PRODUCTION is shown locked (HG-03-03).

## B. Plan and changed files
| Layer | Files |
|---|---|
| Spec | `spec/openapi/openapi.yaml` (4 operations, 8 schemas), `packages/sdk/src/schema.ts` (regenerated), `docs/04-unified-api-specification.md` (rows added, marked owner approval pending) |
| Migration | `packages/db/migrations/payments/0312__payments__psp_event_duplicates.sql` + `.down.sql` |
| API | `invoicing/internal/admin-invoice-read.service.ts`, `invoicing/admin-invoices.controller.ts`, `payments/internal/admin-payment-read.service.ts`, `payments/admin-payments.controller.ts`, `payments/admin-refunds.controller.ts` (GET added), module wiring, webhook counter in `payment.service.ts` |
| Admin UI | `billing/invoices`, `billing/payments`, `billing/payments/[id]`, `billing/refunds` (list added) pages; 2 new tabs; `lib/finance.ts` helpers; `RefundForm` pre-fill |
| i18n | 219 Arabic/English messages appended at the end of each block (`af.inv.*`, `af.pay.*`, `af.ref.list/f/col`, 2 tab names) |
| Tests | `payments/admin-reads.int.spec.ts` (8), admin unit tests (+5), `e2e/tests/05-admin-finance.spec.ts` (extended), screenshots `docs/reports/screenshots/{ar,en}/adminfin-*.png` |

Commits: `28bed5a` (API), `3ee8626` (format), `c62b419` (screens), `f8d681c` (E2E + screenshots), `95c32bd`, `a2e6367`, `3629202` (test-only fixes).

## C. Implemented screens
| UI | Screen | Status |
|---|---|---|
| UI-M03-13 | Invoices: cross-organization search, e-invoice badge/environment, tax-review flag, credit-note correction guidance | **PASS** (browser, ar+en, axe 0 violations, screenshots) — data **sandbox**; e-invoice states **SIMULATED, NOT VERIFIED vs ZATCA** |
| UI-M03-14 | Payments list; payment → redacted PSP events with duplicate-resend indicator; link to a pre-filled refund | **PASS** (browser, ar+en, axe, screenshots) on the **sandbox PSP**; the E2E event row is a database-inserted fixture (the mock's synchronous charge sends no webhook); real PSP events **NOT VERIFIED** |
| UI-M03-15 | Request refund (step-up, Idempotency-Key, integer minor units) + refund history with status | **PASS** (browser: refund created, history row with status/reason; sandbox PSP) |
| UI-M03-16 | Reconciliation runs, filters, run now | **PASS** (browser) — RC-01/05 on sandbox/simulated data |
| UI-M03-17 | Run detail: take, accept variance, link adjustment | **PASS** (browser; two seeded breaks worked) |
| UI-M03-18 | E-invoicing onboarding: SIMULATION banner, production locked, credentials by reference, four-eyes approval | **PASS** (browser) — **SIMULATED, NOT VERIFIED vs ZATCA** |
| UI-M03-19 | Submission queue, retry, DLQ, window gauge | **PARTIAL** — screen verified in a browser with an **empty queue**; no document is generated in the E2E profile (`ZATCA_GENERATE_FROM` unset), so retry and the gauge with data are covered by unit/integration tests only |
| UI-M03-20 | Dunning cases, hold/resume with reason | **PASS** (browser) |
| UI-M03-21 | Reports, chart, CSV, ledger-match badge | **PASS** (browser, CSV 200 and 422) |

All screens use `view()` for loading/empty/error/forbidden, are Arabic RTL + English, keyboard accessible (labelled controls, tables in focusable regions), and take every string from `packages/i18n`.

## D. Migrations and rollback
`0312__payments__psp_event_duplicates.sql`: two columns on `payments.psp_events` (counter default 0 with a CHECK, nullable timestamp). Rollback: dev-only `.down.sql` drops both columns; **production is forward-fix** (the counters are audit-relevant history). No data backfill; expand-only, old code ignores the columns.

## E. Tests run with actual results
`pnpm verify:full` → **exit 0** (2026-11-18, on commit `3629202`; the two earlier attempts failed on the test defects named in §A and were fixed, not skipped).

| Layer | Result |
|---|---|
| lint (eslint + prettier), typecheck, `pnpm build` | passed |
| `pnpm spec:lint` / `spec:drift` / `sdk:check` | clean / "121 implemented route(s) all declared (121 declared)" / "sdk schema is up to date" |
| `pnpm scan:secrets` / `zatca:guard` | "634 files, 8 rules, 0 hits" / "spec UNPINNED, generator 1b8d7337cbfe8bc3, 0 official file(s)" |
| Unit | api 301, admin **46**, web 49, i18n 9 (key/placeholder parity), ui 7, sdk 4, db 9, domain 6, worker 5, telemetry 3 — all passed |
| Browser E2E (`@nuzm/e2e`, Chrome, ar + en) | **10 passed (9.8 min)**: 01 customer, 02 admin, 03 billing, 04 payments, **05 admin finance** × 2 locales; axe (WCAG 2.0/2.1 A and AA) 0 violations per screen |
| `db:migrate` (incl. 0312), `db:test-rls` | applied; "db check OK: ownership + RLS rules hold" |
| Integration (real PostgreSQL) | db 43, platform 32, worker 8, api **580** (26 files, incl. the 8 new `admin-reads.int.spec.ts` tests) — all passed |

New API tests cover: access (finance, platform admin, compliance read; support, customer session, anonymous refused), filters and cursor paging, 422 on bad filters, LIKE metacharacters matched literally, redaction (no card/secret/token strings), the duplicate counter (one stored event, `duplicateCount: 2`, one ledger effect), 404 for unknown/malformed payment ids, and audit rows for every read. Existing payments/refunds suites (52) still pass with the webhook change.

## F. Security, tenant isolation, billing, residency
- **Tenant isolation:** the new reads are platform-scope SELECTs behind `admin:billing:read` in the admin realm (customer sessions get 401/403, tested). They add no org-scoped route, so the generated cross-tenant suite is unchanged (still green); the spec carries the `x-nuzm-platform-permission` and realm markers like every admin operation.
- **Audit:** `billing.admin_invoices.read`, `billing.admin_payments.read`, `billing.admin_payment_events.read`, `billing.admin_refunds.read` (filters and row counts, no personal data beyond ids). Reads of buyer legal names and VAT numbers are cross-organization personal/commercial data: **classification of these read surfaces for the M04 register is open** (§G).
- **PSP data:** no card data exists in the platform; the events view masks the provider reference and drops secret-looking keys; the E2E asserts the full reference is absent from the page.
- **Money:** amounts shown from API strings with `formatMinor`; the only parsing remains the refund amount to integer minor units. No money-writing code changed.
- **Residency:** unchanged; PSP/ZATCA transfers are still stubs (M04).

## G. Human gates and live checks still needed
- **Owner approval of the four new read operations and migration 0312** (spec precedence, CLAUDE.md §2); docs/04 lists them as "approval pending".
- Classification of buyer name / VAT number exposure on the admin list (M04 data inventory).
- **NOT VERIFIED:** any PSP event from a real provider, any ZATCA result, UI-M03-19 with a populated queue in a browser, Arabic copy review by a native speaker (new strings included).
- D-23 dunning timings, D-31 tolerances, HG-03-03, HG-03-04, ADR-017 as in the M03 report.

## H. Acceptance checklist
See §C. UI-M03-13/14/15/16/17/18/20/21 PASS in a browser on sandbox/simulated data; UI-M03-19 PARTIAL (empty queue only). No row is promoted by mocks beyond what the sandbox can show; nothing marked `LIVE-VERIFIED`.

## I. Next steps and open decisions
- Owner: approve (or change) the new admin read APIs and 0312; decide the quote-payment and credit-note PDF operations raised in S12c.
- M03 close: [M03 report](M03-report.md), [gate review](M03-gate-review.md) and [demo](../runbooks/demo-m03.md) are updated for this sprint; sign-off remains with the owner.
- Optional follow-ups (not built): invoice detail and payment detail endpoints; an E2E that seeds a generated e-invoice so the queue/gauge are exercised in a browser.
