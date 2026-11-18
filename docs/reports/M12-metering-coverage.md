# M12 metering coverage matrix (AC-M12-15)

Status: **COMPLETE AS A MATRIX, COVERAGE NOT COMPLETE.** Result: 0 PASS, 23 FAIL, 8 BLOCKED, 0 NOT VERIFIED across the 31 catalogue meters. Per M12 §10, missing coverage = FAIL; this report does not soften that.
Date: 2026-11-18. Branch: `claude/m12-hardening-4cc95e` (worktree). Prepared by reading code and tests only (see "Method"); no test suite was run for this report.

## 1. Scope, definitions, method

Source of the requirement: `docs/milestones/M12_enterprise_hardening_launch.md` §10 ("every meter in the catalogue has (a) producer, (b) emission test, (c) rating fixture, (d) invoice-line fixture, (e) provider-cost mapping where applicable (RC-04)"). Catalogue = `metering.meters` (31 rows; seeded by `packages/db/migrations/metering/0201__metering__usage_pipeline.sql:23-54`, read back from the dev DB, and asserted at 31 by `apps/api/src/modules/metering/metering.int.spec.ts:621`). Every catalogue meter belongs to one of the families named in §10, so the matrix has one row per meter and §4 rolls the rows up per family.

Evidence rules applied (strict):

| Column | Counts as evidence only if |
|---|---|
| (a) producer | Non-test code that builds a `UsageEvent` for exactly this meter id and hands it to `emitUsage()` (`packages/platform/src/metering.ts:63`). Quote pricers and price-book rows are not producers. |
| (b) emission test | A test that asserts on emitted events (or on the pure quantity function) **of this meter id**. A count of "any usage event for the resource", or an assertion that is always true, is recorded as WEAK and does not count. |
| (c) rating fixture | A test that rates this meter through `RatingService.rate()` (`apps/api/src/modules/metering/internal/rating.service.ts`) and asserts the amount. Quote-pricing tests (price-book items used to price a quote) and hand-inserted `metering.rated_usage` rows are listed for context but do not count. A test that only proves the meter is "unpriced" does not count. |
| (d) invoice-line fixture | A test where `InvoiceService.periodClose` (or an order-to-invoice path) produces an `invoicing.invoice_lines` row with this meter id and asserts it. Hand-inserted invoice lines used to test RC-03 are listed for context but do not count. |
| (e) provider-cost mapping | Code that writes `metering.provider_cost_records` or RC-04 bill lines for the provider cost behind this meter, wired into RC-04, plus a test. "n/a" needs a stated reason. Live vendor evidence is never claimed (CLAUDE.md §5/§6). |

Status values: PASS (a-d evidenced, and e where applicable), FAIL (any gap), BLOCKED (meter belongs to M09/M10/M11, not in this worktree; the milestone is named), NOT VERIFIED (evidence is only a mock/fixture where a live check is required). A row that has a gap and is also fixture-only is FAIL; the fixture-only point is noted in the cell.

Method (read-only): `grep`/`ls`/`sed` over `apps/`, `packages/`, `spec/`, `docs/`; `psql` against the dev DB (`metering.meters`, `billing.price_items`) to compare the catalogue with `docs/12`. No `git commit`, no installs, no test runs.

Path aliases used in the tables: `API` = `apps/api/src/modules`; `DOM` = `packages/domain/src`; `PLAT` = `packages/platform/src`; `MIG` = `packages/db/migrations`.

## 2. Shared evidence that applies to every row (pipeline, not per meter)

