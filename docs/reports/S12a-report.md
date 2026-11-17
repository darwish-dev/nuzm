# S12a report — Financial reconciliation, RC-01..RC-06 (M03 sprint 12, first part)

Status: implemented and verified against real PostgreSQL, the sandbox PSP and the synthetic e-invoice data (see §E). **Not committed.** S12 is split like the earlier sprints: **S12a** (this report: `finrec`), **S12b** revenue and finance reports, notifications and the remaining runbooks, **S12c/S12d** the billing screens (UI-M03-01..21), then the M03 report with the tax-advisor question list, the PSP/ZATCA live-status table and the gate review.

## A. Repository findings and assumptions
- **Tolerances are proposals pending D-31 (finance):** exact (0 minor units) for RC-01/02/05/06; basis points for RC-03 and RC-04 (`FINREC_RC03_TOLERANCE_BPS`, `FINREC_RC04_TOLERANCE_BPS`, default 0). The SLA for unresolved breaks is `FINREC_SLA_DAYS` = 7 **calendar** days (docs/11 proposes 5 business days; a Saudi business-day calendar needs the D-31 decision).
- **"202 + operation" is implemented as 202 + the queued runs.** The run resource *is* the operation (status queued → running → completed | failed, polled with `GET …/{id}`); `platform.operations` has no handler kinds yet (S02). The runs start in the background right after the response, and the scheduler picks up anything left.
- **RC-01 needs a settlement report.** `PspAdapter.listSettlements` is a new optional method; only the sandbox PSP implements it (with test hooks to make it disagree). Fee comparison ("amount/fee mismatch") is **not** done: fees are not modelled. With no adapter that has a report the run is `completed` with `skipped` in its summary. The charge date used to select payments is the intent's creation date (there is no captured-at column); a payment created just before midnight and settled after is judged in the day it was created.
- **RC-04 bills are NOT compared.** Provider bill sources arrive with the M05 adapters (`fetchBilling`); the run says so in its summary (`bills: skipped`) and **NOT VERIFIED live**. What RC-04 does check now: provider cost records vs their ledger accrual, unattributed cost and negative margin. The bill comparison itself is implemented and tested through an injected fixture source.
- **RC-05 only judges what is expected:** from the cutover date (`ZATCA_GENERATE_FROM`) and only when e-invoicing is on. It is **SIMULATED data, NOT VERIFIED vs ZATCA**. Counter gaps are covered by the chain check (the database already prevents them).
- **RC-06 can show transient drift:** the wallet projection is refreshed by the worker's outbox consumer; run it when the outbox is drained (said in the run summary and the runbook).
- **Resolutions link adjustments, they never create them:** `adjustment` needs an already **approved** adjustment of the break's organization (the M02 two-person flow); `accept` needs a note. Reconciliation never edits the ledger.
- **Placement:** `modules/finrec/` (docs/05 gives `finrec` its own module); the platform-scope allow-list now includes `modules/finrec/` (cross-organization reads). Tables are tenant-less, admin-scope only (listed in `spec/db/ownership.yaml`). Migration number **0340**.
- **Reads go through the platform scope, not the `nuzm_readonly_reporting` role.** docs/11 mentions "RLS-bypass read via reporting role" for reports (S12b); the runs here use the application's admin scope, audited. A separate reporting connection is a deployment item.

## B. Plan and changed files
- Migration `finrec/0340__finrec__reconciliation` (+down): `reconciliation_runs`, `reconciliation_items`, `reconciliation_resolutions`, the permission `admin:reports:read` (finance, platform admin; used from S12b); `spec/db/ownership.yaml`.
- Spec: 4 operations (**116** in total): list, run (202), get with breaks, resolutions; SDK regenerated.
- Code: `modules/finrec/{internal/reconcilers.ts,internal/finrec.service.ts,admin-reconciliations.controller.ts,finrec.module.ts,index.ts}`; `PspAdapter.listSettlements` and the mock's settlement log (`payments/internal/psp/*`, `registry.ts`); invoicing index exports (`verifyChain`, profile type); scheduler step (`scheduleDaily`, `processQueued`, `slaSweep`); `platform-scope.spec.ts`; `.env.example`.
- Tests: `finrec/finrec.int.spec.ts` (14 integration tests); `dunning.int.spec.ts` scheduler stub.
- Docs: `docs/runbooks/reconciliation-break-handling.md`.

