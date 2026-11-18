# Runbook — provider cost capture and RC-04 (M05 S23)

Status: PROPOSAL. Fixture-driven only: **AC-M05-20 (RC-04 on real provider bills) is BLOCKED on HG-05-01..03**; the logic is proven against simulator bills.

## Flow
1. `ProviderCostCapture.capture(accountId, { from, to })` (code path, run by finance/ops or a scheduler): the account's adapter `fetchBilling` (Alibaba BSS `DescribeInstanceBill`, Huawei BSS usage details) → `ProviderCostService.record` (M02): rows in `metering.provider_cost_records` deduped on the provider line reference, ledger accrual Dr 5100 / Cr 2400 per line (idempotent). Only **closed** billing periods are captured: current-month provider data is "for reference only" and changes.
2. Contabo has no billing API: `importManual(accountId, csv, evidenceRef)` with the CSV `period,reference,description,amount,currency` and the uploaded bill's evidence reference (`source = bill_import`). Anything it would have to guess (float formats, exponents, negative amounts) is rejected with the line number.
3. Attribution: a bill line whose provider reference is one of our `cloud.resources` carries `resource_id` and `org_id`; otherwise it stays **unattributed** and RC-04 reports `unattributed_cost` (an orphan resource or a charge we did not cause) — treat as an orphan case (runbook `orphan-handling.md`).
4. RC-04 (`finrec`): `ProviderCostCapture.billSource()` is the `Sources.bills` implementation; its `lineRef`s equal the recorded `provider_line_ref`s, so RC-04 compares cost records, ledger accruals and the provider's own bill lines. Wiring `billSource()` into the finrec `Sources` provider is the **finrec owner PR** (one provider in `FinrecModule`; not done here to keep the M03 module untouched). Until wired RC-04 states `bills: skipped`.
5. Console: `GET /v1/admin/provider-costs` (records + totals per currency), UI-M05-14; margin view: M02 `ProviderCostService.margin()` (`metering.v_margin`).

## Money rules
Provider currency, integer minor units, no floats. Vendor amounts are major-unit JSON numbers whose minor units are **NOT DOCUMENTED**: 2 digits are assumed (ISO 4217 for the documented currencies CNY/USD/EUR), prices round **up**, bills round to 2 decimals. The SAR conversion rate is recorded in `evidence_ref` (`fx:USD/SAR=3.75@2026-11-01`) because the table has no FX column (open item SI-M05-8: owner PR to M02 if a column is wanted).