- Ingest fixtures (duplicate, out-of-order, late-after-close, skew, adjustment, forbidden dimension, unknown meter, 100 parallel ingests): `API/metering/metering.int.spec.ts:238-551` (describe `ingest fixtures (docs/12 §12)`, `aggregation: aggregate = sum(distinct events)`).
- Outbox to ingest relay: `apps/worker/src/metering-consumers.int.spec.ts:53` (describe `usage.recorded consumer`), implementation `apps/worker/src/metering-consumers.ts`.
- Rating engine (flat, graduated, volume, allowance + overage, re-rating, price-version change): `API/metering/metering.int.spec.ts:829-1029` (describe `rating`); seed (placeholder, DRAFT-NOT-APPROVED) price book has price items for **6 meters only**: `compute.vcpu_hours`, `compute.memory_gb_hours`, `network.egress_gb`, `storage.object_gb_months`, `email.transactional_messages`, `ai.credits_consumed` (`MIG/billing/0202__billing__price_books.sql:104-112`; dev DB `billing.price_items` shows the same six). The other 25 meters have no seed price, so a rated run leaves them in `unpriced` (see `metering.int.spec.ts:839`, which asserts exactly that for `hosting.disk_gb_months`).
- Invoice builder is meter-agnostic (`API/invoicing/internal/invoice.service.ts:315-355`, `collect()` groups rated usage by meter and writes `kind='usage'` lines with `meter_id`; zero-priced meters produce no line). The engine is therefore capable of any meter; what is missing is a per-meter fixture proving it (columns c and d).
- RC-03 (rated usage vs invoice lines) engine fixture with synthetic rated rows and synthetic invoice lines: `API/finrec/finrec.int.spec.ts:274-352` (test at `:309`). It is a reconciler test, not a rating or invoice-line fixture, so it is not credited in column c/d.
- RC-04 engine fixtures (cost vs ledger accrual, negative margin, bill comparison with a fixture bill source): `API/finrec/finrec.int.spec.ts:354-448` (tests at `:376`, `:400`).
- Scheduling: every producer below is registered as a periodic task, but the intervals are env-gated and the repository defers the production scheduler host to M12 ops (`API/domains/domains.module.ts:343-345` requires `DOMAINS_JOBS_ENABLED=true`; `API/data/internal/jobs.ts:44-46` returns 0 when `DATA_SCHEDULER_INTERVAL_SECONDS` is unset; `docs/reports/M07-report.md:68`). Producer coverage here means "code exists and is registered", not "running in an environment".

## 3. Matrix (one row per catalogue meter)

Legend for (b), (c), (d): file:line is the `it(...)` line (or the line of the assertion/fixture) I opened and read. WEAK = present but does not assert this meter's emission.

### compute.* (M05, in this worktree)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping (RC-04) | status |
|---|---|---|---|---|---|---|
| compute.vcpu_hours | `API/cloud/internal/metering-sampler.ts:61` (`emitUsage`; quantities from `DOM/cloud/compute-metering.ts:50`); periodic task `API/cloud/cloud.module.ts:80` | `API/cloud/compute-flow.int.spec.ts:995` (`the sampler emits exact hourly usage events once; reruns and duplicates add nothing; closing an interval emits the remainder`, asserts vcpu sum, ids unique, source/region); pure quantities `DOM/cloud/cloud.spec.ts:377,385,393,400,409,425` | `API/metering/metering.int.spec.ts:839` (flat 5, 12.5 h gives 63, half-up); also `API/billing/quotas-spend.int.spec.ts:380` | `API/invoicing/invoices.int.spec.ts:157` (line `['usage','compute.vcpu_hours','63']`; usage inserted at `:136-137`) | Capture: `API/cloud-vendors/provider-cost-capture.service.ts:88` (cost rows per provider line, attributed to the instance resource, SKU is free text `packages/adapters/costs/src/index.ts:91`, so mapping is per resource, not per meter). **RC-04 bill source `provider-cost-capture.service.ts:201` is not registered in `BillSourceRegistry`** (only registration in the repo is `API/domains/domains.module.ts:342`), so RC-04 does not compare compute bills in a running app. Tests: `API/cloud-vendors/cloud-vendors.int.spec.ts:102,160` (fixture bills; also NOT VERIFIED live, AC-M05-20 BLOCKED HG-05-01..03, `docs/reports/M05-report.md:41`) | FAIL (e: bill source unwired; also fixture-only) |
| compute.memory_gb_hours | same sampler `:61` (`DOM/cloud/compute-metering.ts:56`) | WEAK: pure quantity only `DOM/cloud/cloud.spec.ts:377` (12.00000000), `:400`; the sampler integration test `compute-flow.int.spec.ts:995` asserts only vcpu sums | NONE (seed price exists `0202:107`; no test rates it; `metering.int.spec.ts:376` only uses the meter for an adjustment rejection) | NONE | As compute.vcpu_hours (unwired bill source) | FAIL (c, d, e; b weak) |
| compute.disk_gb_months | same sampler `:61` (`DOM/cloud/compute-metering.ts:62`; accrual by actual month length) | WEAK: pure quantity only `DOM/cloud/cloud.spec.ts:377` (disk assertion at `:381`); not asserted in the integration test | NONE (no seed price; a flat price exists only in the compute quote kit `API/cloud/testing/compute-kit.ts:152`, quote pricing) | NONE | As compute.vcpu_hours | FAIL (c, d, e; b weak) |
| compute.snapshot_gb_months | NONE. Snapshots are created (`API/cloud/internal/provisioning.service.ts:878-880` inserts `compute.snapshots` with no size) but nothing emits | NONE | NONE | NONE | NONE (no snapshot cost record) | FAIL (a, b, c, d, e) |

