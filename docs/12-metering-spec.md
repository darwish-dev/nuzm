# Nuzm — Centralized Usage Metering Specification (draft)

Owner: **M02** (`metering` schema, S06–S07). Producers emit from M05–M11. Consumers: rating → ledger/invoicing (M03), quotas (M02), usage UI, finrec RC-03/RC-04 (M03).

## 1. Purpose and rules
1. **One pipeline.** No module computes bills or writes usage tables directly; modules emit `usage.recorded` events (`MeteringIngestService`).
2. Billable and quota-relevant facts only; operational telemetry stays in observability.
3. Exactly-once *effect* via `eventId` dedupe (at-least-once delivery).
4. Usage is tenant-scoped, residency-tagged, auditable, replayable.
5. Cost side (what providers charge Nuzm) is captured separately in `metering.provider_cost_records` to compute margin; never shown to customers.

## 2. Event schema (`spec/events/usage.recorded.json`, `metering.usage_events`, append-only)
| Field | Type | Notes |
|---|---|---|
| `eventId` | uuid | Deterministic from business key: `uuidv5(ns, org|meter|resource|window_start|source_seq)`; dedupe key (unique with `org_id`) |
| `orgId` | uuid | From producer context (never from user input) |
| `meterId` | text | Must exist in `metering.meters` (catalogue §3) |
| `quantity` | numeric(24,8) ≥ 0 | In meter unit; corrections use negative-quantity **adjustment** events with `adjustsEventId` |
| `unit` | text | Must equal meter unit |
| `resourceId` / `projectId` / `environmentId` | uuid? | Resource id is `cloud.resources.id` or owning-module id |
| `windowStart`/`windowEnd` | timestamptz | Interval the quantity covers (point events: equal) |
| `occurredAt` | timestamptz | Producer clock; ingest also stores `receivedAt` |
| `source` | text | `module@milestone`, e.g. `compute@M05` |
| `dimensions` | jsonb | meter-specific (region, plan, model id, tld…); allow-listed keys per meter |
| `dataRegion` | text | Residency tag |
| `schemaVersion` | int | |
| `actingOrgId` | uuid? | Agency/reseller acting org (attribution, not billing) |
| `providerEventId` | text? | Upstream vendor event/line id when the event derives from a provider record; used for dedupe and RC-04 matching (adopted from execution-pack PDF) |
| `tags` | jsonb | Free-form non-billing labels (never used for rating or authorization) |
| `pricingVersion` | uuid? | Null at ingest; set on the `rated_usage` row to the `price_book_versions.id` used (the event itself stays immutable) |
| `receivedAt` | timestamptz | Ingest time (same meaning as `ingestedAt` in the PDF) |

