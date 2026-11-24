# DEFECT-19: the "no default database" guarantee holds only in a shell that sourced `session-env.sh`

Found by: P3-S08 (independent verification of the test-environment allocator), 2026-11-24 · Component: `scripts/testenv` allocator and its consumers, `integration/ai-engine` @ `edce169c` · Severity: **Medium-Low** (process/design: the stated guarantee is "permanently prevents ... any access to another session's (or the owner's) database") · Owner (fixer): Master · State: **OPEN**

## What is wrong
The allocator itself is sound (see below). What it cannot do is protect a shell that never took a lease. The consumers refuse the owner's development database only when `NUZM_FORBID_DEFAULT_DB=1`, which `session-env.sh` exports. Without it the old fallback is live:
- `packages/db/src/cli.ts`: `DATABASE_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev'` (its own comment: "Without a lease (the owner's own shell) the development default still applies");
- `apps/api/src/dev/{dev-stack,grant-ai-credits,set-password}.ts`: the same `?? ...:54329/nuzm_dev` defaults;
- `scripts/dev-services.sh`: `PGPORT="${NUZM_PGPORT:-54329}"` (guarded only when `NUZM_LEASE_ID` is set).
That is exactly the incident class that motivated the allocator: a session ran `pnpm db:migrate` / `db:dev-logins` without a URL and reached :54329. A session that forgets to `source scripts/session-env.sh` (or opens a new shell) is unprotected again; the guard is opt-in per shell, the hazard is opt-out.

## Proof (static, no database contacted)
`apps/api/src/qa/qa-p3-testenv-allocator.spec.ts::DEFECT-19` (an `it.fails` while open): none of the four fallback sources has a guard that works without a lease (no opt-in variable, no session-worktree check). Proving run before the allocator is merged: `P3_S08_TESTENV_TREE=<tree extracted from edce169c> vitest run src/qa/qa-p3-testenv-allocator.spec.ts` -> 13 passed, 1 expected fail. I did not execute any of those tools without a lease (it would connect to the owner's database).

## Suggested fix (the owner of the allocator decides)
Invert the default: the owner's development database becomes reachable only with an explicit opt-in the owner sets in their own profile (for example `NUZM_ALLOW_OWNER_DEV_DB=1`), and is refused otherwise; or refuse the fallback whenever the working directory is inside `.claude/worktrees/`. The same for `dev-services.sh`. After the fix the `it.fails` turns red; I flip it and adjust the pattern if the guard takes another form.

## What the independent verification confirmed (11 black-box tests, throw-away allocator root, `--no-pg` leases, no cluster, no real database)
Distinct ports in 54400-54999, also under 12 parallel acquisitions; a taken, protected (54329, 54339, 5432, 5433) or system port is refused (exit 3); the capacity cap holds; the preflight accepts only this session's own lease and refuses a missing URL, a bad scheme, non-loopback hosts (`10.x`, `0.0.0.0`, a name), protected ports (also the default port and a zero-padded spelling), an unleased port (including :54341), a foreign lease (both directions), an expired lease and a missing lease id; the vitest global guard also refuses a stray `DATABASE_URL`, `DATABASE_ADMIN_URL` or `WORKER_DATABASE_URL` on a protected or foreign database; `release` refuses path-like ids and deletes only its own lease directory.

## Observation O-18 (documented limit, not registered)
The explicit CI policy (`CI=true` and `NUZM_TEST_DB_POLICY=ci`) skips the lease registry: it accepts any non-protected loopback port, including another session's lease port and :54341. It needs both variables, which no session environment sets; if CI containers ever share a host with leases, make the policy also refuse every port that has a live lease. Also: the protected-port list is `54329, 54339, 5432, 5433`; :54341 (the Master's own database) is covered only by the lease rule, not by the list.