### network.egress_gb (compute/hosting/storage per docs/12 §3)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| network.egress_gb | NONE. The compute sampler states it does not meter egress (`API/cloud/internal/metering-sampler.ts:17`: no per-resource traffic probe exists); hosting emits `hosting.bandwidth_gb` instead; storage emits `storage.egress_gb`; no non-test code references `network.egress_gb` | NONE | `API/metering/metering.int.spec.ts:839` (graduated: 1100 GB gives 1950); `API/billing/quotas-spend.int.spec.ts:213` | Not evidenced as a line: `API/invoicing/invoices.int.spec.ts:140` uses 3 GB inside the free tier, priced 0, so no line is produced (asserted at `:190`, `unpriced` empty). RC-03 synthetic only (`finrec.int.spec.ts:314`) | NONE (applicable: provider egress is billed; no capture) | FAIL (a, b, d, e) |

### hosting.* (M06, in this worktree)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| hosting.site_months | `API/hosting/internal/hosting-metering.ts:98` (daily loop, `meter === 'hosting.site_months'` branch `:84`); periodic `API/hosting/hosting.module.ts:416` | `API/hosting/hosting-s27.int.spec.ts:76` (fixture 1, complete UTC days, deterministic ids) and `:153` (replay: same ids, 0 aggregate diff) | NONE (quote pricing only: `API/hosting/internal/hosting-pricer.ts:48,72`; `finrec.int.spec.ts:317` is a hand-inserted rated row) | NONE | n/a: no separate provider bill for hosting; node infrastructure cost is carried by `compute.*` ("Node infrastructure cost reaches the platform org through M05 `compute.*` meters", `hosting-metering.ts:39`). Per-site cost allocation does not exist | FAIL (c, d) |
| hosting.disk_gb_months | `hosting-metering.ts:98` (`meter === 'hosting.disk_gb_months'` branch `:93`) | `hosting-s27.int.spec.ts:104` (fixture 2, GiB x day fraction), `:153` | NONE. `metering.int.spec.ts:839` asserts the meter is **unpriced** (no price item), which is the opposite of a rating fixture | NONE | n/a (as above) | FAIL (c, d) |
| hosting.bandwidth_gb | `hosting-metering.ts:166` (`bandwidth()`; invoked after each usage report `hosting.module.ts:412`) | `hosting-s27.int.spec.ts:131` (fixture 3: cumulative counter to deltas, new month, counter reset) | NONE | NONE | n/a (as above) | FAIL (c, d) |
| hosting.backup_gb_months | `hosting-metering.ts:98` (backup branch `:93`) | `hosting-s27.int.spec.ts:104` (asserts `hosting.backup_gb_months` events at `:124`), `:153` | NONE | NONE | n/a (as above) | FAIL (c, d) |

### storage.* (M08, in this worktree; object storage)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| storage.object_gb_months | `API/data/internal/storage-flow.ts:335` (built), `:353` (`emitUsage`); daily task `API/data/data.module.ts:312-315` | `API/data/storage.int.spec.ts:623` (`imports exact bytes, requests and egress; a figure the provider cannot report is unavailable…`; asserts quantity, unit, dimensions, source, idempotent re-run) | `API/metering/metering.int.spec.ts:839` (volume tier, 1001 gives 15015) | `API/invoicing/invoices.int.spec.ts:157` (line `['usage','storage.object_gb_months','15015']`) | NONE. Provider-cost capture for data/email is "not implemented" (`docs/reports/M08-report.md:92`); no `providerCost` use under `API/data` | FAIL (e) |
| storage.requests_k | `storage-flow.ts:342` (`op_class: 'all'`), `:353` | `storage.int.spec.ts:623` (asserts `2.50000000`) | NONE | NONE | NONE (as above) | FAIL (c, d, e) |
| storage.egress_gb | `storage-flow.ts:348`, `:353` | `storage.int.spec.ts:623` (asserts `5.00000000`; no event when the provider cannot report) | NONE | NONE | NONE (as above) | FAIL (c, d, e) |