## 3. Meter catalogue (`metering.meters`, seeded by migration, extended only via `POST /v1/admin/meters`)
Aggregation: `sum` unless noted; windows: `H` hourly, `D` daily, `M` monthly closing. Billing basis: `usage` (pay-as-you-go), `included` (counts against plan allowance then overage), `pass` (pass-through at cost+rule).
| Meter id | Unit | Dimensions | Source (milestone) | Aggregation window | Basis |
|---|---|---|---|---|---|
| compute.vcpu_hours | vcpu·h | provider(hidden), region, plan | compute (M05) | H | usage |
| compute.memory_gb_hours | GiB·h | region, plan | compute (M05) | H | usage |
| compute.disk_gb_months | GiB·month (prorated hourly) | region, disk_type | compute (M05) | H→M | usage |
| compute.snapshot_gb_months | GiB·month | region | compute (M05) | D→M | usage |
| network.egress_gb | GB | region, resource_kind | compute/hosting/storage (M05+) | D | usage / included |
| hosting.site_months | site·month (prorated daily) | plan | hosting (M06) | D→M | usage / subscription |
| hosting.disk_gb_months | GiB·month | plan | hosting (M06) | D→M | included |
| hosting.bandwidth_gb | GB | plan | hosting (M06) | D | included |
| hosting.backup_gb_months | GiB·month | plan | hosting (M06) | D→M | included |
| storage.object_gb_months | GiB·month | region, class | storage (M08) | H→M | usage |
| storage.requests_k | thousand requests | op_class(read/write) | storage (M08) | D | usage |
| storage.egress_gb | GB | region | storage (M08) | D | usage |
| database.instance_hours | instance·h | engine, size, region | data (M08) | H | usage |
| database.storage_gb_months | GiB·month | engine, region | data (M08) | H→M | usage |
| database.backup_gb_months | GiB·month | engine | data (M08) | D→M | usage / included |
| cache.instance_hours | instance·h | size, region | data (M08) | H | usage |
| email.transactional_messages | message | provider(hidden), stream | email (M08) | D | usage / included |
| email.mailbox_months | mailbox·month | plan | email (M08) | D→M | subscription |
| email.mailbox_storage_gb_months | GiB·month | plan | email (M08) | D→M | included |
| domain.registration_years | year | tld, registrar(hidden) | domains (M07) | event | pass (price at order) |
| domain.renewal_years | year | tld | domains (M07) | event | pass |
| domain.transfers | transfer | tld | domains (M07) | event | pass |
| dns.zone_months | zone·month | | domains (M07) | D→M | included |
| ai.tokens_input | token | model_id, region | ai (M09) | event→H | usage (converted to credits) |
| ai.tokens_output | token | model_id, region | ai (M09) | event→H | usage |
| ai.credits_consumed | credit | run_kind | ai (M09) | event→H | usage (wallet-like) |
| ai.sandbox_cpu_seconds | cpu·s | sandbox_class | builder/ai (M10) | H | usage |
| builder.build_minutes | minute | project_type | deploy/builder (M09/M10) | D | included |
| mobile.build_minutes | minute | platform(android/ios) | mobile (M10) | D | usage |
| automation.executions | execution | | automation (M11) | D | included |
| automation.steps | step | connector | automation (M11) | D | included |
Unit conventions: GB = 10^9 bytes and GiB = 2^30 are distinct; each meter fixes one and the unit is stored (decision D-23 may change billing units before M02 freeze). Fractions: store to 8 decimals; rating rounds per price item `rounding` rule.

## 4. Pipeline
```
producer tx: state change + outbox(usage.recorded)  ──►  relay  ──►  MeteringIngestService
   ingest: validate (meter exists, unit, org active, dimensions allow-list, residency tag present)
        └► insert usage_events (ON CONFLICT (org_id,event_id) DO NOTHING; returns duplicate flag)
        └► late/out-of-order policy (§6) → aggregator
   aggregator (worker, idempotent per bucket): usage_aggregates(org, meter, resource, bucket, qty, event_count, hash)
   rater (period close or on-demand): price_book_version resolved at bucket time → rated_usage(org, meter, resource, period, qty, unit_price, amount_minor, currency, price_item_id, plan_allowance_applied)
   consumers: quota check · usage API · invoicing (M03 builds invoice lines from rated_usage) · wallet-debit mode (posts via LedgerPostingService)
```
Producers that run on nodes/sandboxes (no DB access) use `POST /v1/internal/metering/events` with service credentials, mTLS and per-source signing keys.
**Producer helper:** `packages/domain/metering` exposes `emitUsage()` which writes to the outbox in the caller's transaction. Direct inserts to `metering.usage_events` outside ingest are rejected by DB grants.
**Periodic gauges** (instance hours, GB-months): a metering sampler per owning module emits interval events at least hourly from its source-of-truth state (inventory/provider reports), keyed by `(resource, hour)` so reruns are idempotent.

## 5. Exactly-once semantics
Delivery at-least-once; `eventId` unique per org; aggregator recomputes a bucket from `usage_events` (sum over distinct events), so replays and duplicates cannot double count. Rated usage rows are versioned by `rating_run_id`; re-rating produces a new run and a *delta* (never edits), flowing to invoicing as adjustment lines only if the period is already invoiced.

## 6. Time, skew, lateness, backfill
- Bucket by `windowStart` (UTC). Producer clocks must be NTP-synced; ingest rejects `occurredAt` > now+5 min (proposal) and flags skew > 5 min.
- Late events accepted until period **close + grace** (proposal grace 72 h, D-23); after closure → `late_adjustment` posted into next period with reference, and an alert if > threshold.
- Backfill/replay: admin-only operation `metering.replay(range, source)` re-ingests from producer outbox or provider reports into a **staging** run, diffed before apply; applied via adjustment events. Never mutate existing events.

