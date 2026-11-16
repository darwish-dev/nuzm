# S06 report — Metering pipeline, price books, rating, provider cost (M02 sprint 2)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M02 continues with S07 (quotas, spend control, quotes, adjustments endpoint, usage API, billing UIs, M02 report).

## A. Repository findings and assumptions
- **Spec/doc gaps recorded (no silent reconciliation):**
  - docs/04 has no endpoint for importing provider cost records (`provider_cost_records`). The service and ledger accrual exist; no HTTP route was invented. Needs an owner decision or a spec change.
  - Usage read APIs (`GET /v1/usage*`) and quotas belong to S07 and are not built here.
  - There is no endpoint that triggers a rating run; rating is a service used by tests and, later, by the invoicing flow (M03).
- **Seed price book is a placeholder** (`default`, SAR, "DRAFT-NOT-APPROVED", `placeholder = true`): the examples show flat, graduated, volume and allowance models, not a price list. Rating it for production is refused. Activation is BLOCKED on HG-02-01 and D-23.
- **Producer authentication** uses `METERING_SOURCE_KEYS` (JSON, sha256 of each key, optional org allow-list) as a placeholder until the vault choice (D-12). mTLS is documented only (terminates at the ingress), not implemented or tested here.
- **Data region** on usage events is the placeholder tag `sa-pending` until the residency policy is configured; `ResidencyPolicyService` is not called by metering yet.
- **Late events:** a period closes at month end + 72 h; later events are billed in the current open month and flagged `late`. The 72 h grace is my reading of docs/12; confirm with the owner.

## B. Plan and changed files
- Migrations: `metering/0201` (+ `.down.sql`), `billing/0202` (+ `.down.sql`); `spec/db/ownership.yaml` (tenant-less: `billing.price_books`, `price_book_versions`, `price_items`, `metering.meters`); `packages/db/src/checks.ts` skips partitions.
- `packages/platform/src/metering.ts` (`UsageEvent`, `usageEventId`, `emitUsage`).
- `apps/api/src/common/rating.ts` (+ spec): exact decimal arithmetic.
- `apps/api/src/modules/billing`: price-book service and admin controller. `apps/api/src/modules/metering`: producer auth, ingest, rating, meters, provider cost, two controllers, module.
- `apps/worker`: `metering-consumers.ts` (`usage.recorded` ingestor, partition job), registered in `main.ts`; integration test.
- Spec: `ingestUsageEvents` (new `x-nuzm-access: service-key`), meters, price books; `spec/events/usage.recorded.json`; SDK regenerated; `.env.example` entry.
- Tests and guards: `platform-scope.spec.ts` allow-list now includes `modules/metering/`; `cross-tenant.int.spec.ts` accepts `service-key`; web/admin unit-test timeout raised to 30 s.
- Runbooks: `metering-replay`, `ledger-inspection`, `pricebook-release`, `reversing-adjustment`, `rebuild-projections`.

## C. Implemented features and API
| Area | What exists |
|---|---|
| Meters | 31 seeded meters (unit, granularity, kind, allowed dimensions); `GET/POST /v1/admin/meters`; a meter's unit is frozen once events exist |
| Ingest | `POST /v1/internal/metering/events` (1..500 events, per-source key; per-event result: accepted / duplicate / rejected with a reason). Validation, dedupe by `eventId`, late and clock-skew policy live in SQL `metering.ingest()`, shared by the API and the worker consumer |
| Events | Immutable, monthly partitions (+ default partition, worker job keeps six months ahead); corrections are adjustment events |
| Aggregation | `metering.aggregate` / `aggregate_events` rebuild buckets from events and write only on change; `verify_aggregates` compares stored with recomputed |
| Price books | `GET/POST /v1/admin/billing/price-books`, `POST .../{id}/versions` (draft by `admin:billing:manage`, publish by a different person with `admin:billing:publish`); versions immutable once published (API 409 and DB triggers) |
| Rating | Exact decimals (8 fractional digits, scaled bigint); flat, graduated, volume, allowance; mid-period version change with pooled allowance; re-rating writes correction deltas |
| Provider cost | Capture + idempotent ledger accrual (`cost:<account>:<lineRef>`); `metering.v_margin` view (revenue vs cost per org/period) |
| Producers in-platform | `emitUsage()` writes `usage.recorded` to the transactional outbox; the worker ingests it |