### database.* and cache.instance_hours (M08)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| database.instance_hours | `API/data/internal/metering.ts:85` (`sampleHour`; meter chosen at `:78`); hourly task `API/data/internal/jobs.ts:35-38` | `API/data/databases.int.spec.ts:665` (`metering: hourly instance hours, daily storage and backup GiB-months are EXACT and deduped…`; asserts quantity 1, unit, region, source, dimensions, unique ids) | NONE (seed price only in the data quote harness `API/data/testing/data-harness.ts:25`, quote pricing) | NONE | NONE (provider-cost capture not implemented, `docs/reports/M08-report.md:92`) | FAIL (c, d, e) |
| database.storage_gb_months | `metering.ts:101-113` (`sampleDay`, accrual /30); daily task `jobs.ts:39-42` | `databases.int.spec.ts:665` (asserts `0.66666667` for 20 GB) | NONE | NONE | NONE | FAIL (c, d, e) |
| database.backup_gb_months | `metering.ts:131-145` | WEAK: `databases.int.spec.ts:665` asserts only `length >= 0` for this meter (`:693`), which is always true; no backup bytes are asserted | NONE | NONE | NONE | FAIL (b, c, d, e) |
| cache.instance_hours | `metering.ts:78,85` (Redis instances map to this meter; dimensions size and region only) | NONE. The Redis tests (`databases.int.spec.ts:747-795`) never call `sampleHour` and never read a `cache.instance_hours` event | NONE | NONE | NONE | FAIL (b, c, d, e) |

### email.* (M08)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| email.transactional_messages | `API/email/internal/message.service.ts:574` (`markAccepted`, only after provider acceptance; id keyed by message id) | `API/email/email.int.spec.ts:822` (`send: …ONE provider call, ONE meter event…`), `:882` (lost answer, no double send), `:978` (webhook x100: ONE meter) | `API/metering/metering.int.spec.ts:839` (allowance 1000 + 500 x 0.1 gives 50, rounding up) | `API/invoicing/invoices.int.spec.ts:157` (line `['usage','email.transactional_messages','50']`) | NONE (provider-cost capture not implemented, `docs/reports/M08-report.md:92`; email provider cost is applicable) | FAIL (e) |
| email.mailbox_months | `API/email/internal/mailbox.service.ts:853` (built), `:877` (`emitUsage`); daily task `API/email/email.module.ts:222-225` | `API/email/email.int.spec.ts:521` (`metering (AC-M08-09): one mailbox-month accrual per active mailbox per day…`) | NONE (quote price only: `data-harness.ts:31`) | NONE | NONE | FAIL (c, d, e) |
| email.mailbox_storage_gb_months | `mailbox.service.ts:874`, `:877` | `email.int.spec.ts:521` (exact from provider report; unreportable storage emits nothing) | NONE | NONE | NONE | FAIL (c, d, e) |

### domain.* and dns.zone_months (M07, in this worktree)

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| domain.registration_years | `API/domains/internal/orders.service.ts:1127-1132` (meter chosen), `:1169` (`emitUsage` in `finalize`) | WEAK: `API/domains/domains-orders.int.spec.ts:94` (and `:292` block) asserts exactly one `usage.recorded` row per domain via `meters()` (`:85`), without meter id or quantity | NONE (price item only in `API/domains/domains-quote.int.spec.ts:34`, quote pricing; basis `pass`) | NONE (order-line path for domain orders is not exercised by `invoices.int.spec.ts`, which only uses an `ai-credit` order, `:143`) | `API/domains/internal/orders.service.ts:1226` (`recordCost`, `meterOrSku: domain.<order type>` at `:1237`, line ref `domain-order:<id>`); RC-04 bill lines `API/domains/internal/cost-recon.service.ts:22` registered at `API/domains/domains.module.ts:342`; test `API/domains/domains-s31.int.spec.ts:368` (injected variances detected; **mock statement, NOT VERIFIED**, HG-07-01 / AC-M07-15 BLOCKED) | FAIL (b weak, c, d; e is fixture-only) |
| domain.renewal_years | `orders.service.ts:1127-1132`, `:1169` | `domains-orders.int.spec.ts:600` (asserts one `domain.renewal_years` event for the domain, at `:612-616`; replay adds none) | NONE | NONE | as above | FAIL (c, d; e is fixture-only) |
| domain.transfers | `orders.service.ts:1127-1132`, `:1169` (`transfer_in`, unit `transfer`, quantity 1) | NONE. The only transfer tests are the failure path (`API/domains/domains-webhooks.int.spec.ts:200`) and the consent gate (`:276`); a successful transfer-in is never finalised in a test | NONE | NONE | as above | FAIL (b, c, d; e is fixture-only) |
| dns.zone_months | `API/domains/internal/renewal.service.ts:251` (`accrueZoneMonths` `:223`, called from `runDaily` `:89`; gated by `DOMAINS_JOBS_ENABLED`) | `API/domains/domains-s31.int.spec.ts:349` (`dns.zone_months accrues once per zone per day (deterministic event id)`) | NONE | NONE | n/a: no provider charge is captured for zones; authoritative DNS hosting is undecided (D-36 OPEN, `docs/07-open-decisions-and-blockers.md:42`). Re-evaluate when D-36 closes | FAIL (c, d) |

