# scripts

Repo scripts (verify, spec drift, screen-index generator).

- Owner milestone: see `docs/03-milestone-dependency-matrix.md`.
- Public API: none yet (nothing implemented in S01).
- Status: **skeleton only**.

## Test commands (2026-11-22)

- `pnpm test` / `pnpm test:unit`: DB-free unit tests of every workspace package, **no browsers** (`turbo run test --concurrency=${TEST_CONCURRENCY:-2}`; the Playwright package has no `test` script, so turbo skips it).
- `pnpm test:integration`: needs `pnpm services:start`.
- `pnpm test:e2e`: browser E2E on the fixed ports; `e2e/preflight.mjs` runs first and reports which process holds a port (it never stops one). `E2E_SKIP_PREFLIGHT=1` skips it.
- `pnpm test:e2e:isolated` (`scripts/e2e-isolated.sh`): free ports, throw-away database, rebuild for those ports, drop on exit. `E2E_PG_PORT` selects the Postgres cluster (default 54329), `E2E_WEB_PORT`/`E2E_ADMIN_PORT`/`E2E_API_PORT`/`E2E_IDP_PORT` fix the ports instead of picking free ones, `E2E_SKIP_BUILD=1` reuses a build made for the same ports (so only together with fixed ports), `E2E_SERVER_TIMEOUT_MS=600000` gives the servers longer to start on a busy machine, extra arguments go to Playwright.
- `scripts/e2e-stack.sh start|run|restart|status|stop`: a persistent isolated E2E stack (free ports, its own database, apps built once) so specs can be run repeatedly with `scripts/e2e-stack.sh run --project=ar tests/<spec>`; `start` after any UI source change (it rebuilds), `restart` for a fresh database without a rebuild; `E2E_PG_PORT` selects the Postgres cluster.
- `pnpm verify` (CI: static checks and unit tests) and `pnpm verify:full` / `pnpm verify:full:isolated` (everything incl. integration and E2E).
- `zatca-spec-guard.ts` hashes the nine generator files **and `packages/domain/src/ids.ts`** (the UUID pattern the validator imports).

## Test environments (central allocator, mandatory for integration and E2E runs)

Parallel sessions once collided on database ports and one ran `db:*` against the owner's development cluster through a silent default. That is now structurally impossible:

- `node scripts/testenv/testenv.mjs acquire --owner <name>` (or `source scripts/session-env.sh <name>`) takes a **lease**: a unique, atomically reserved port (range 54400-54999; the owner's `:54329` and other dev/system ports are protected), its own PostgreSQL cluster in its own data directory under `/private/tmp/nuzm-testenv`, a random per-lease password (scram-sha-256; exported as `PGPASSWORD`), and a 12 h registry entry. It exports `NUZM_TEST_ADMIN_URL`, `DATABASE_ADMIN_URL`, `E2E_PG_PORT`, `NUZM_LEASE_ID`, `NUZM_FORBID_DEFAULT_DB=1`.
- Every integration vitest config runs `scripts/testenv/guard.mjs` as global setup and `e2e/preflight.mjs` runs the same check: `NUZM_TEST_ADMIN_URL` is **mandatory**, loopback only, never a protected port, and must be the port of a live lease that belongs to **this** session (`NUZM_LEASE_ID`). There is no fallback. `packages/db/src/cli.ts`, the dev tools and `dev-services.sh` also refuse the default database inside a leased environment.
- `testenv.mjs status | renew <id> | release <id> | gc | check-url [URL]`. Release stops only a cluster whose `postmaster.pid` matches the lease and deletes only directories inside the allocator root. The number of concurrent leases is capped by CPU count and available memory (`NUZM_TESTENV_MAX_LEASES` overrides).
- CI exception (explicit): `CI=true` with `NUZM_TEST_DB_POLICY=ci` accepts a non-protected loopback service port without a lease.
- Tests of the allocator (collisions, cross-session access, missing/unsafe URLs, capacity, safe cleanup, a real cluster whose password keeps another session out): `pnpm testenv:test` (part of `pnpm verify`).

Notes on leased E2E stacks: `e2e-stack.sh start` and `e2e-isolated.sh` run `db dev-logins` after the migration because a fresh leased cluster has no LOGIN for the runtime roles `nuzm_app`/`nuzm_worker` (cluster-wide, idempotent). Do not pipe `e2e-stack.sh start` into `tail`/`head`: the background dev stack keeps the pipe open and the command never returns; redirect to a file instead (`e2e-stack.sh start > /tmp/stack.log 2>&1`).
