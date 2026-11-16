# S04a report — Audit chain, notifications, admin console API (M01 sprint 4, backend half)

Status: backend of S04 implemented. **Not complete as S04**: SDK generation, portal shells and screens (UI-M01-nn), OpenTelemetry and the M01 runbooks/demo are **not done** (see §G, §I). Not committed.

## A. Repository findings and assumptions
- Existing audit call sites used 2-segment names (`org.updated`, `apikey.created`, `auth.logout`). The M01 taxonomy is `<domain>.<resource>.<action>`, so all call sites were renamed (`tenancy.organization.updated`, `identity.api_key.created`, `auth.session.logout`, …) and the type `AuditAction` (`${string}.${string}.${string}`) plus a DB CHECK now make a stray name a compile-time and write-time error.
- Platform (staff) roles had seed permissions but no assignment storage. Added `tenancy.platform_roles`. The assignment **API** (PA-12) is not approved, so it is **not exposed**; bootstrap is `pnpm --filter @nuzm/db exec tsx src/cli.ts grant-platform-role <email> <role>` (local DB only).
- docs/04 says platform_admin may impersonate; the S03 seed did not grant it. Migration 0008 adds `admin:impersonate` to `platform_admin`.
- Assumptions recorded: support impersonation must cite an `approvalRef` (interpretation of "support w/ approval flag"); only `platform_admin` may suppress the owner notice; impersonation sessions are web-realm, ≤ 30 min, and may not change MFA or API keys.
- Audit table is **not partitioned monthly** (M01 §7 asks for it). Deferred until volume justifies it: partitioning needs the partition key in every unique key and in the trigger design. Needs a change-log entry from the owner to count as `DEFERRED`; until then this row is **FAIL-by-omission**, not PASS.

## B. Plan and changed files
- Migrations: `audit/0007` (audit_logs, chain_heads, audit_checkpoints, hash trigger, append-only triggers, verify_chain, chain_tips, RLS), `tenancy/0008` (platform_roles, `audit:read_all`, platform-scope read policies), `identity/0009` (impersonation columns + 30-min CHECK), `platform/0010` (notification_preferences, recipient-only policy, flag admin scope). Each has a `.down.sql`.
- `packages/platform`: `audit.ts` (`AuditIntegrity`, `HmacCheckpointSigner`), `Db.withPlatformScope`.
- `apps/api`: `modules/audit`, `modules/notifications`, `modules/admin`; access guard platform-permission path; `PolicyService.platformAccess`; session impersonation; request-context (AsyncLocalStorage) for audit enrichment; `common/pagination.ts`.
- `apps/worker`: `audit-job.ts` (periodic verify + checkpoint).
- Spec: 10 new operations in `spec/openapi/openapi.yaml`; PA-17/PA-18 recorded in docs/04; ownership manifest updated (3 tables).

## C. Implemented features and API
| Endpoint | Notes |
|---|---|
| `GET /v1/audit-logs` | `audit:read`; billing_admin (no `audit:read_all`) sees billing domains only; filters actor/resource/action(prefix `x.*`)/outcome/time; keyset cursor |
| `GET /v1/admin/audit-logs` | `admin:audit:read`; cross-org; reading is itself audited on the platform chain |
| `GET /v1/notifications`, `PATCH /v1/notifications/{id}` | own notifications only (RLS recipient policy + service); user sessions only |
| `GET /v1/admin/organizations`, `PATCH /v1/admin/organizations/{id}` | list/search; suspend (reason + step-up) / reinstate; owners notified; audited in the org chain. **`POST /v1/admin/organizations` not implemented** (owner semantics undecided, open question) |
| `GET /v1/admin/users` | no credential material in responses |
| `POST /v1/admin/users/{id}/impersonation` | see assumptions; 403 for platform-user targets; audited in platform chain AND each target org chain |
| `GET/PUT /v1/admin/feature-flags` | global and org scope, before/after audited |
- Audit integrity: hash chain computed by a DB trigger (the app cannot forge or reorder); per-org chains + platform chain; signed checkpoints (HMAC, key outside DB, `key_ref` recorded); verifier detects edited rows, gaps, tail truncation vs chain_heads, history rewrites before a checkpoint, and forged checkpoint signatures.
- `/v1/me` now returns `impersonation` for impersonated sessions.

