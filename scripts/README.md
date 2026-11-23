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
- `pnpm verify` (CI: static checks and unit tests) and `pnpm verify:full` / `pnpm verify:full:isolated` (everything incl. integration and E2E).
- `zatca-spec-guard.ts` hashes the nine generator files **and `packages/domain/src/ids.ts`** (the UUID pattern the validator imports).
