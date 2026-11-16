# S03 Report — Tenancy and RBAC (M01 sprint 3), 2026-11-16

Status: **implemented and verified against real PostgreSQL** (`verify:full` EXIT=0). Not committed yet (S02 is `024af20`).

## A. Delivered vs. the M01 S03 task list
| Task | Result |
|---|---|
| 10 `tenancy` module: orgs (3 types), memberships, invitations (hashed token, 7-day expiry, single use), roles/permissions, workspaces, projects, environments; soft delete + retention hook | **Done.** Retention hook is a no-op until M04 (NOT VERIFIED) |
| 11 `PolicyService`, deny-by-default, `@RequirePermission`, resource checks, acting-org header | **Done.** One global `AccessGuard`: authenticates (session or Bearer API key), resolves the org from a verified membership, enforces the declared permission. Routes with no access declaration are refused (403). `X-Nuzm-Acting-Org` is refused until M11 (NOT VERIFIED — M11) |
| 12 RLS interceptor, roles, CI harness enumerating tables, explicit tenant-less list | **Done.** `db:test-rls` extended with an `rls_keyed` rule so `tenancy.organizations` (keyed on `id`) must still carry forced RLS and a policy |
| 13 Cross-tenant suite generated from OpenAPI (foreign ids → 404) | **Done**: 49 generated tests, plus a coverage test that fails if a new id-bearing route has no fixture |

Additional endpoints delivered: `/v1/me` (memberships, permissions for the active org, flags), `/v1/api-keys` (create with step-up, list, revoke), `/v1/operations*` (list, get, cancel), `/v1/resources` (empty, schema fixed), `/v1/roles`, `/v1/permissions`. 34 operations added to `spec/openapi/openapi.yaml`; drift check is now two-way.

## B. Security properties proven by tests
- Org context comes only from a verified membership (or the API key), never from body or query; a non-member always gets **404**, including for unknown or malformed org ids.
- API key authority = key scopes ∩ the creator's **current** permissions, evaluated on every use: demotion removes powers, removal from the org kills the key, revocation is immediate. Keys cannot create keys and cannot reach session-only routes.
- Found by the generated suite design and fixed: an API key combined with a *different* `orgId` in the path was ignored; it now returns 404.
- Last-owner protection, only owners can grant/remove `owner`, role changes need step-up + `If-Match`; concurrent role changes and concurrent org updates: exactly one wins (412 for the other).
- Invitations: token stored as SHA-256 only, never returned or logged; acceptance needs a signed-in user whose **verified** email matches; reuse, expiry, revocation → 410; 3 concurrent accepts → exactly one membership; delivery failure rolls the invitation back (503).
- Composite foreign keys make it impossible to attach a project to another org's workspace even bypassing RLS.
- Separation of duties encoded in the seed data and tested (viewer read-only, billing_admin cannot mutate resources, developer cannot manage members/billing, support cannot grant roles, finance cannot impersonate).

## C. Migrations (ordinals 0004–0006, reversible with `.down.sql`)
`tenancy` (organizations, memberships, invitations, roles, permissions, role_permissions, workspaces, projects, environments; RBAC reference data seeded), FKs from `platform.*` and `identity.api_keys` to `tenancy.organizations`. Reference tables are tenant-less and read-only to runtime roles.

## D. Verification (actual)
`pnpm verify:full` → **EXIT=0 in 293 s** (log read from the run itself; an earlier run failed on two lint errors, which were fixed: an unused import, and a test harness importing module internals through a parent path).
- Lint, typecheck, build: 14/14 turbo tasks. Unit tests: domain 6, i18n 5, ui 2, db 9, worker 2, api 23 (47).
- Integration on real PostgreSQL: db 43, platform 19, **api 138** (identity/MFA/API keys 47 + tenancy 42 + **generated cross-tenant 49**) = 200.
- `spec:lint` clean; `spec:drift` OK (45 routes declared and implemented, two-way); `scan:secrets` 224 files, 0 hits; `db:test-rls` OK.
- The `ERROR [ProblemFilter] … Service unavailable` lines in the log are the deliberate 503 test paths (IdP down, mail delivery failure).
- Not run: browser E2E, load smoke, real IdP, Redis.

## E. Known gaps and risks
- `X-Nuzm-Org` header: docs/04 §1 says org context comes "from token/API key". Session users with several orgs need a way to choose; the header is verified against membership, so it is a selector, not a trust input. **Flag for owner confirmation** (spec clarification).
- Org creation and invitation acceptance are user-scoped POSTs and do not take `Idempotency-Key` (the idempotency store is org-scoped).
- Admin routes (`/v1/admin/*`) and platform-role assignment are not built (S04 / PA-12); platform roles exist only as seed data.
- No real email provider (D-08, M08): production refuses to send invitations (503) instead of dropping them; dev logs the token.
- Residency (`sa-pending`) and retention hooks are stand-ins until M04.
- Redis: the Homebrew build was **stopped** (it was compiling Python 3.15 as a dependency and loading the machine); B3 Redis half still pending. Not needed until rate limiting/BullMQ.
- `GET /v1/audit-logs`, notifications, portals, admin basics: S04.

## F. Spec issues for the owner (docs not edited)
1. docs/04 §1 org-context wording vs the `X-Nuzm-Org` selector (above).
2. docs/04 lists `POST /v1/invitations/{id}/acceptance` "by token"; implemented as `{ token }` in the body with the invitation id in the path.
3. M01 §6 says `GET /v1/me` returns "feature flags": returned for the active org (global flags overridden by org flags).
