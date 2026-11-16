# S04b report — SDK, OpenTelemetry, customer and admin consoles (M01 sprint 4, frontend half)

Status: **implemented, verified against real PostgreSQL and exercised in the browser; M01 is NOT complete** (see §H). Not committed.

## A. Repository findings and assumptions
- Next.js 16 renamed `middleware` to `proxy`; the consoles use `proxy.ts`. Vite 8 uses `oxc` (not `esbuild`) for the JSX transform in tests.
- tsx/esbuild does not emit decorator metadata, so Nest DI fails under `tsx`; `dev` and `dev:stack` now compile with `tsc` first. (The previous `dev` script could not have worked.)
- Both consoles proxy `/v1/*` to the API (Next rewrites), so session cookies are first-party and no CORS is needed. In dev both consoles share the host `127.0.0.1` and therefore share cookies: each console now forwards **only its own realm's cookies** server-side, and sends `X-Nuzm-Realm` from the browser, so one console can never use the other's session.
- Admin sign-in did not exist in the API (S02 only created admin sessions in tests). Added `GET /v1/auth/oidc/login?realm=admin`: only platform users get an admin session; others get 403 and a failure audit event.
- The admin console could not complete MFA after the first enrolment (the client had no way to know its factor id). Added `mfaFactorId` to `GET /v1/me` and to the `mfa_required` problem body (additive fields, no new endpoint).
- Dev IdP: a user-picker mode was added to the test IdP (`apps/api/src/modules/identity/testing/test-idp.ts`) and `pnpm --filter @nuzm/api dev:stack`. It is a test double, not an IdP choice (D-04 open).

## B. Plan and changed files
- `packages/sdk`: generated `src/schema.ts` from `spec/openapi/openapi.yaml` (`pnpm sdk:generate`; `pnpm sdk:check` is part of `pnpm verify`), thin client (org selector, CSRF, realm, forwarded headers), `ApiError`/`unwrap`. Response schemas for the screens were added to the spec (`Me`, `AuditPage`, `NotificationPage`, `MemberPage`, `AdminOrganizationPage`, `AdminUserPage`).
- `packages/telemetry`: OTel traces (W3C `traceparent` continued or minted, optional OTLP/HTTP export), HTTP metrics instruments, structured JSON log helper. Wired into the API (request span per request, route-pattern labels) and the worker (span per tick).
- `packages/i18n`: full Arabic/English catalog, `{param}` substitution, placeholder-parity test, Asia/Riyadh date formatting with Latin digits.
- `packages/ui`: design tokens + logical-property base CSS, accessible components (shell with skip link, nav, table, fields, empty/error/forbidden/skeleton states, banner, LTR islands), client widgets (locale switch, TOTP enrol with QR + manual key, MFA challenge).
- `apps/web` (customer console), `apps/admin` (admin console): see §C.
- Runbooks: `docs/runbooks/{local-setup,rotating-dev-secrets,restore-db-from-dump,break-glass-draft}.md`.

## C. Implemented screens (UI-M01 ids)
Customer console (`ar` RTL default, `en` LTR): UI-M01-01 login, -03 MFA enrol (QR + manual key), -06 create organization, -07 dashboard home, -09 members (read-only list), -17 audit log (filter, cursor), -18 notifications (mark read/unread), -21/-22 agency/reseller shells (org-type gated, "available in M11"). Org switcher, permission-gated navigation, suspended/forbidden/error states with trace id, impersonation banner.
Admin console: -23 admin login + mandatory MFA (enrol or challenge), -24 organizations (search, suspend with reason, reinstate, inline step-up challenge), -25 users (search, impersonation form with reason/TTL/approval reference), cross-organization audit viewer, feature flags.