## D. Migrations and rollback
`metering/0201` creates schema `metering` (meters, partitioned `usage_events`, aggregates, rated usage, provider cost, `v_margin`, functions, RLS, grants). `billing/0202` adds price books with immutability triggers, two platform permissions and the placeholder book. Both have dev-only `.down.sql`; production follows forward-fix (events and cost records are never dropped). `0201` was edited in place twice during the sprint (before any commit) and re-applied to the dev database by rollback + migrate.

## E. Tests run (actual)
- `pnpm verify` (inside `verify:full`, last run): lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks), `spec:lint` clean, `spec:drift` OK (**71** operations, two-way), `sdk:check` up to date, `scan:secrets` 731 files / 0 hits, **135 unit tests** (api 82 incl. 33 rating tests, i18n 9, db 9, ui 7, domain 6, web 5, admin 5, worker 5, sdk 4, telemetry 3), browser E2E **4 passed**.
- Integration (real PostgreSQL), exit 0: `db check` OK; db 43, platform 32, worker 8 (incl. 5 new for the `usage.recorded` consumer and partition job), **api 286** (incl. 34 metering) = **369**.
- How the full run went: the first runs failed for environmental or small reasons I fixed (worker typecheck error; two 5 s unit-test timeouts at machine load ≈ 800–900; Postgres had stopped before the last run). The final `verify:full` run passed everything through `scan:secrets`, then stopped at the integration stage because the local services were stopped. I started them (`pnpm services:start`) and ran the remaining steps (`db:migrate`, `db:test-rls`, `test:integration`) as a separate command, exit 0. **The single `verify:full` command did not end with EXIT=0 in one piece.**
- Defect found by the tests and fixed: `metering.aggregate` did not heal a tampered stored quantity because it compared only the content hash; it now also compares quantity and event count (regression covered by the `replay_is_noop` test).
- Not run: the 10M-event load fixture, a real producer over mTLS, any live provider or bill import.

## F. Security, tenant isolation, billing, residency verification
- **Producers:** a key fixes the source and may restrict organizations; an `orgId` outside the key's scope is rejected per event (tested). No key or an empty key list refuses everyone.
- **Isolation:** events, aggregates and rated usage are RLS-protected per organization (cross-tenant tests, partitions included); the outbox consumer takes the organization from the outbox row, never from the payload, and a producer cannot enqueue for another organization (RLS on the outbox) — tested.
- **Write paths:** runtime roles have no INSERT/UPDATE/DELETE on metering tables; only SECURITY DEFINER functions write.
- **Money/rating:** no floats; decimals parsed from strings with a strict regex, overflow and invalid input rejected (property and table tests); the placeholder book cannot rate production usage.
- **Four-eyes:** the author cannot publish their own price book version; every create/publish is audited.
- **Residency:** not verified; the region tag is a placeholder (see A).

## G. Human gates and live checks still needed
HG-02-01 (approved price book v1 and margin policy) BLOCKED for production; D-12 (vault) for producer keys; D-23/D-25 OPEN; mTLS between producers and ingress NOT VERIFIED; M01 BLOCKED items unchanged. No live provider or bill import was exercised.

## H. Acceptance (S06 rows)
| Row | Status |
|---|---|
| Metering schema, immutable events, partitions | PASS |
| Ingest API: auth, scoping, dedupe, late/skew, adjustments | PASS |
| Aggregation: property tests, replay no-op, concurrency, heal | PASS |
| Price books: four-eyes, immutability, versions | PASS |
| Rating: decimal exactness, models, re-rate deltas, mid-period change | PASS |
| Provider cost capture + margin view | PASS (service level; no import endpoint, see A) |
| Outbox → worker consumer, partition job | PASS |
| Runbooks | PASS (written; not exercised in production) |
| Usage read APIs, quotas, 10M-event fixture, mTLS | NOT DONE / NOT VERIFIED |
| Production price book | BLOCKED (HG-02-01) |

## I. Handoff and open decisions
- S07: quotas and spend limits with four-eyes approvals, `commerce.quotes`, `POST /v1/admin/billing/adjustments`, usage read API and UI, billing UIs, M02 report; wire rating into wallet-debit charging.
- Owner decisions: provider-cost import endpoint (spec change), 72 h late-event grace, residency tag source, D-12 for producer keys, plus the open items carried from S05 (docs/05-over-prompt resolution, `org:read` for plan reads, D-23/D-25, HG-02-01).
