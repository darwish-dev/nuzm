# S08a report — Invoicing foundations: tax engine, tax profiles, gapless sequences (M03 sprint 1, part 1)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M03 continues with S08b (invoices, credit notes, invoice builder, state machine, ledger recipe, PDF), then S09 payments, S10 subscriptions/wallet/dunning/refunds, S11 ZATCA (sandbox/simulation), S12 reconciliation, reports, UI.

## A. Repository findings and assumptions
- **Gates:** M01 and M02 are signed with deferrals ([M02-gate-review](M02-gate-review.md)). M03's hard preconditions are open and handled as the prompt says: D-10 (PSP) → `psp-mock` only; D-11 (ZATCA approach) → `zatca-native` against a pinned spec; HG-03-01 → placeholder billing entity, no non-sandbox issuing; HG-03-02/-03/-04 PENDING; production PSP and ZATCA stay BLOCKED.
- **Sprint split (assumption):** S08 is split into S08a (this report) and S08b (invoices and the rest of S08) to keep reviews small.
- **Tax rates and entities are configuration:** docs/04 defines no endpoint (M03 §6), so they are written by migrations only; runtime roles have SELECT and no write grants. The seed rates are all `verify = true` ([VERIFY], HG-03-04).
- **Format rules are configuration:** VAT number (15 digits, starts and ends with 3), CR number (10 digits), postal code (5 digits), building number (4 digits) are working assumptions marked [VERIFY], overridable by environment.
- **Quote `taxEstimate`:** now `status: "computed"` from the engine (as the M03 prompt requires), with `rateCode`, `reviewRequired` and `reasons`; `provisional` stays in the enum for old quotes. The M02 mock `TaxEstimator` and `QUOTE_TAX_ESTIMATE_BPS` are removed.
- Classification: tax profile = `financial` + `personal`; the audit trail records presence flags only (tested). The classification annotation in `spec/db/ownership.yaml` stays with the DEF-M01-08 work (M04).

## B. Plan and changed files
- Migration `invoicing/0300` (+ `.down.sql`, dev only): `billing_entities`, `tax_rates` (exclusion constraint on overlapping periods), `tax_profiles`, `invoice_sequences`, `allocate_number()`; `spec/db/ownership.yaml` (three tenant-less tables).
- `apps/api/src/modules/invoicing`: `tax-engine.ts` (pure), `tax.service.ts`, `tax-profile.rules.ts` + `tax-profile.service.ts`, `sequence.service.ts`, `tax-profile.controller.ts`, module. `commerce` now uses `TaxService`.
- Spec: `getTaxProfile`, `putTaxProfile`, schemas, `taxEstimate` extended; SDK regenerated (85 operations). `.env.example`: `TAX_ROUNDING`. Runbook `tax-and-invoice-numbering.md`.

## C. Implemented features and API
Tax engine (effective-dated rate resolution with review flags, per-line rounding half-up/half-even, totals as the sum of lines), buyer tax profile with `GET/PUT /v1/billing/tax-profile` (ETag/If-Match, per-field validation errors), seller entity seed, gapless numbering, quotes priced with the engine.

## D. Migrations and rollback
`invoicing/0300` creates the schema and tables; dev-only down script. Production is forward-fix; numbering history is a legal record and is never dropped. It uses the `btree_gist` extension (trusted since PostgreSQL 13) for the no-overlap constraint.

## E. Tests run (actual)
- API unit: `tax-engine.spec.ts` **18** tests incl. **10,000 generated invoices** (Σlines + Σtax = total, 0 difference), reorder stability, rounding table, rate resolution.
- API integration (real PostgreSQL): `invoicing.int.spec.ts` **13** tests; the full API integration suite **16 files, 363 tests passed**. Highlights: **200 concurrent allocations give exactly 1..200**; a rolled-back issue leaves no gap; no runtime role can change rates, entities or counters; overlapping rate periods are refused; tax profile authz (viewer/developer refused), 428/412, field-level 422 errors, tenant isolation, no personal values in audit.
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **186 unit tests** (api 100, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **6 passed**; spec lint clean, spec drift OK (85 operations), `sdk:check` up to date, `scan:secrets` 800 files / 0 hits, `db check` OK; integration on real PostgreSQL **446** (db 43, platform 32, worker 8, api 363).
- Two test-infrastructure defects surfaced by the full runs and fixed: (1) an S05 assertion grepped the whole JSON response for the text `999`, which random ids and timestamps can contain (flaky; it now compares amounts); (2) parallel test files creating environments at once failed with "tuple concurrently updated" (cluster-wide `ALTER ROLE`/`GRANT`); `createEnv` now takes a cluster-wide advisory lock for its setup phase. API integration was run twice more after the fix, both green.

## F. Security, tenant isolation, billing, residency verification
RLS forced on every table; the tax profile is org-scoped (platform read only); platform configuration is read-only to runtime roles; the counter table is reachable only through the SECURITY DEFINER function. Residency: not applicable yet (invoice archive `data_region` arrives with invoices).

## G. Human gates and live checks still needed
HG-03-04 (tax advisor): every rate, scope, format and rounding rule above is a [VERIFY] item and goes on the advisor question list in the M03 report. HG-03-01 (real entity data) PENDING.

## H. Acceptance (S08a rows)
AC-M03-05 (totals over 10,000 generated invoices; gapless sequence under 200 concurrent issues): **PASS for the tax engine and the sequence allocator**; the invoice-level property (`Σ lines + tax = total` on stored invoices) completes with S08b.

## I. Handoff
S08b: `invoices`, `invoice_lines`, `credit_notes` (immutable once issued), invoice state machine, builder from `rated_usage` + subscription charges + order items + adjustments, ledger recipe "invoice issued", `invoice.issued` event, PDF (ar/en), period-close idempotency. Owner decisions: advisor answers on the [VERIFY] items; HG-03-01 entity data; whether the advisor wants `scope` per service type (currently unconfigured → review flag).
