# S02 Report — Identity and platform mechanisms (M01 sprint 2), 2026-11-16

Status: **implemented and verified against real PostgreSQL and a local test IdP; NOT verified against a real IdP, Redis, or in a browser.** Nothing is committed since `0d2cc3f`.

## A. Assumptions recorded (decisions stay OPEN)
| ID | Assumption used | Reversible how |
|---|---|---|
| D-03 | Postgres outbox with a polling relay (`FOR UPDATE SKIP LOCKED`). **BullMQ is not used yet**; Redis is not required by any S02 code. ADR-007 remains Proposed | Engine sits behind `OutboxRelay`/`OperationsService`; swap for Temporal/BullMQ later |
| D-04 | Generic OIDC relying party (authorization code + PKCE S256, nonce, JWKS-verified ID token). Tested only against an in-process test IdP written for the tests. **Keycloak was not run** (no Docker on macOS 13) | Config-only (`OIDC_*` env) |
| D-12 | `SecretStore` port; dev-only AES-GCM file store under `.dev-vault/` (refuses `NODE_ENV=production`). DB holds `vault://` refs only | Implement the port against the chosen vault |

## B. Delivered vs. the M01 S02 task list
| Task | Result |
|---|---|
| 5 `platform`: operations + steps state machine, lease/heartbeat, retry, cancel | **Done** (`@nuzm/domain` state machine, `@nuzm/platform` `OperationsService`). **HTTP endpoints `/v1/operations*` not built**: they need permission checks (S03) |
| 5 outbox + relay | **Done**, at-least-once; worker app runs it (verified as a real process: delivered 1 row, clean SIGTERM stop) |
| 5 idempotency keys | **Done** incl. HTTP interceptor; 422 `idempotency_key_reuse`, 409 `idempotency_in_progress` |
| 5 feature flags, notifications, webhook_events_inbound | **Tables + RLS only**; no services/endpoints yet |
| 6 OIDC + sessions | **Done**: login/callback/logout/sessions list+revoke/`/v1/me`; opaque sessions (hash-only storage), idle 30 min / absolute 12 h (config, D-30), CSRF double-submit, fixation defence, open-redirect allow-list, realm separation |
| 7 MFA | **Done**: TOTP enrol/verify, replay protection, lockout (5 failures → 15 min), recovery codes (10, single use, HMAC-hashed), step-up on sensitive MFA routes, admin realm requires MFA, platform users cannot remove their last factor. **WebAuthn DEFERRED** |
| 8 API keys | **Service done** (create/list/revoke/rotate/authenticate, argon2id, scope-subset, IP allow-list, uniform failure, 30 s cache cleared on revoke). **HTTP endpoints and Bearer auth in the guard not built**: need org membership/permissions (S03) |
| 9 Rate limiting + lockout + audit | Auth rate limit **in-memory (NOT VERIFIED multi-instance)**. MFA lockout is durable. Audit: `AuditSink` interface + log sink; **persistent hash-chained store is S04** |

## C. Migrations (ordinals 0002–0003, reversible with `.down.sql`)
`platform.operations, operation_steps, outbox, idempotency_keys, feature_flags, notifications, webhook_events_inbound`; `identity.users, sessions, mfa_factors, recovery_codes, api_keys`. All `org_id` tables have ENABLED + FORCED RLS; worker cross-org access only under `app.worker_scope='claim'`; global feature-flag writes only for `nuzm_admin_breakglass`. Issue found and fixed during testing: migration 0002 lacked `USAGE` on schema `platform` for the break-glass role (rolled back on dev DB, fixed in place since unreleased).

## D. Verification (actual)
`pnpm verify:full` → **exit 0**. Unit: i18n 5, ui 2, domain 6, worker 2, db 9, api 23 (47). Integration on real Postgres: db 30, platform 19, api 47 (96). Also: spec lint clean, spec drift OK (11 routes declared), secret scan clean (194 files), `db:test-rls` clean.
Negative cases exercised: forged/missing state, tampered ID token (nonce/audience/expiry), code replay, open redirect (4 variants), CSRF missing/wrong, session fixation, idle/absolute timeout, realm swap both ways, disabled user, IdP down at discovery and at token endpoint (503, no session/user created), rate limit 429, TOTP replay, MFA and recovery lockout, stale step-up, foreign-session revoke (404), 50 parallel idempotent POSTs (one effect), two relays/workers never double-claiming, RLS cross-org read/write/update denial.
Timing: `verify:full` took 470 s (api integration alone ~143 s: module imports and argon2). Not optimised.

## E. Known gaps and risks
- Real IdP (D-04/HG-01-02), Redis (build still running in Homebrew: compiling python@3.15 as a dependency), browser/Playwright E2E, load smoke: **NOT VERIFIED / not run**.
- `req.ip` is the socket address; `trustProxy` is not configured, so the per-IP limiter would throttle everyone behind a proxy until it is (decide with deployment topology).
- `Secure` cookies only when `NODE_ENV=production`; no CORS policy yet; no WAF/headers beyond nosniff/no-store/no-referrer.
- User-scoped POSTs (MFA enrol) do not use `Idempotency-Key` (the store is org-scoped).
- `GET /v1/auth/mfa/factors` (list) is not in docs/04 and was not added; the verification endpoint also accepts `{recoveryCode}` instead of `{code}` (no new path).

## F. Spec issues for the owner (docs not edited)
1. M01 §7 lists `platform.resources_index`; docs/05 says `cloud.resources` is the only inventory. Followed docs/05 (not created).
2. `identity.credentials_refs` (docs/05) is not needed yet and was not created.
3. Step-up for API key creation, role change and impersonation is specified in M01 but those endpoints do not exist until S03; the `@StepUp()` mechanism is ready and tested on MFA routes.

## G. Next (S03 — tenancy and RBAC)
Organizations/memberships/invitations/roles/permissions/workspaces/projects/environments with RLS keyed on org; add FKs from `platform.*`/`identity.api_keys.org_id` to `tenancy.organizations`; permission service replacing the deny-all default; API-key Bearer auth and endpoints; `/v1/operations*` endpoints; `/v1/me` memberships and permissions; cross-tenant route tests across three org types. No new human gates; D-04/D-12 remain needed before any non-dev environment.
