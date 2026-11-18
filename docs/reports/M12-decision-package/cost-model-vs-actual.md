# Cost model vs actual provider bills (M12 decision package)

Prepared by the agent 2026-11-18. **No real provider bills exist.** No Alibaba, Huawei, Contabo, registrar, data, storage or email account or credential exists in this project, so no real provider cost has ever been captured. **RC-04 live (reconciliation of provider bills against cost records and ledger accruals) = BLOCKED** (HG-05-01, HG-05-02, HG-05-03 for compute; HG-07-01 for registrars; HG-08-xx for data/email; also AC-M12-13). The comparison "model vs actual" requested by the M12 prompt therefore cannot be made. This file states what the cost model and estimates are and where provider costs would be captured. It contains no recommendation to launch.

## Status

| Item | Status | Source |
|---|---|---|
| Actual provider bills (any provider) | BLOCKED (HG-05-01..03, HG-07-01, HG-08-01..04) | `M05-gate-review.md`; `M07-report.md` AC-M07-15; `M08-report.md` AC-M08-14 |
| RC-04 on real bills | BLOCKED | `M03-report.md` AC-M03-26; `M05-report.md` AC-M05-20; `M02-report.md` AC-M02-16; register BR-019, BR-041, BR-061, BR-088, BR-104, BR-116 |
| RC-04 logic on fixtures | PASS (fixtures only; NOT VERIFIED live) | `M05-report.md` AC-M05-20 (`cloud-vendors.int.spec.ts`); `M07-report.md` AC-M07-10 (mock) |
| Approved price book and margin policy | BLOCKED (HG-02-01; D-23, D-25 OPEN) | `M02-report.md` AC-M02-14; the seeded `default` price book is a placeholder marked DRAFT-NOT-APPROVED (`docs/runbooks/pricebook-release.md`) |
| Variance tolerance for RC-04 | OPEN (D-31) | `docs/07` |
| Real exchange rates / FX policy | Not decided; SAR conversion rate is recorded only as text in `evidence_ref` (`fx:USD/SAR=3.75@2026-11-01` is the documented format example, not a rate source) | `docs/runbooks/provider-cost-capture.md`; SI-M05-8 |

## The cost model, as built (from the milestone reports)

**M02 (money core).** Cost side: `metering.provider_cost_records` hold provider cost lines; the ledger accrues them as Dr 5100 / Cr 2400 per line (idempotent). Provider cost and the platform's margin view (`metering.v_margin`, service `ProviderCostService.margin()`) exist. There is no HTTP import endpoint for provider costs in docs/04 (UI-M02-16 deferred, DEF-M02-03). The customer price comes from the price book (M02 rating); no price means no offer.

**M05 (compute).** Adapters can fetch billing where the vendor documents it: Alibaba BSS `DescribeInstanceBill` and Huawei BSS usage details, through `ProviderCostCapture.capture(accountId, {from, to})`, closed billing periods only (current-month provider data is "for reference only"). Contabo has no billing API: bills are imported manually as CSV (`period,reference,description,amount,currency`) with an evidence reference (`importManual`, `source = bill_import`). A bill line whose provider reference matches a `cloud.resources` row is attributed to an organization and resource; otherwise it stays unattributed and RC-04 reports `unattributed_cost`. Compute customer price requires a price for each of the meters `compute.vcpu_hours` (730 h/month is a PROPOSAL), `compute.memory_gb_hours`, `compute.disk_gb_months`; otherwise the plan has no Nuzm price and is hidden (S17 report). Vendor amounts are major-unit JSON numbers whose minor units are NOT DOCUMENTED: 2 digits assumed, prices round up, bills round to 2 decimals. The wiring of M05's bill source into the finrec `Sources` provider is an owner PR and is not done (RC-04 reports `bills: skipped` until then). Console: `GET /v1/admin/provider-costs`, UI-M05-14.

**M06 (hosting).** Hosting quotes are priced from the price book; placeholder plan prices are never quoted. Hosting meters (`hosting.site_months`, `hosting.disk_gb_months`, `hosting.bandwidth_gb`, `hosting.backup_gb_months`) emit through the central pipeline with 0-diff replay on fixtures. No M06 report describes hosting-specific provider cost capture; nodes depend on M05 compute instances, and no real node exists, so there is no hosting cost data.

**M07 (domains).** Registrar statements are compared as RC-04 bill lines through `BillSourceRegistry`; markup defaults to 0 pending D-23; FX and markup arithmetic is exact with rounding up; funds are reserved before the registrar is called and released by a reversing entry on failure. Real statements are BLOCKED (HG-07-01, D-31).

**M08 (data, storage, email).** Quotes come from the price book only. **Provider-cost capture to `metering.provider_cost_records` is not implemented** for these services (M08 report §I; BRX-016). Retention periods and the usage tolerance (1 % proposal) are D-34 / D-31 proposals.

## Where provider costs are captured (for the owner)

| Provider family | Capture path | Runbook / file | Live today |
|---|---|---|---|
| Alibaba, Huawei compute | `ProviderCostCapture.capture` (API fetch, closed periods) | `docs/runbooks/provider-cost-capture.md` | No (no account) |
| Contabo compute | Manual CSV import with evidence reference | same | No (no account) |
| Registrars | Statement to RC-04 `BillSourceRegistry` | `M07-m05-interface-assumptions.md` §9 | No (mock statement only) |
| Data, storage, email providers | Not implemented | `M08-report.md` §I | No |
| Model providers (M09), sandbox/mobile build capacity (M10) | Not assessed here | Those milestones are in flight on other branches | Unknown |

## What the owner would need to supply to complete this document

A table comparing, per provider and period: modelled cost (the estimate used when quoting), captured bill amount, variance in minor units and percent, tolerance (D-31), and RC-04 result. All inputs require real provider bills (the HG gates above) and an approved price book (HG-02-01). Until then every cell would be empty; the agent does not populate it with estimates or extrapolations.

| Provider | Period | Modelled cost | Actual bill | Variance | Tolerance (D-31) | RC-04 result | Evidence ref |
|---|---|---|---|---|---|---|---|
| (none; no real bills exist) | | | | | | | |

Related runbooks: `docs/runbooks/reconciliation-variance.md`, `reconciliation-break-handling.md`, `billing-close.md`, `orphan-handling.md`. Related register rows: BR-018, BR-019, BR-063, BR-088, BR-104, BR-116.
