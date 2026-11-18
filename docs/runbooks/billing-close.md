# Runbook — billing close checklist (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED. The PSP is the sandbox only (D-10, HG-03-02), ZATCA is simulated (HG-03-03), price book and tax treatment are not approved (HG-02-01, HG-03-04): a close performed today is a rehearsal on fixtures and sandbox data, never a financial close. No endpoint or command that **locks** a period was found in `spec/openapi/openapi.yaml`; the sign-off below is a recorded human step. Finance owns the cadence (proposal: monthly, plus daily review during hypercare).

## Purpose
A repeatable checklist that proves, before finance signs a period, that usage was rated and invoiced, the ledger is balanced and tied to documents, payments tie to the PSP, provider costs are captured, and e-invoices are submitted.

## Trigger / alert
Period end (UTC calendar month; confirm with finance); the daily reconciliation schedule; the hypercare plan.

## Severity guidance (proposal)
A failed close step is not an incident by itself (SEV4 task). It becomes SEV2 when a ledger imbalance, an unbilled-usage total outside tolerance or an RC-05 gap affects customers, and SEV1 for any ledger imbalance (see `reconciliation-variance.md`).

## Preconditions / access
Finance role with MFA and step-up in the admin realm; a second person for approvals (adjustments are two-person); compliance officer read access. Scheduler running: `BILLING_SCHEDULER_INTERVAL_SECONDS` on (ADR-017): without ticks there are no renewals, dunning or e-invoice submissions.

## Steps (in order; record the result of each)
1. **Period definition.** Write down the UTC `periodFrom` and `periodTo` (at most 400 days; not in the future).
2. **Scheduler check.** Confirm subscription renewals and period close ran (`subscription-lifecycle.md` §3: no `pending_invoice` left over). Period close is idempotent by `source_key`; a re-run is safe.
3. **Usage.** Verify aggregates against raw events (`metering-replay.md`, `verify_aggregates`): 0 drift. Ingest of late events is by `eventId`; corrections are adjustment events.
4. **Run all reconciliations** for the period: `POST /v1/admin/billing/reconciliations` with `types: [RC-01, RC-02, RC-03, RC-04, RC-05, RC-06]`. Wait for the runs (202; poll `GET /v1/admin/billing/reconciliations`). Run RC-06 only when the outbox is drained (`queue-recovery.md`).
5. **Resolve every break** or record an `accept` with a reason (`reconciliation-break-handling.md` §3). Tolerances are D-31 proposals.
6. **Dunning.** `GET /v1/admin/billing/dunning`: no case is held without a reason; holds from an incident are released or justified (`PATCH /v1/admin/billing/dunning/{id}`).
7. **Reports.** `GET /v1/admin/billing/revenue-reports?report=revenue|vat|ar_aging|wallet|margin|refunds|dunning&from=&to=`: every figure that has a ledger counterpart must say it matches; investigate any mismatch before proceeding. `format=csv` for the file kept as evidence.
8. **E-invoices.** `GET /v1/admin/billing/zatca/submissions`: no `error` dead letters or `rejected` documents without a recorded decision, no window alerts (`zatca-backlog.md`).
9. **Refunds and credit notes** pending or failed (`GET /v1/admin/billing/refunds?status=pending`): each has an owner.
10. **Provider costs.** RC-04 result and provider bill capture (`provider-cost-capture.md`). Without a bill source the comparison is skipped: write NOT VERIFIED.
11. **Sign-off (human).** Finance lead records: period, run ids, accepted variances, open items, date. Store as evidence (`POST /v1/admin/compliance/evidence`, type `attestation`, needs a `controlId`: which control to use is to be confirmed with the compliance officer) and keep the CSVs. The agent never signs.

## Verification
All six RC runs for the period finished with 0 unresolved breaks (or each accepted with a note); revenue-report ledger ties show a match; no ledger imbalance; the audit trail contains the resolutions and the sign-off evidence.

## Escalation
Finance lead for any accept above the approval threshold (to be set); L2 on-call for scheduler or consumer faults; tax advisor (HG-03-04) for VAT or reseller-treatment questions; owner if a close cannot be completed by the planned date.

## Communication draft
Internal: EN: "Billing close for [period]: [complete / complete with open items]. Run ids: [ids]. Open items: [n] (owners: [roles]). Sign-off: [role], [date]." AR: "إقفال الفوترة للفترة [الفترة]: [مكتمل / مكتمل مع بنود مفتوحة]. معرّفات التشغيل: [المعرّفات]. البنود المفتوحة: [العدد] (المسؤولون: [الأدوار]). الاعتماد: [الدور]، [التاريخ]."
Customer-facing notices (corrected invoice, credit note): `invoice-correction.md` and `communications-drafts.md`.

## Records to keep
Run ids, resolution rows, adjustment ids, report CSVs with checksums, the sign-off attestation reference, e-invoice status extract, list of NOT VERIFIED items for the period. Do not store invoice content with personal data outside the system of record.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18).