## D. Migrations and rollback
0007–0010 as above, forward-only in production, `.down.sql` for dev/staging (exercised: dev DB rolled back and re-applied). The audit down-migration drops the schema and is **dev/staging only**; production audit data is never dropped.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0 in 125 s** (read from the run's own log line). Two earlier runs failed and were fixed: the secrets scan flagged a password-shaped key in a new test fixture (now built at runtime), and an S03 test asserted `platform_admin` cannot impersonate, which contradicts docs/04 §2.1 (docs win; test updated, conflict recorded here).
- Lint, typecheck, build: 14/14 turbo tasks. Unit: domain 6, ui 2, i18n 5, worker 4, db 9, api 25 (51).
- Integration on real PostgreSQL: db 43, platform 31 (12 new audit tests incl. tamper detection and the worker role), **api 188** (was 138): audit 9, notifications 10, admin 20, generated cross-tenant now also covers notifications and proves every admin operation refuses tenant sessions and API keys.
- `spec:lint` clean; `spec:drift` OK (55 operations declared and implemented, two-way); `scan:secrets` 0 hits after the fixture fix; `db check` OK.
- Not run: browser E2E, load smoke, real IdP, Redis, CI.

## F. Security, tenant isolation, billing, residency
- Tenant isolation: audit rows readable only for `app.org_id` (RLS); inserts must match the context org; `chain_heads` has no runtime grants; `verify_chain` refuses another tenant's chain. Notifications are filtered by a restrictive recipient policy and tested against a same-org colleague.
- Admin console: web sessions, API keys and staff without a role are refused (generated test over every admin operation in the spec). `withPlatformScope` is only used from `modules/admin` and `modules/audit` (a test enforces it).
- Audit failure is never silent: a failed audit write is logged to stderr with the event and the error propagates.
- Billing/residency: not touched in this slice (M02/M04).

## G. Human gates and live checks still needed
- D-12 production vault/KMS: checkpoint signing key and audit hash key are env-based dev stand-ins. **BLOCKED (D-12)** for production.
- No real IdP, no real mail provider (D-08), no Redis, CI never run (HG-01-01): unchanged.
- PA-12 (platform-role API, admin MFA reset), PA-17, PA-18 await owner approval.

## H. Acceptance (S04 rows touched)
| Row | Status |
|---|---|
| Audit hash-chain test (docs/06 S04 exit) | PASS (see E) |
| Append-only audit tables | PASS |
| Monthly partitioning of `audit_logs` | NOT DONE (see A) |
| Notifications in-app + email through `NotificationChannel`, per-user preferences | PASS for service; preferences **endpoint** not exposed (PA-18) |
| Admin: orgs list/suspend/reinstate, users list, impersonation, feature flags, audit viewer | PASS for API; no UI |
| Admin: operations monitor | NOT DONE (no endpoint in docs/04 M01 list) |
| SDK generated from OpenAPI; portals use only SDK | NOT DONE (S04b) |
| Portal shells, org switcher, i18n/RTL screens, axe in CI | NOT DONE (S04b) |
| OpenTelemetry traces/metrics/logs | NOT DONE (S04b; trace ids and problem+json `traceId` already exist) |
| Runbooks, demo script, `M01-report.md` | NOT DONE (S04b) |

## I. Handoff and open decisions
- Next: S04b = SDK from OpenAPI, `apps/web` + `apps/admin` shells and the UI-M01 screens, OTel, runbooks, M01 report.
- Owner decisions: PA-12/17/18; `POST /v1/admin/organizations` semantics; impersonation approval model (`approvalRef`); partitioning change-log entry; `X-Nuzm-Org` selector (from S03).
- Known limitation: audit rows are written after the mutation commits, in their own transaction (failure is loud but the mutation is already committed). Same-transaction audit via the outbox is the proper fix and should be scheduled before M02 (money flows).
- Known limitation: truncating the **unchecked tail** of a chain is undetectable until the next checkpoint; the checkpoint interval (default 300 s) bounds that window.
