# Runbook — local setup and demo (M01)

Scope: a developer machine (macOS 13, no Docker). Nothing here touches a real provider, IdP or production data.

## 1. Prerequisites
- Node 22, pnpm 10.34.9 (pinned in `package.json`), Postgres 16 (project-local cluster, see below).
- `pnpm install --frozen-lockfile`

## 2. Data services
```bash
pnpm services:start      # project-local Postgres on 127.0.0.1:54329 (Redis is NOT installed yet)
pnpm db:migrate          # applies migrations 0001-0010 to nuzm_dev
pnpm db:dev-logins       # DEV ONLY: LOGIN + throwaway password for nuzm_app / nuzm_worker
```
`pnpm services:status` shows what is running. The database user `nuzm_admin` (trust auth, local only) is used for migrations and test setup; the API runs as `nuzm_app` and the worker as `nuzm_worker` (both bound by RLS).

## 3. Run the stack (API + dev identity provider + both consoles)
```bash
pnpm --filter @nuzm/api dev:stack            # API :4000 + dev IdP :4010 (user picker). Builds first.
pnpm --filter @nuzm/web exec next dev -p 3000 -H 127.0.0.1
pnpm --filter @nuzm/admin exec next dev -p 3001 -H 127.0.0.1
```
Use `127.0.0.1` (not `localhost`) everywhere: the OIDC redirect URI and cookies are tied to that host. The consoles proxy `/v1/*` to the API so session cookies are first-party.

The dev IdP is a **test double**, not an IdP choice (D-04 is open). It lists three users: `owner@example.test`, `viewer@example.test`, `staff@example.test`.

## 4. Demo script (about 5 minutes)
1. Customer console `http://127.0.0.1:3000/ar/login` → sign in as the owner → "create your first organization" → create one. The dashboard shows the org, unread notifications and the first audit event (`tenancy.organization.created`). Switch `ar`/`en` in the top bar (RTL ↔ LTR).
2. Admin console `http://127.0.0.1:3001/en/login` → sign in as `staff@example.test` → **refused** (not a platform user).
3. Grant a platform role (local DB only): `pnpm --filter @nuzm/db exec tsx src/cli.ts grant-platform-role staff@example.test platform_admin`
4. Sign in to the admin console again → set up two-factor (QR or manual key; for a throwaway dev secret you can compute codes with `otpauth`) → you land on Organizations.
5. Suspend the organization with a reason. In the customer console the owner now sees the suspended banner and panels; the owner has an in-app notice (and a dev-mail line). Reinstate it (a stale MFA triggers the inline step-up challenge).
6. Audit: customer console → Audit log shows the events; admin console → Audit log (all organizations) shows the same chain plus the platform chain events, and reading it is itself audited.

## 5. Tests
```bash
pnpm verify          # lint, typecheck, unit, build, spec lint, spec drift, sdk check, secret scan
pnpm verify:full     # verify + migrate + RLS check + all integration tests (needs the services running)
```
Integration suites create throwaway databases (`nuzm_test_*`) and drop them afterwards.

## 6. Known local-only limitations
- No Redis (not needed until rate limiting/BullMQ, D-03); no real mail provider (invitations/notifications are logged); no real IdP; CI has never run (no remote, HG-01-01).
- Both consoles share one OIDC redirect URI in dev (the web console's). Production needs a client/redirect URI per console (D-04, HG-01-02).
