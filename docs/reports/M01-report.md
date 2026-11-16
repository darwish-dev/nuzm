# M01 Milestone Report — Bootstrap, IAM, Tenancy & Portal Shells

Format: CLAUDE.md §10. Sprint reports: [S01](S01-preflight-report.md) · [S02](S02-report.md) · [S03](S03-report.md) · [S04a](S04a-report.md) · [S04b](S04b-report.md).
Status: **READY FOR GATE REVIEW WITH LISTED GAPS. NOT DONE (owner has not signed).** Several acceptance rows are NOT DONE or NOT VERIFIED (§H); none is converted to PASS using mocks.

## A. Repository findings and assumptions
- Approved documentation (HG-00-01, 2026-11-15) governs; the V4.0 PDF conflicts were resolved per the owner's cluster answers ([conflicts](pdf-v4-execution-pack-conflicts.md)). Local-only git (D-01): CI has been written but **never run**.
- Machine: macOS 13, no Docker → project-local PostgreSQL 16; Redis not installed (no feature needs it yet).
- Audit action names follow `<domain>.<resource>.<action>` (e.g. `identity.api_key.created`, `tenancy.member.removed`), which differs from the informal names in M01 §9.5 (`apikey.created`, `member.removed`, …). The taxonomy is enforced by type and DB CHECK.
- Additive contract changes beyond docs/04, each recorded for owner confirmation: `X-Nuzm-Org` header selector; `realm` query on OIDC login; `X-Nuzm-Realm` header; `mfaFactorId` on `/v1/me` and on `mfa_required`; `platform` and `impersonation` on `/v1/me`; `invitationId` in the invitation mail; invitation link `/invitations/{id}?token=` (the acceptance API needs the id; M01 §8 shows `/invitations/[token]`).

## B. Plan and changed files
S01 bootstrap + approved docs; S02 identity/platform mechanisms/worker; S03 tenancy/RBAC/API keys; S04a audit chain/notifications/admin API; S04b SDK/OTel/consoles; this closing slice (S04c): remaining screens, Playwright E2E in `ar`/`en` with axe and stored screenshots, security headers, operation-cancel audit, M01 report.

## C. Implemented features, API and UI screens
- **API:** 55 operations declared and implemented (`spec:drift` two-way), problem+json with stable codes, idempotency, ETag/If-Match, cursor pagination, cross-tenant tests generated from the spec.
- **Data:** schemas `platform`, `identity`, `tenancy`, `audit` (migrations 0001–0010), forced RLS everywhere, append-only hash-chained audit with signed checkpoints.
- **Customer console** (`apps/web`, `ar` RTL default / `en`): login (UI-M01-01), MFA enrol with QR (-03), recovery codes (-05), create organization (-06), dashboard (-07), organization settings with ETag (-08), members with role change/remove (-09), invitations + accept page (-10/-11), workspaces (-12), projects (-13), environments (-14), API keys with secret-once (-15), sessions (-16), audit log (-17), notifications (-18), operations (-19), resources empty state (-20), agency/reseller shells (-21/-22). Step-up MFA is answered inline and the action retried.
- **Admin console** (`apps/admin`): admin login with mandatory MFA enrol/challenge (-23), organizations with suspend/reinstate (-24), users with impersonation form (-25), cross-organization audit viewer, feature flags.
- Shared: `packages/ui` (tokens, logical-property CSS, accessible components), `packages/i18n`, `packages/sdk` (generated), `packages/telemetry`.

