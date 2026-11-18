# M08 report — Managed data and email (S32–S36)

Status: **IMPLEMENTED for everything that does not need a provider; gate review NOT SIGNED; milestone NOT DONE.** Every acceptance row that depends on a provider, credentials or a verified region is **BLOCKED**; every result below was produced by **dev-reference mocks and is NOT VERIFIED (local reference)**.
Branch `claude/m08-data-email-b74780` (base `integration/main-m04-s12d`), local only, never pushed. Sprint reports: [S32](S32-report.md) · [S33](S33-report.md) · [S34](S34-report.md) · [S35](S35-report.md) · [S36](S36-report.md). Upstream assumptions: [M08-upstream-interface-assumptions.md](M08-upstream-interface-assumptions.md). Evidence index: [evidence/M08](evidence/M08/README.md).

## A. Repository findings and assumptions
- **Owner-directed exception (recorded as required):** M08's prompt says "stop if M05/M07 are missing". The owner directed M06, M07 and M08 to start now. On this base there is no `packages/adapters` contracts package, no provider registry/vault, no compute adapter, no DNS/domain module. M08 therefore codes against **ports in its own modules with in-memory fakes** and lists every assumed interface in `M08-upstream-interface-assumptions.md` (U-01…U-16) so integration is mechanical. M05's S16 code was **read only**, never merged or copied; shapes were mirrored under the same names.
- **Decisions D-05..D-09 are OPEN.** ADR-050..054 are written as **Proposed** (not accepted). No vendor is chosen anywhere; `provider-*` adapters exist only as **skeletons** (every capability `unknown`, no network call) because no official vendor documentation was cited (`docs/adapters/README.md`).
- **No credentials exist and none were created.** Production sinks/providers are BLOCKED. Redis is not installed here: all Redis behaviour is mock-only.
- Conflicts resolved per CLAUDE.md §2 (higher source wins): migration numbers **1000–1199** (manifest) instead of 900–999 in the task text; audit actions need three parts; docs/04 has no restore listing, no suppression delete, no admin deliverability/fleet endpoints and no mailbox reveal → solved inside the existing contract where possible (restore history embedded in the backups list; `POST …/suppressions {action:'remove'}`) and otherwise **proposed as PA-19..PA-21 (not implemented over HTTP)**; PA-15 (credential reveals) not exposed either.
- Test-only environment: Postgres on :54334 (project-local). `pnpm test:e2e` and `pnpm verify:full` were **not run** (ports belong to another session).