### ai.*, builder.build_minutes, mobile.build_minutes, automation.* (M09/M10/M11, not in this worktree)

Nothing under `apps/`, `packages/` or `spec/` emits these meters (searched for every id; the only hits are the catalogue seed and price-book/test fixtures listed below). They cannot be verified here and are not counted as coverage.

| meter id | (a) producer | (b) emission test | (c) rating fixture | (d) invoice-line fixture | (e) provider-cost mapping | status |
|---|---|---|---|---|---|---|
| ai.tokens_input | NONE here (M09 AI gateway) | NONE | NONE | NONE | not assessed (model vendor cost, M09) | BLOCKED (M09) |
| ai.tokens_output | NONE here (M09) | NONE | NONE | NONE | not assessed (M09) | BLOCKED (M09) |
| ai.credits_consumed | NONE here (consumption is emitted by M09). Existing evidence is the credit **purchase** (quote kind `ai-credit`), a different path | NONE | Seed price `MIG/billing/0202__billing__price_books.sql:111`; RC-03 synthetic only | Order line (purchase, not consumption): `API/invoicing/invoices.int.spec.ts:157` (`['order','ai.credits_consumed','1000']`, order at `:143`); `API/commerce/commerce.int.spec.ts:114` | not assessed (M09) | BLOCKED (M09) |
| ai.sandbox_cpu_seconds | NONE here (M10 sandbox runner) | NONE | NONE | NONE | not assessed (M10) | BLOCKED (M10) |
| builder.build_minutes | NONE here (docs/12 §11 assigns M09 deploy/builder and M10 build worker) | NONE | NONE | NONE | not assessed | BLOCKED (M09/M10) |
| mobile.build_minutes | NONE here (M10 build worker) | NONE | NONE | NONE | not assessed (M10) | BLOCKED (M10) |
| automation.executions | NONE here (M11) | NONE | NONE | NONE | n/a expected (internal workflow engine, no provider bill; confirm in M11) | BLOCKED (M11) |
| automation.steps | NONE here (M11) | NONE | NONE | NONE | not assessed (connector-dependent, M11) | BLOCKED (M11) |

## 4. Roll-up per M12 §10 family

| family named in §10 | meters | PASS | FAIL | BLOCKED | NOT VERIFIED |
|---|---|---|---|---|---|
| compute.* | 4 | 0 | 4 | 0 | 0 |
| network.egress_gb | 1 | 0 | 1 | 0 | 0 |
| hosting.* | 4 | 0 | 4 | 0 | 0 |
| storage.* | 3 | 0 | 3 | 0 | 0 |
| database.* | 3 | 0 | 3 | 0 | 0 |
| cache.instance_hours | 1 | 0 | 1 | 0 | 0 |
| email.* | 3 | 0 | 3 | 0 | 0 |
| domain.* | 3 | 0 | 3 | 0 | 0 |
| dns.zone_months | 1 | 0 | 1 | 0 | 0 |
| ai.* | 4 | 0 | 0 | 4 | 0 |
| builder.build_minutes | 1 | 0 | 0 | 1 | 0 |
| mobile.build_minutes | 1 | 0 | 0 | 1 | 0 |
| automation.* | 2 | 0 | 0 | 2 | 0 |
| **Total** | **31** | **0** | **23** | **8** | **0** |