## 7. Quotas, entitlements and enforcement
`billing.entitlements` (from plan version + overrides) define per-meter allowance/limit. Enforcement points:
| Point | Check | Mode |
|---|---|---|
| Quote/order creation (`POST /v1/quotes`, typed create endpoints) | projected usage + spend limit | **hard** deny with `quota_exceeded` / `spend_approval_required` |
| Resource creation worker | re-check at execution | hard |
| Metering ingest (aggregation) | consumption vs soft/hard thresholds | **soft**: notify at 80%/100% (proposal), **hard**: flag org `restricted` for that meter group (blocks *new* consumption, never deletes) |
| AI gateway/sandbox start | per-request budget check against `ai` budgets and credits | hard (M09/M10) |
`GET /v1/quotas` returns consumption vs limits; thresholds emit `notifications` and audit.

## 8. Provider cost side and margin
`metering.provider_cost_records(provider_account_id, resource_id?, org_id?, period, meter_or_sku, quantity, cost_minor, currency, source(api|bill_import), provider_line_ref, captured_at)`; producers: adapters `fetchBilling` (M05+) and manual bill import (admin, evidence file). Posting: provider cost accrual recipe (doc 11 §3.1). Margin view `metering.v_margin` joins rated revenue with cost by org/resource/period; used by finance reports. Unattributed cost (no resource match) is surfaced in RC-04.

## 9. Reconciliation hooks (executed by `finrec`, M03)
- **RC-03** rated usage ⇄ invoice lines. **RC-04** provider cost ⇄ provider bills. M02 ships `metering` consistency checks (aggregate hash vs events) as a library used by finrec; `metering.metering_reconciliations` is *not* a separate reconciliation store (see spec issue note in M02 report).
- Producer completeness check: for each active resource kind, hours-with-events / expected-hours ≥ 99.9% (proposal) else alert `metering.gap`.

## 10. Privacy and retention
Events carry ids and numbers, never content (no prompts, filenames, email addresses; `dimensions` allow-list enforced). Classified `internal`/`financial`. Retention: raw events kept ≥ financial retention (D-34, proposal 6 years aligned with invoices **[VERIFY]**), aggregates and rated usage same; partition `usage_events` monthly, archive to in-Kingdom cold storage per D-15. DSR deletion: usage tied to invoices is exempt under legal retention (counsel to confirm, HG-04-01); otherwise pseudonymize `orgId` linkage only if allowed.

## 11. Producer checklist (what each milestone must emit; acceptance includes a metering test)
| Milestone | Meters | Emit trigger |
|---|---|---|
| M05 compute | compute.vcpu_hours, compute.memory_gb_hours, compute.disk_gb_months, compute.snapshot_gb_months, network.egress_gb (if provider reports) | Hourly sampler per running/stopped instance from inventory state; snapshot create/delete; egress from provider metrics/bills when available (else NOT VERIFIED) |
| M06 hosting | hosting.site_months, hosting.disk_gb_months, hosting.bandwidth_gb, hosting.backup_gb_months, network.egress_gb | Daily site usage from node agent/adapter `usage()` |
| M07 domains | domain.registration_years, domain.renewal_years, domain.transfers, dns.zone_months | On successful order/renewal/transfer (after provider confirmation); daily zone sampler |
| M08 data/email | database.instance_hours, database.storage_gb_months, database.backup_gb_months, cache.instance_hours, storage.object_gb_months, storage.requests_k, storage.egress_gb, email.transactional_messages, email.mailbox_months, email.mailbox_storage_gb_months | Hourly/daily samplers; email on provider-accepted send (idempotent by message id); mailbox monthly per active mailbox |
| M09 AI/builder | ai.tokens_input, ai.tokens_output, ai.credits_consumed, builder.build_minutes | Per model call completion (idempotent by call id); build job completion |
| M10 | ai.sandbox_cpu_seconds, builder.build_minutes, mobile.build_minutes, plus M09 meters | Sandbox runner end/heartbeat; build worker end |
| M11 | automation.executions, automation.steps | Per execution/step completion (idempotent by execution id/step id); retries do not double count |
| M03/M04/M12 | consume only | — |

## 12. Test fixtures and SLOs
Fixtures: duplicate events, out-of-order, late-after-close, skewed clock, adjustment events, price-version change mid-period, plan allowance + overage, zero quantity, unknown meter, forbidden dimension, cross-tenant orgId spoof, 10M-event aggregation. Property: aggregate = sum(distinct events). Proposed SLOs (D-30): ingest-to-visible p95 < 60 s; aggregation lag p95 < 5 min; rating of closed period < 30 min per 1M events; event loss = 0 (outbox-verified).