## D. Migrations and rollback
0001–0010, each with `.down.sql` (dev/staging). Production is forward-only; first-release rollback = restore a snapshot ([runbook](../runbooks/restore-db-from-dump.md), NOT VERIFIED). The audit down-migration drops the schema and must never run in production.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0 in 290 s** (read from the run's own log line; two earlier runs failed on unused imports and on an integration spec that built a module without the audit module, both fixed).
- Lint, typecheck, build: 19/19 and 11/11 turbo tasks (both Next.js apps build). Unit: i18n 9, domain 6, db 9, ui 7, telemetry 3, web 5, worker 4, admin 5, sdk 4, api 25 (**77**).
- Integration on real PostgreSQL: db 43, platform 31, api 192 (**266**), including the spec-generated cross-tenant suite.
- `spec:lint` clean; `spec:drift` OK (55 operations declared and implemented, two-way); `sdk:check` up to date; `scan:secrets` 341 files, 0 hits; `db check` OK.
- **E2E: `pnpm test:e2e` → EXIT=0, 4 passed** (customer + admin flows × `ar` and `en`, real API + dev IdP + built Next.js apps + system Chrome 157), 27 screens per locale each checked for `lang`/`dir` and axe WCAG 2.0/2.1 A+AA (including colour contrast) with **zero violations**, screenshots stored in `docs/reports/screenshots/{ar,en}/` (secrets masked). Playwright's bundled Chromium does not support macOS 13, so the installed Chrome is used (`channel: 'chrome'`).
- Not run: load smoke, DB-failover test, real IdP, Redis, CI.

## F. Security, tenant isolation, billing, residency verification
- **Isolation:** forced RLS; every `{id}` route returns 404 for a foreign org (session and API key), generated from the spec; admin routes refuse tenant sessions and keys; worker role limited to claim scope; audit chain heads unreachable by runtime roles.
- **Auth:** OIDC code + PKCE, hash-only sessions, CSRF, fixation defence, return-to allow-list, lockout, step-up, mandatory admin MFA, realm separation (including two consoles on one cookie host).
- **Audit:** every mutation writes a chained event; tamper detection verified against a privileged attacker; **audit rows are written after commit, not in the same transaction** (limitation, fix before M02).
- **Headers:** CSP (with `'unsafe-inline'` scripts until nonce-based CSP in M12), HSTS, nosniff, frame-deny, referrer, permissions-policy on both Next.js apps; the API sets nosniff/no-store/referrer. A header scan test is NOT written (the headers are configured and the E2E passes under them).
- **Billing/residency:** not in scope; `ResidencyPolicy` is an allow-all stub **NOT VERIFIED — M04**.

## G. Human gates and live checks still needed
| HG/D | Status |
|---|---|
| HG-01-01 repository/CI access | BLOCKED: no remote; CI defined, never run |
| HG-01-02 / D-04 IdP | BLOCKED: only a dev test IdP; a client + redirect URI per console needed |
| D-12 vault/KMS | BLOCKED: dev stand-ins (seal key, audit keys, TOTP secrets) |
| D-13 observability backend | OPEN: OTel emits, no collector verified |
| D-03 BullMQ/Redis | OPEN: not needed yet; Redis not installed |
| D-08 mail provider | OPEN (M08): notifications/invitations are logged in dev, refused in production |
| PA-12/17/18, `POST /v1/admin/organizations`, impersonation approval model, audit partitioning | owner decision required |
| Brand assets, Hijri flag (D-32) | placeholders |

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| Greenfield bootstrap, commands verified | PASS | S01, `pnpm verify:full` |
| OIDC login + sessions + MFA + recovery + step-up + API keys | PASS (dev IdP only; real IdP NOT VERIFIED) | S02/S03 reports, E2E |
| Orgs, memberships, invitations, workspaces/projects/environments, RBAC | PASS | S03 report, 42 + 49 generated tests, E2E |
| RLS on every tenant table; cross-tenant 404 on every id route | PASS | `db check`, generated suite |
| Platform mechanisms (operations, outbox, idempotency, flags, notifications) | PASS | S02 + S04a |
| Hash-chained audit, tamper detection, signed checkpoints, verifier job | PASS (key is a dev stand-in) | S04a |
| Audit partitioning (monthly) | NOT DONE | needs owner change-log entry |
| Admin: orgs, users, impersonation, flags, audit viewer | PASS | S04a/S04b, E2E |
| Admin: operations monitor | NOT DONE | no endpoint in docs/04 M01 list |
| Generated SDK; consoles use only the SDK | PASS | `sdk:check` |
| UI-M01-01…29 | PASS for 01, 03, 05–10, 12–18, 20–26 and 27 (viewer only); **NOT DONE**: 02 (callback is a server redirect), 04 (challenge is inline/step-up and the admin gate; no standalone `/auth/mfa-challenge` page), 19 (list + cancel exist; no detail drawer with steps), 28 (all-org operations monitor: no admin endpoint in docs/04), 29 (role/permission matrix viewer). Partial: 11 (accept page exists; the mail-link flow is not E2E-tested because the token only appears in the mail), 26 (global flags only; no per-org scope in the UI), 27 (no chain-verification result: needs PA-17) | E2E, screenshots |
| i18n `ar`/`en`, RTL, no physical-direction CSS | PASS | catalog parity test, CSS test, E2E `lang`/`dir` assertions |
| Accessibility: axe on all built screens in both locales (incl. contrast) | PASS for the 27 screens/locale covered by E2E; keyboard-only walkthrough **NOT DONE**; RTL screenshot **diff** NOT DONE (screenshots are stored, not diffed) | `docs/reports/screenshots/` |
| E2E (Playwright, `ar` + `en`) | PASS for login/MFA, org, workspace/project/environment, API key secret-once, audit with filter, invitation create/revoke, settings, admin MFA, suspend/reinstate with customer blocked; **NOT DONE**: invitation accept via mail link, impersonation start + banner, audit integrity badge (PA-17) | `e2e/` |
| Concurrency/failure/security test families in M01 §11 | PASS for those listed in the sprint reports; **NOT DONE**: DB failover during outbox relay, header-scan test | S02/S03/S04a |
| Load smoke (200 rps `/v1/me`) | NOT DONE | record-only item |
| Observability | traces and metrics instruments PASS; backend NOT VERIFIED; structured log helper not yet used by the API | S04b |
| Runbooks + demo script | PASS as written; restore and break-glass NOT VERIFIED; demo lives in `local-setup.md` (M01 §12 names `demo-m01.md`) | `docs/runbooks/` |
| Security headers on both Next.js apps | PASS (configured, E2E green); scan test NOT DONE | `next.config.mjs` |

## I. Next-milestone handoff and open decisions
- M02 (ledger, metering, entitlements) can start from: `platform.operations/outbox/idempotency`, `audit` (with the same-transaction audit fix first), RBAC with seeded `billing_admin`/`finance`, the SDK and UI kit.
- Before M02: make audit same-transaction (outbox), decide partitioning, confirm the additive contract changes in §A, resolve the closed-form of UI-M01-02/04/11/19 with the owner.
- Gate review: use `templates/gate-review-template.md`; the owner signs, or lists NOT DONE rows as DEFERRED with change-log entries.