## B. Plan and changed files
| Area | Files |
|---|---|
| Adapters | `packages/adapters/data/**` (contracts, mirror of M05 base types, 5 conformance suites, 5 mocks, `self-operated-database` + signed node-agent protocol, `provider-*` skeletons) |
| Spec | `spec/openapi/openapi.yaml` (+`errors.yaml`), `spec/db/ownership.yaml` (tenant-less `data.data_providers`, classification of 105 tables' new columns, protections), `spec/compliance/residency-hooks.yaml` (M08 hooks **enforced**, tables registered), `docs/04` (PA-19..PA-21 rows), `packages/sdk/src/schema.ts` (regenerated) |
| Migrations | `packages/db/migrations/data/1000–1002`, `packages/db/migrations/email/1003` (+ `.down.sql`, DEV ONLY; production is forward-fix) |
| API | `apps/api/src/modules/data/**` (providers, databases, restores, rotation, storage, metering, jobs, alerts, bindings port), `apps/api/src/modules/email/**` (domains/DNS, mailboxes, senders, templates, messages, suppressions, webhooks, forms port) |
| Shared append-only edits | `apps/api/src/app.module.ts` (2 imports), `apps/api/src/platform-scope.spec.ts` (allow-list `modules/data/`, `modules/email/`), `apps/api/src/common/errors.ts` + `spec/openapi/errors.yaml` (new codes at the END), `pnpm-workspace.yaml` (`packages/adapters/*`), `apps/api/package.json` (dependency) |
| Docs | ADR-050..054, `docs/adapters/README.md`, runbooks (`db-restore`, `db-failover` (draft), `storage-incident`, `email-deliverability`, `suppression-handling`, `demo-m08`), sprint reports, this report |
| UI | see §C (built after the backend; E2E NOT RUN) |

## C. Implemented features, API and UI screens
- **Provider selection (S32):** `GET/POST /v1/admin/data-providers`. A row is enabled only with a probe that passed (every required capability `supported`), `verified_at`, an evidence reference and — outside `environment=local` — an accepted ADR (recorded by a person), **live** probe evidence and a **second** approver. The same rules are CHECK constraints. Dev-reference providers (`mock-*`) are `local` only and refused in production. Nothing is seeded.
- **Databases (S32/S33):** `/v1/databases` create (quote → order → durable operation, deterministic tokens, reconcile-before-retry), list/get/patch/delete (typed name, `in_use` 409, final backup), backups (manual + scheduled + retention), restores (default to-new; in-place with confirmations and an automatic pre-restore backup; verification against the manifest), weekly verification drill with alerts, dual-credential rotation, one-time reveal **service** (no HTTP route: PA-15), Redis via `CacheAdapter`, metering samplers, `DatabaseBindingPort`.
- **Object storage (S34):** buckets, deny-by-default policy subset, public access confirmation + MFA + audit, signed URLs (default 15 min, max 7 days), lifecycle, bucket-scoped vault credentials, entitlement quotas, daily usage import, system bucket pair.
- **Email (S35/S36):** domains with live multi-resolver DNS verification + provider confirmation, mailboxes/aliases, sender identities, versioned sanitized templates, transactional messages (policy, guardrails, durable send, replay safety), signed webhooks with dedupe, suppressions, retention, usage reconciliation, `FormsNotificationPort`.
- **UI:** the customer and admin screens were built in a separate pass by a subagent after the backend commit; see the UI section appended below once it reports (UI-M08-16/17 are **BLOCKED**: PA-20/PA-19).

## D. Migrations and rollback
| Migration | Content | Rollback |
|---|---|---|
| 1000 | `data` schema, `data_providers`, `database_instances`, `database_backups`, permissions | `.down.sql` DEV ONLY; production forward-fix (customer resources are never dropped) |
| 1001 | `database_restores`, `reveal` | same |
| 1002 | `storage_buckets`, `bucket_policies`, permissions | same |
| 1003 | `email` schema (8 tables), permissions | same |
All tables have RLS (org isolation + admin-scope read); `data.data_providers` is tenant-less (listed in the manifest) with admin-scope write; `email.email_events` is append-only; message/template/backup/restore identity columns are immutable (triggers).

## E. Tests run with actual results
(Commands run in this worktree against the project-local Postgres on :54334; results are from this session.)
- `@nuzm/adapter-data` unit: **18 passed** (conformance 3 incl. 2 negative, self-operated 8, skeleton 5, …). Conformance evidence: `docs/reports/evidence/M08/mock-conformance.json` — database 20/20 ×2 engines, cache 11/11, object storage 14/14, transactional email 14/14, mailbox 12/12, self-operated database 20/20 ×2 (mock/fake: **NOT VERIFIED**).
- `apps/api` unit (`vitest run`): **608 tests passed, exit 0** (includes `sanitize.spec.ts` 56 cases with a 52-payload XSS corpus and a 1000-case fuzz, `dns.spec.ts` 18 fixture cases, the errors/registry sync test, the platform-scope guard).
- Integration (`vitest run --config vitest.integration.config.mts src/modules/data src/modules/email`): **4 files, 101 tests passed, exit 0** (`databases.int.spec.ts` 31, `restore-rotation.int.spec.ts` 20, `storage.int.spec.ts` 19, `email.int.spec.ts` 31; each run creates a throwaway database with every migration applied; dev-reference mocks: NOT VERIFIED).
- Spec/contract: `pnpm spec:lint` clean; `pnpm spec:drift` OK (187 routes); `pnpm sdk:generate` done; `pnpm compliance:classification-coverage` OK (1282 columns / 105 tables); `pnpm compliance:residency-hooks` OK.
- **NOT RUN:** `pnpm test:e2e`, `pnpm verify:full`, load tests, chaos beyond the injected provider faults, real-engine restores, anything against a real provider.

## F. Security, tenant isolation, billing, residency verification
- **Isolation (AC-M08-05):** generated attack cases — databases/backups/restores/rotations ≥ 200, buckets ≥ 120, email ≥ 120 (each test asserts its own floor and 0 leaks): foreign ids, malformed ids, org selectors in bodies, anonymous calls, credential reuse across buckets, sender spoofing, RLS under the application role. Foreign resources answer exactly like missing ones (uniform 404/`name_taken`).
- **Secrets:** vault references only; tests grep responses, operations, audit events and database rows for secret material; the node agent accepts only signed, allow-listed, single-use, node-bound, short-lived commands with strictly validated arguments (no shell, no free-form SQL).
- **Email:** anti-spoofing (verified sender), header-injection fuzz, HTML allow-list sanitizer (XSS corpus + fuzz), suppression checked twice, webhook signature + replay window + dedupe, recipients sealed + hashed, bodies hashed.
- **Billing/metering:** quotes from the price book only (no price ⇒ `kind_not_available`); orders through `OrderService` (spend/quota/dunning); meters emitted through the outbox with deterministic event ids; **exactness asserted** (`database.*`, `storage.*`, `email.*`); `email.transactional_messages` only on provider acceptance; an unreportable provider figure is `unavailable`, never estimated.
- **Residency:** the M04 hook is enforced at quote, create, restore, backup, rotation, bucket, domain, mailbox and send, fail-closed; European regions are denied for an in-Kingdom organization (AC-M08-15 tests for create, restore, bucket, domain and send). Backups and the system bucket pair stay in the instance's `data_region`.

## G. Human gates and live checks still needed
| Gate | Needed for |
|---|---|
| D-05/D-06 (ADR-050/051) + HG-08-01 + HG-05-01/02 | managed DB/Redis on verified Saudi infrastructure (AC-M08-12) |
| D-07 (ADR-052) + HG-08-02 | S3 compat suite on the real endpoint, per-credential scoping on the real provider (AC-M08-13) |
| D-08 (ADR-053) + HG-08-04 | real send, real webhooks, warm-up, abuse policy (AC-M08-11, AC-M08-14) |
| D-09 (ADR-054) + HG-08-03 + M07 | mailbox provider, DNS verification on a real domain (AC-M08-10) |
| HG-04-01 | counsel: email content/metadata transfer, backup residency |
| D-34 / D-31 | retention periods (backups 7 d, bodies 7 d are proposals) / usage tolerance (1% proposal) |
| PA-15, PA-19, PA-20, PA-21 | reveal routes, admin deliverability + fleet endpoints, second-person restore approval |
Live checks stay `NOT VERIFIED` until each owner action exists with evidence.

## H. Acceptance checklist
| ID | Status | Evidence |
|---|---|---|
| AC-M08-01 | **PASS** on dev-reference/fixtures (NOT VERIFIED live) | `evidence/M08/mock-conformance.json`; adapter-data tests |
| AC-M08-02 | **PASS** | `databases.int.spec.ts` "AC-M08-02" (≥10 negatives + CHECK-constraint tests) |
| AC-M08-03 | **NOT VERIFIED** (simulated data; no real PostgreSQL/MySQL restore) | `restore-rotation.int.spec.ts` |
| AC-M08-04 | **PASS** (simulated) | `restore-rotation.int.spec.ts` "AC-M08-04" |
| AC-M08-05 | **PASS** (dev-reference; ≥ 440 generated cases in total) | data + storage + email int specs |
| AC-M08-06 | **PASS** (dev-reference; the 60 s needs `DATA_SCHEDULER_INTERVAL_SECONDS` ≤ 30) | `restore-rotation.int.spec.ts` |
| AC-M08-07 | **PASS** (dev-reference) | `email.int.spec.ts` |
| AC-M08-08 | **PASS** (dev-reference) | `email.int.spec.ts` |
| AC-M08-09 | **PASS** on fixtures (exact) | metering assertions in data/storage/email specs |
| AC-M08-10 | **BLOCKED** (HG-08-01, D-08/D-09, M07) | fixture DNS checks only |
| AC-M08-11 | **BLOCKED** (HG-08-01, D-08) | — |
| AC-M08-12 | **BLOCKED** (D-05/D-06, HG-05-01/02) | — |
| AC-M08-13 | **BLOCKED** (D-07, HG-08-01) | — |
| AC-M08-14 | **BLOCKED** (D-31, HG-08-01) | mechanism tested on the mock |
| AC-M08-15 | **PASS** (dev-reference) | residency denial tests (create, restore, bucket, domain, send) |
| AC-M08-16 | **NOT VERIFIED** — E2E specs written, NOT RUN (ports in use); UI-M08-16/17 **BLOCKED** (PA-20/PA-19) | `e2e/tests/08-*.spec.ts` |

Compliance checklist (M08 §15): `data_region` + residency evaluation ✔ · personal fields classified ✔ (recipients, local parts, sender addresses) · consent/lawful-basis capture for email processing **NOT DONE** (M04 consent hook not wired) · audit events ✔ · retention parameterized (D-34) ✔ · DSR export/erase for messages/suppressions **NOT DONE** · backup/restore within allowed regions ✔.

## I. Next-milestone handoff and open decisions
- **M06:** implement `DatabaseBindingPort`; M08 provides the notice contract. **M07:** implement `DnsLinkagePort`. **M05:** reconcile U-01…U-12 (mirror → re-export, `DataOperations` → pass-through, release holds on failure, resources registry).
- **M09:** `FormsNotificationPort`; asset buckets use `/v1/storage/buckets`. **M10:** per-app databases/buckets via the same endpoints. **M12:** consume `ops.alert` events and the drill results; build the admin fleet/deliverability endpoints after PA-19/PA-20.
- **Open:** D-05..D-09, HG-08-01..04, D-31, D-34, attachments policy (none in v1), authoritative DNS decision, DSR handler for email/storage, consent capture for email processing, provider-cost capture to `metering.provider_cost_records` (not implemented).