## C. Implemented features, API
| Area | What exists |
|---|---|
| Framework | six reconcilers (pure functions over two sources, returning breaks), runs with a database-checked state machine, items with the break workflow open → assigned → resolved, append-only resolutions, immutable results, one run per (type, period) in progress (409), one scheduled run per type and day |
| RC-01 | captured and refunded money vs the PSP settlement report: `missing_settlement`, `amount_mismatch`, `refund_missing_settlement`, `refund_amount_mismatch`, `unknown_psp_line` |
| RC-02 | invoices and credit notes vs ledger postings (receivable, VAT, revenue) and postings without a document |
| RC-03 | latest rated usage per period vs usage invoice lines, with tolerance in basis points; unbilled / missing line / over / under / line without usage; zero-priced usage ignored |
| RC-04 | cost records vs ledger accrual, unattributed cost, negative margin; provider bills when a source exists (skipped and said so otherwise) |
| RC-05 | issued documents vs e-invoices (no e-invoice, rejected, dead letter, not cleared in the window) and the counter chain |
| RC-06 | wallet projection vs ledger 2100 (drift, missing, orphan) and credited top-ups vs ledger entries |
| API | `GET/POST /v1/admin/billing/reconciliations` (list; run → 202), `GET …/{id}` (run + breaks, filter by status, at most 500), `POST …/{id}/resolutions` (assign / adjustment / accept); finance and platform admin run and resolve (step-up), compliance officers read, support refused |
| Scheduling | `scheduleDaily` (previous UTC day, all types), `processQueued`, `slaSweep` in the billing scheduler tick |
| UI | none in this part (UI-M03-16/17 are S12c) |

## D. Migrations and rollback
`finrec/0340` as in §B; dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix (reconciliation results are financial control records, never dropped).

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run:
- lint, typecheck (19/19), build (11/11), `spec:lint`, `spec:drift` (**116** operations), `sdk:check`, `scan:secrets` 1,447 files / 0 hits, `zatca:guard` OK.
- Unit: api 301, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: 6 passed.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 552** (+18) = **635**.
- Highlights: a consistent platform (a payment, an invoice, a partial credit note and a wallet top-up) reconciles **clean on all six types**; each type then finds exactly the breaks planted (a settlement dropped, an amount altered by one minor unit, a phantom PSP line; an invoice without a ledger entry, wrong VAT, wrong receivable and revenue, an orphan posting; unbilled usage, a missing line, 1% over/under billing, a line without usage; cost without accrual, a 1-unit accrual mismatch, unattributed cost, negative margin and a bill-source fixture; projection drift, missing and orphan, and a credited top-up without ledger entry); a 1.5% tolerance hides the 1% differences but never a missing line; validation, 202, role checks, the 409 for a duplicate in-progress run, asynchronous completion; a failing source fails the run (immutable) without blocking a new one; the daily schedule creates six runs once; the break workflow (assign idempotent, note required, a pending adjustment refused, an adjustment of another organization refused, an approved one resolves, resolved is final); the SLA alert fires once; the database refuses edits to runs, items and resolutions.

## F. Security, tenant isolation, billing, residency verification
- Runs, items and resolutions are tenant-less and reachable only with the admin scope (forced RLS); every mutation is audited; finance cannot be bypassed by support; step-up on run and resolve.
- Reconciliation reads sources and writes only its own results; **it cannot change the ledger, invoices, payments or projections** (no code path does, and the grants do not allow it).
- The break `details` carry amounts, numbers and ids, no personal data; breaks are filterable by organization for the support of one customer.

## G. Human gates and live checks still needed
D-31 (tolerances and SLA calendar), D-10 / HG-03-02 (a real PSP settlement report for RC-01 is **NOT VERIFIED**), M05 (provider bills for RC-04, **NOT VERIFIED live**), HG-03-03 (RC-05 is on simulated e-invoice data), HG-04-01 (retention of reconciliation records).

## H. Acceptance (S12a rows)
| Row | Status |
|---|---|
| `finrec` schema and framework: runs, items, resolutions, immutability, 409 on a run in progress | PASS |
| RC-01 payments vs PSP settlements | PASS on the sandbox PSP; real PSP **NOT VERIFIED** (D-10); fees not compared |
| RC-02 ledger vs invoices and credit notes | PASS |
| RC-03 rated usage vs invoice lines (tolerance in bps) | PASS |
| RC-04 provider cost | PASS for cost vs ledger and margin; bills **skipped / NOT VERIFIED live** (M05) |
| RC-05 e-invoices vs invoices | PASS on simulated data; **NOT VERIFIED vs ZATCA** |
| RC-06 wallet projection | PASS |
| Scheduled runs and `POST …/reconciliations` (202) | PASS (run resource instead of a `platform.operations` record) |
| Break lifecycle and resolutions linked to approved adjustments | PASS |
| SLA alert for old breaks | PASS (calendar days; business days pending D-31) |
| UI-M03-16/17 | NOT DONE (S12c) |

## I. Handoff and open decisions
- **S12b:** `GET /v1/admin/billing/revenue-reports` (revenue, MRR/ARR, AR aging, VAT, margin, refunds and credit notes, dunning funnel, wallet liability; JSON and CSV; each equal to the ledger, tested; audited reads), notification kinds and texts still missing (invoice issued, card expiring), and the remaining runbooks.
- **Owner:** D-31 tolerances and calendar; whether the reporting role (`nuzm_readonly_reporting`) should serve the cross-organization reads.
