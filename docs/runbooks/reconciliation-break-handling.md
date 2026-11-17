# Runbook — Reconciliation and break handling (M03 S12a)

Audience: finance (run and resolve), compliance officers (read). API: `/v1/admin/billing/reconciliations` (admin realm; runs and resolutions need MFA step-up).
Tolerances are **proposals pending D-31** (finance): exact (0 minor units) for RC-01, RC-02, RC-05, RC-06; basis points for RC-03 and RC-04 (`FINREC_RC03_TOLERANCE_BPS`, `FINREC_RC04_TOLERANCE_BPS`, default 0).

## 1. The six checks
| Type | Compares | Typical breaks and what they mean |
|---|---|---|
| RC-01 | Payments and refunds the platform recorded vs the PSP settlement report | `missing_settlement` / `refund_missing_settlement` (we recorded money the PSP did not settle), `amount_mismatch`, `unknown_psp_line` (the PSP settled something we know nothing about). Needs a PSP adapter with a settlement report; **only the sandbox PSP has one today** (real PSP: D-10) |
| RC-02 | Ledger entries vs issued invoices and credit notes | `invoice_without_posting`, `receivable_mismatch`, `vat_mismatch`, `revenue_mismatch`, `posting_without_document` |
| RC-03 | Rated usage vs usage invoice lines | `unbilled_usage` (no invoice for the period), `missing_invoice_line`, `over_billed`, `under_billed` (outside tolerance), `line_without_usage` |
| RC-04 | Provider cost records vs ledger accruals, margin, and **provider bills when a bill source exists** | `cost_without_accrual`, `accrual_mismatch`, `unattributed_cost`, `negative_margin`; bill comparison is **skipped** (reported in the run summary) until the M05 adapters exist: **NOT VERIFIED live** |
| RC-05 | Issued documents vs their e-invoices (from the cutover date) and the counter chain | `no_einvoice`, `rejected`, `dead_letter`, `not_cleared_in_window`, `counter_gap`. Skipped when e-invoicing is off or there is no cutover date. **SIMULATED data, NOT VERIFIED vs ZATCA** |
| RC-06 | Wallet projection vs the sum of ledger 2100 postings; credited top-ups vs their ledger entries | `projection_drift`, `projection_missing`, `projection_orphan`, `topup_mismatch`. Run when the outbox is drained: a refresh in flight shows as a transient drift |

## 2. Running
- **Scheduled:** once a day for the previous UTC day, every type (`BILLING_SCHEDULER_INTERVAL_SECONDS` must be on, ADR-017). One scheduled run per type and day; the database refuses a second.
- **On demand:** `POST` with `{types[], periodFrom, periodTo}` (at most 400 days; not in the future) answers **202** with the queued runs; they run in the background. A second request for the same type and period while one is in progress is **409**.
- Results are **immutable**: a finished run never changes. To re-check after a fix, run again.

## 3. Handling a break
Break states: `open` → `assigned` → `resolved`. Every step is a resolution row (who, when, why), audited.
1. **Assign** (`action: assign`): take it. Repeating it changes nothing.
2. **Find the cause** with the keys in `details` (document numbers, amounts, ids). Do **not** edit documents, ledger rows, projections or counters directly: the database refuses most of it and the rest is a compliance incident.
3. **Resolve** with one of:
   - `adjustment`: link an **approved** adjustment (`POST /v1/admin/billing/adjustments`: one person requests, a *different* person approves; reversing entries only). It must belong to the break's organization. A pending adjustment is refused (409).
   - `accept` with a **note** that says why the variance is acceptable (for example a known rounding rule pending the tax advisor). Use sparingly: it is audited and visible in the run.
4. Resolved is final.

## 4. SLA
An unresolved break older than `FINREC_SLA_DAYS` (default 7 calendar days; docs/11 proposes 5 business days, D-31) raises one alert (audit event `finrec.break.sla_breached`) and is flagged `overSla` in the API.

## 5. When a run fails
A source that cannot be read (for example the PSP report) ends the run `failed` with a short reason; it is also immutable. Fix the source and run again. A failed run does not block a new one.