## D. Migrations
None in this slice (S04a added 0007–0010).

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0 in 272 s** (read from the run's own log line).
- Lint, typecheck, build: 18/18 and 11/11 turbo tasks (both Next.js apps build). Unit tests: i18n 9, db 9, domain 6, admin console 5, web console 5, sdk 4, telemetry 3, api 25, worker 4, ui 7 (**77**).
- Integration on real PostgreSQL: db 43, platform 31, **api 192** (admin-realm sign-in, `X-Nuzm-Realm`, `mfaFactorId`, platform roles in `/v1/me` added since S04a) = **266**.
- `spec:lint` clean; `spec:drift` OK (55 operations); `sdk:check` up to date; `scan:secrets` 315 files, 0 hits; `db check` OK.
- Manual browser pass (in-app browser, real API + dev IdP + both consoles): customer login → create organization (Arabic) → dashboard/audit/members/notifications in `ar` and `en`; admin login refused for non-staff → role grant → MFA enrol (QR) → organizations → suspend → customer sees suspended panel and banner → challenge on a fresh session → forced-stale MFA → inline step-up → reinstate retried automatically. Not automated, no stored screenshots.
- Not run: Playwright/axe against built pages, load smoke, real IdP, Redis, CI.

## F. Security, tenant isolation, billing, residency
- Realm isolation between consoles (cookie forwarding + `X-Nuzm-Realm`), tested at the API (`admin.int.spec.ts`: both cookies present, hint decides) and found by manual browser testing first.
- Admin sign-in refuses non-staff (403 + audit); MFA is mandatory; step-up works inline and retries the original action.
- A hash-chained audit event is written for every console mutation; the browser pass confirmed the customer console shows the real events.
- Billing/residency: not touched.

## G. Human gates and live checks still needed
- Real IdP (D-04, HG-01-02) with a client and redirect URI per console; production domains; Hijri display flag; brand assets (D-32): tokens are placeholders.
- No CI run (HG-01-01).

## H. Acceptance (S04 / M01 rows touched)
| Row | Status |
|---|---|
| SDK generated from OpenAPI; portals use only the SDK | PASS for the implemented screens (all calls go through `@nuzm/sdk`; `sdk:check` guards drift) |
| OpenTelemetry traces + metrics + logs | PASS for traces (propagation tested) and metric instruments; **NOT VERIFIED** against a real backend (no collector; D-13 open); log helper exists but the API still uses Nest's logger |
| Portal shells, org switcher, nav gating, i18n/RTL | PASS (browser-checked in `ar` and `en`) |
| Accessibility tooling | PASS for component-level axe tests (jsdom, colour contrast excluded); **NOT DONE**: axe in CI against built pages, colour-contrast check, keyboard-only walkthrough |
| E2E tests (Playwright) and screenshots per screen/locale | **NOT DONE**. Screens were driven by hand in the in-app browser (login → org → audit → suspend → step-up → reinstate); no automated browser suite, no stored screenshots |
| UI-M01-02/04/05/08/10/11/12/13/14/15/16/19/20 | **NOT DONE** (callback page is handled by the API redirect; recovery codes, org settings, invitations screens, workspaces/projects/environments, API keys, sessions, operations, resources) |
| UI-M01-09 members: role change/remove, UI-M01-18 preferences, UI-M01-17 CSV export + integrity badge | **NOT DONE** (read-only list; preferences/integrity need PA-17/PA-18) |
| Admin: operations monitor, feature flag per-org scope in UI | **NOT DONE** |
| Runbooks (local setup, rotating secrets, restore, break-glass draft) | PASS as written; restore and break-glass are **NOT VERIFIED** procedures |
| `docs/reports/M01-report.md` | **NOT DONE** (written when the remaining rows are closed or deferred with the owner) |

## I. Handoff and open decisions
- Next: close the NOT DONE rows above (invitations/API keys/sessions/recovery-codes/workspaces screens first), add Playwright with `ar` and `en` projects + axe + stored screenshots, then write the M01 report and ask for the gate review.
- Owner decisions: unchanged from S04a (PA-12/17/18, `POST /v1/admin/organizations`, impersonation approval model, audit partitioning) plus: OIDC client per console (D-04); whether `mfaFactorId` on `/v1/me` and on `mfa_required` is acceptable (additive contract change made to unblock admin MFA).
- Known UX gaps: an OIDC callback failure shows the raw problem+json page (the API answers the browser directly); the dev stack's dev-vault seal key now persists in `apps/api/.dev-vault/` (git-ignored).
