# S12b report — Revenue and finance reports, notices, runbooks (M03 sprint 12, second part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** Remaining for M03: **S12c/S12d** the billing screens (UI-M03-01..21, Arabic and English, with e2e tests and screenshots) and the M03 report with the tax-advisor question list, the PSP/ZATCA live-status table and the gate review.

## A. Repository findings and assumptions
- **Reports read the ledger wherever it knows the money.** Revenue, margin, AR aging, wallet liability and the VAT/refund ties come from `billing.ledger_postings`; documents (invoice lines, credit notes, refunds, subscriptions, dunning cases) are used only for breakdowns the ledger does not carry (VAT rate, counts, MRR). Every figure with a ledger counterpart says whether it **matches the ledger**, and the tests assert it against independent SQL.
- **Revenue is accounts 4100–4400 only.** Discounts (4900, debited by credit grants) are not netted; a test shows the 3,000 promotional credit is not subtracted.
- **A breakdown "by meter group" is not possible** from the ledger: invoice revenue postings carry no meter dimension. Recorded as a spec gap (the report says so in its notes). Revenue is by month, product (account) and billing entity.
- **MRR is as of now**, from the frozen price snapshots of active and past-due subscriptions (trialing, unpaid and cancelled are excluded); the from/to range is not used, and there is no history of status changes to rebuild a past month.
- **AR aging** is the ledger balance of account 1200 **per invoice** (issue, payments, credit notes) as of the date, bucketed by days past due. Money moved on receivables without an invoice (refunds, and any entry for an invoice that does not exist) is shown as `unattributed`, never hidden; the total equals the ledger receivable (`matchesLedger`).
- **VAT** is output tax from issued invoices less credit notes by month and rate, compared with the ledger VAT account (2300). A ledger VAT entry no document explains makes `matchesLedger` false (tested). Rate scope and exemptions are HG-03-04.
- **"RLS-bypass read via the reporting role"** (docs/11): the reports use the admin scope of the API (audited), not the `nuzm_readonly_reporting` connection (a deployment decision, as in S12a). **CSV is built in memory and sent as one file**, not streamed row by row; the limits (400 days, at most 5,000 AR rows) keep it small.
- **New permission use:** `admin:reports:read` (finance, platform admin) from migration 0340. Compliance officers can read reconciliations but **not** reports.
- **Notices.** Added `billing.invoice_issued` (to the organization's billing managers, after the commit, best effort, only when an invoice is really created, not on an idempotent re-issue) and `billing.card_expiring` (once per method, 30 days before the end of the expiry month or after it has passed; only the last four digits and the expiry month/year). The expiry notice is recorded on the method (`expiry_notified_at`, migration **0341**) because the notification table hides other users' rows from the producer and cannot be used to deduplicate. Notices are in-app by default; email follows the user's preferences and the mailer is still the development logger (M08/D-08). Texts exist in Arabic and English.
- **Runbooks:** `invoice-correction.md` (credit-note path) written; **`zatca-key-rotation.md` states that rotation is NOT IMPLEMENTED** and why (official rules and D-12 are needed) instead of describing a procedure that does not exist. Already written earlier: PSP incident, refund procedure, ZATCA onboarding, ZATCA queue stuck, reconciliation break handling, dunning, subscription lifecycle.

## B. Plan and changed files
- Migration `payments/0341__payments__method_expiry_notice` (+down): `expiry_notified_at`, the widened method guard, the work-list function `payments.methods_expiring`.
- Spec: 1 operation (**117** in total): `GET /v1/admin/billing/revenue-reports`; SDK regenerated.
- Code: `modules/finrec/internal/reports.service.ts` (8 reports, CSV), `admin-revenue-reports.controller.ts`, module wiring; `common/billing-managers.ts` (shared recipients; the billing module now uses it); `invoice.service.ts` (issued notice); `payments/internal/method.service.ts` (`notifyExpiring`); scheduler step `card_notices`; date validation hardened in finrec (a non-existent date such as 2026-02-30 is a 422, not a server error); `packages/i18n/src/messages.ts`; `.env.example` unchanged.
- Tests: `finrec/reports.int.spec.ts` (15 integration tests).
- Docs: `docs/runbooks/invoice-correction.md`, `docs/runbooks/zatca-key-rotation.md`.

## C. Implemented features, API
| Report | What it returns |
|---|---|
| `revenue` | ledger revenue by month, product (usage, subscription, domains, marketplace), account and billing entity; total and the ledger total |
| `mrr` | MRR and ARR (12 × MRR) by plan and currency, subscription count |
| `ar_aging` | per invoice outstanding from the ledger, bucket (current, 1–30, 31–60, 61–90, 90+, unattributed) as of `to`; totals per bucket; ledger receivable and `matchesLedger` |
| `vat` | output tax and taxable amount by month and rate (credit notes negative); ledger VAT, difference and `matchesLedger` |
| `margin` | revenue, provider cost accruals, margin and margin in basis points by month |
| `refunds` | refunds and credit notes by month with counts; their ledger totals and `matchesLedger` |
| `dunning` | funnel of cases opened in the period (reached each stage, recovered, cancelled, still open), recovery rate, amount still at risk |
| `wallet` | liability at the start and end and the net flows by ledger entry kind; `reconciles` (opening + flows = closing) |
API: `GET /v1/admin/billing/revenue-reports?report=…&from=…&to=…&format=json|csv` (admin realm, `admin:reports:read`; range defaults to the current month; at most 400 days; no future dates). CSV: RFC 4180 quoting, **text cells that look like formulas are neutralised** (negative amounts are not), file download headers. Every read is audited (`finrec.report.read`: report, range, format, rows).

## D. Migrations and rollback
`payments/0341` as in §B; dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run:
- lint, typecheck (19/19), build (11/11), `spec:lint`, `spec:drift` (**117** operations), `sdk:check`, `scan:secrets` 1,455 files / 0 hits, `zatca:guard` OK.
- Unit: api 301, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: 6 passed.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 568** (+16) = **651**.
- Highlights: a ledger built from aged invoices, a payment, a credit note, a refund, usage revenue, provider cost, wallet top-up/grant/consumption, subscriptions and dunning cases. **Each total equals an independent SQL sum of the ledger** (revenue, AR including its buckets and the ledger receivable, VAT, margin, refunds and credit notes, wallet opening + flows = closing, next day's opening = today's closing); the 61–90 / 31–60 / 1–30 buckets hold exactly the invoices that are 86 / 46 / 6 days overdue; a ledger VAT entry without a document is reported as a mismatch of exactly its amount; MRR and ARR at frozen prices with cancelled subscriptions excluded; the dunning funnel counts; finance and platform admins read, compliance officers and support do not, customers cannot; every read is audited; invalid report, format and ranges (including 2026-02-30) are 422; the CSV download equals the JSON rows; formula-injection protection and quoting; invoice-issued notices reach the owner and the billing admin but not the viewer, once; card-expiry notices are sent once per method, only for cards that expire soon or already expired, never for healthy or removed cards, with nothing but the last four digits and the expiry.

## F. Security, tenant isolation, billing, residency verification
- Reports cross organizations only through the admin realm with `admin:reports:read`; compliance officers and support are refused; the audit trail records who read what.
- Amounts are exact (bigint/strings), no floats; the only rounding is the margin in basis points (half-up, integer).
- CSV cells are protected against spreadsheet formula injection.
- Notices carry no personal data beyond the card's last four digits and expiry, to billing managers only.
- Residency: unchanged (M04).

## G. Human gates and live checks still needed
HG-03-04 (VAT rate scope and credit-note treatment shown in the VAT report), D-31 (reporting and reconciliation calendars), HG-02-01 (approved prices behind MRR and revenue), D-08/M08 (email delivery of notices), whether reports should use the reporting database role (deployment).

## H. Acceptance (S12b rows)
| Row | Status |
|---|---|
| Revenue reports (revenue, MRR/ARR, AR aging, VAT, margin, refunds, dunning, wallet) as JSON and CSV | PASS |
| Report totals equal ledger sums (test) | PASS |
| Reads audited; role-restricted | PASS |
| Revenue by meter group | NOT DONE (ledger has no meter dimension; spec gap) |
| Notifications: invoice issued, payment failed, dunning notices, card expiring (ar/en) | PASS for the texts and delivery (in-app); email delivery NOT VERIFIED (mailer is the dev logger); rendering in the UI is S12c |
| Runbooks: PSP incident, refund, ZATCA onboarding, ZATCA queue stuck, reconciliation break, invoice correction | PASS (written; not exercised in production) |
| Runbook: key rotation | NOT DONE (feature not built; the runbook says so) |
| Demo script and `M03-report.md` (tax-advisor list, live-status table) | NOT DONE (S12d) |
| UI-M03-01..21 | NOT DONE (S12c/S12d) |

## I. Handoff and open decisions
- **S12c/S12d:** the 21 screens (customer, agency and reseller portals, and the finance console) in Arabic (RTL) and English with loading, empty, error and forbidden states, keyboard access, axe, an e2e test and a screenshot each, using the existing API; then the M03 report (A–I per CLAUDE.md §10, the tax-advisor question list of every [VERIFY] item, the PSP and ZATCA live-status table), the demo script and the M03 gate review.
- **Owner:** the open decisions of the S10–S12 reports (D-31, D-25, plan-fee storage, refund listing endpoint, top-up refunds, the reporting role), and the official ZATCA documents.