Column-level tallies for the 23 in-scope (M05..M08) meters (strict, as defined in §1):

| column | evidenced | gap |
|---|---|---|
| (a) producer | 21 | 2 (`compute.snapshot_gb_months`, `network.egress_gb`) |
| (b) emission test | 15 | 8 (`compute.memory_gb_hours` and `compute.disk_gb_months` pure-function only, `compute.snapshot_gb_months`, `network.egress_gb`, `database.backup_gb_months` assertion is vacuous, `cache.instance_hours`, `domain.registration_years` count only, `domain.transfers`) |
| (c) rating fixture | 4 (`compute.vcpu_hours`, `network.egress_gb`, `storage.object_gb_months`, `email.transactional_messages`) | 19 |
| (d) invoice-line fixture | 3 (`compute.vcpu_hours`, `storage.object_gb_months`, `email.transactional_messages`) | 20 |
| (e) provider-cost mapping | 3 have code (`domain.registration_years`, `domain.renewal_years`, `domain.transfers`; fixture-only, NOT VERIFIED live) | 15 gaps (4 compute: capture exists but bill source unwired; `network.egress_gb`; 3 storage; 3 database; `cache.instance_hours`; 3 email); 5 n/a with reason (4 `hosting.*`, `dns.zone_months`) |

## 5. Gaps to close, ordered by severity

1. **Billing correctness, no coverage at all (FAIL, highest):** `network.egress_gb` and `compute.snapshot_gb_months` have no producer. Customers incur provider cost for both and are billed for neither. Either build the producers (egress needs a provider traffic probe; snapshot needs a reported size) or record an approved DEFERRED entry and mark the price items unavailable; docs/12 §11 already allows "NOT VERIFIED" for egress only if provider-reported.
2. **RC-04 compute wiring:** register `ProviderCostCapture.billSource()` (`API/cloud-vendors/provider-cost-capture.service.ts:201`) in `BillSourceRegistry` so RC-04 actually compares compute bills (today only domains are registered, `API/domains/domains.module.ts:342`). Without this the RC-04 summary says "no provider bill source" for compute even when bills exist.
3. **RC-04 for M08 providers:** no provider-cost capture exists for object storage, managed database, cache or email (`docs/reports/M08-report.md:92`). Needs adapter `fetchBilling` mapping and a bill source, or an approved DEFERRED entry. Hosting and DNS are n/a with reasons (see rows; DNS depends on D-36).
4. **Missing per-meter rating and invoice-line fixtures (c, d):** 19 and 20 in-scope meters respectively. The engine is generic, so one table-driven integration test closes most of this: for every in-scope meter, seed a price item in a non-placeholder book, emit one event through the real producer (or `ingest`), run `RatingService.rate`, run `periodClose`, assert the invoice line (meter id, quantity, unit, net minor) and the RC-03 result. Domain meters (basis `pass`, priced at order) need an order-line variant (revenue account 4300 via `orderAccount`, `API/invoicing/internal/invoice.service.ts:84`).
5. **Missing or empty emission tests (b):** `cache.instance_hours` (no sampler assertion for Redis), `database.backup_gb_months` (assertion is `>= 0`), `domain.transfers` (successful transfer-in never finalised in a test), `domain.registration_years` (count only, no meter id or quantity), `compute.memory_gb_hours` and `compute.disk_gb_months` (sampler integration test asserts only vcpu).
6. **Unpriced meters in the seed price book:** 25 of 31 meters have no price item in the placeholder book (`MIG/billing/0202__billing__price_books.sql:104-112`); a rated period leaves their usage in `unpriced`. Prices are a finance/owner decision (HG-02-01); recorded here only because rating fixtures (gap 4) need a priced book.
7. **BLOCKED meters (M09/M10/M11):** 8 meters (`ai.*`, `builder.build_minutes`, `mobile.build_minutes`, `automation.*`) cannot be assessed until those branches merge. Re-run this matrix after the merge; do not mark AC-M12-15 PASS before then.
8. **Live evidence:** every provider-cost row that exists is fixture-only (compute: AC-M05-20 BLOCKED HG-05-01..03; domains: AC-M07-15 BLOCKED HG-07-01). They stay NOT VERIFIED until the owner grants the gates and evidence is recorded.
9. **Scheduler host:** producers are registered as periodic tasks but are env-gated; the M07 report defers the production scheduler host to M12 ops (`docs/reports/M07-report.md:68`). Confirm in staging that the samplers run, using the docs/12 §9 producer completeness check (`metering.gap`).

## 6. Conflicts and differences: catalogue in the database vs `docs/12` (recorded, not fixed)

Precedence (CLAUDE.md §2): `spec/` and accepted decisions outrank `docs/12`; nothing here was reconciled. Items marked "open decision" need an owner call.

1. **Names match.** `docs/12-metering-spec.md` §3 and `metering.meters` both have 31 ids; a diff of the two id lists is empty. No renamed meters.
2. **Basis.** `docs/12` §3 gives two values for `network.egress_gb`, `hosting.site_months`, `database.backup_gb_months`, `email.transactional_messages` ("usage / included", "usage / subscription"); the DB column allows one value and stores `usage` for all four.
3. **Aggregation window vs producer cadence.** The DB stores `hour` for `compute.disk_gb_months`, `storage.object_gb_months` and `database.storage_gb_months` (docs/12: "H→M"), but the storage and database producers emit **daily** events (`API/data/internal/storage-flow.ts:279`, `API/data/internal/metering.ts:91`). The DB window vocabulary (`hour|day|event`) cannot express "→M".
4. **Dimension `op_class` of `storage.requests_k`.** docs/12: `read/write`; producer emits `all` (`API/data/internal/storage-flow.ts:343`). The allow-list accepts any value, so ingest does not catch it.
5. **Producer ownership of `network.egress_gb`.** docs/12 §3 and §11 list compute/hosting/storage (M05+/M06) as sources; in code none emits it (hosting emits `hosting.bandwidth_gb`, storage emits `storage.egress_gb`, compute explicitly does not meter it).
6. **Emit helper location.** docs/12 §4 says `packages/domain/metering` exposes `emitUsage()`; the helper is `packages/platform/src/metering.ts:63`, imported as `@nuzm/platform`.
7. **Provider cost has no meter key.** docs/12 §8 defines `provider_cost_records.meter_or_sku` as free text. In code it holds the provider's description (compute, `packages/adapters/costs/src/index.ts:91`) or `domain.register|renewal|transfer_in` (`API/domains/internal/orders.service.ts:1237`), which are not the meter ids `domain.registration_years|renewal_years|transfers`. M12 §10 (e) asks for a "provider-cost mapping" per meter; there is no structured meter-to-SKU mapping in the schema. Open decision: define one, or accept per-resource attribution as the mapping.
8. **Accrual conventions differ across GiB-month and month meters.** Compute disk accrues per hour over the actual month length (`DOM/cloud/compute-metering.ts:62`); database, storage and email use a flat 1/30 per day (`API/data/internal/metering.ts:6`, `API/email/internal/mailbox.service.ts:853`, `API/domains/internal/renewal.service.ts:222` marks the DNS 1/30 as "proposal"); hosting uses an exact month split in nanos (`API/hosting/internal/hosting-metering.ts:14-17`). docs/12 only says "prorated". Open decision (D-23 billing units).
9. **Precision.** Hosting events carry 9 fractional digits (`hosting-metering.ts:9-10`), the usage table stores `numeric(24,8)` (`MIG/metering/0201__metering__usage_pipeline.sql:62`) and docs/12 §3 says 8 decimals. Not tested whether the 9th digit changes duplicate detection or monthly sums at ingest.
10. **Unit labels.** docs/12 uses display units (`vcpu·h`, `GiB·h`); the DB stores identifiers (`vcpu_hour`, `gib_hour`). Representation only.

## 7. Facts I could not verify

- Whether any listed test currently passes: none was run for this report (instruction: prefer reading). Test names and line numbers are from reading the files in this worktree.
- That the producers run in a deployed environment (env-gated schedulers; see §2).
- Live behaviour of any provider billing API or registrar statement (fixtures only; NOT VERIFIED).
- Whether the 9-digit hosting quantities survive ingest unchanged (item 9 above).
- Contents of M09, M10 and M11 branches (not in this worktree); the 8 BLOCKED rows are judged only on absence from this tree plus `docs/12` §11 ownership.
- Whether `compute.snapshot_gb_months` and `network.egress_gb` were deliberately deferred in an approved change-log entry; I found none in `docs/reports/M05-report.md`, `M06-report.md` or `M08-report.md`.
