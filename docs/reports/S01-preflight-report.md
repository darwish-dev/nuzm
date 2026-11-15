# S01 Bootstrap Report (2026-11-16) — PARTIAL (B3 Postgres half done; Redis pending; B8 blocked)

Spec basis: approved docs v4.0-draft (the conflicting execution-pack PDF was resolved in favour of them: `pdf-v4-execution-pack-conflicts.md`). Decisions: D-01 local-only git, D-02 sequential, D-30 SLO proposals accepted, D-32 Arabic default. Nothing is committed (owner has not asked).

## A. Tool inventory (actual)
node v22.15.0 · npm 10.9.2 · **pnpm 10.34.9** (installed 2026-11-16 via `corepack prepare pnpm@10.34.9 --activate`; corepack 0.32.0 could not run pnpm 12.x, so 10.x is pinned in `packageManager`) · git 2.39.2 · psql 16.14 client · **docker: NOT AVAILABLE** — Docker Desktop and OrbStack both require macOS ≥ 14 and this Mac is 13.7.8 (checked with `brew info --cask`). Owner chose Homebrew-based local services (2026-11-16). A Homebrew PostgreSQL 16 server (owner's, port 5432) is running on this machine and was **not touched**; the project uses its own throwaway cluster (below). Redis: `brew install redis` started, compiling from source (Homebrew Tier 3 on macOS 13), not finished at time of writing.

## B. Bootstrap exit criteria (docs/08 §2)
| # | Criterion | Status | Evidence |
|---|---|---|---|
| B1 | `pnpm install --frozen-lockfile` from clean copy | **PASS** | Clean rsync copy (no node_modules/.git) installed: "Done in 12.2s" |
| B2 | `pnpm verify` exits 0 | **PASS** | exit 0; 8/8 turbo tasks; tests: api 2, i18n 5, ui 2 passed; 11 s with warm turbo cache (first cold run also exit 0) |
| B3 | Local Postgres/Redis healthy; `db:migrate` from empty | **PARTIAL: Postgres PASS, Redis PENDING** | Project-local PostgreSQL 16.14 cluster on 127.0.0.1:54329 (`scripts/dev-services.sh`, data in gitignored `.dev-data/`). `pnpm db:migrate` applied `1:roles_and_schema` to an empty `nuzm_dev`; re-run: `no pending migrations`. Integration suite (10 tests, real Postgres) applies from an empty database, is idempotent, serialises 3 concurrent migrators (exactly one applies), detects tampered checksums, rolls back via `.down.sql`, and verifies RLS isolation through `SET LOCAL ROLE nuzm_app`. Redis: not yet installed |
| B4 | `/healthz` 200; web and admin render shell in ar (RTL) and en | **PASS (HTML evidence; no screenshots)** | api `GET /healthz` → 200 JSON, unknown → 404; web & admin: `/ar` → `<html lang="ar" dir="rtl">`, `/en` → `dir="ltr"`, `/` → 307 `/ar`, `/fr` → 404 |
| B5 | spec drift fails on undeclared route | **PASS** | Temporary `GET /tmp/undeclared` → "SPEC DRIFT … missing from openapi.yaml", exit 1; file removed, check green again |
| B6 | module-boundary lint fails on forbidden import | **PASS** | First attempt did NOT fire (pattern too weak) — rule fixed; then `../health/internal/status` import → `no-restricted-imports` error, exit 1; legit imports pass; temp file removed |
| B7 | ADR-001..016 Proposed + human-owned list | **PASS** | `docs/adr/` 16 files; open ones tied to D-03/04/11/12/14/21/35 |
| B8 | CI definition committed; first run recorded | **BLOCKED** | `.github/workflows/ci.yml` written but never run: no remote (D-01) |
| B9 | No secrets in repo; scanner clean | **PASS (limited)** | `scan:secrets`: 121 files, 7 rules, 0 hits. Home-grown scanner; a dedicated scanner (e.g. gitleaks) is deferred to CI |

## C. Built in S01
`packages/db` (CJS, `pg`): ordinal-range-validated migration discovery, checksummed forward-only runner with advisory lock and dev rollback, ownership+RLS checker (RLS enabled AND forced, policy present, tenant-less tables explicit, no unknown schemas/tables), migration `0001__platform__roles_and_schema` (4 NOLOGIN roles + `platform` schema) with `.down.sql`; 9 unit + 10 integration tests. Root scripts: `services:start|stop|status`, `db:migrate`, `db:test-rls`, `test:integration`, `verify:full`.

Workspace (pnpm + Turborepo, strict TS), ESLint flat config with boundary rules, Prettier, `apps/api` (NestJS + Fastify, health module only), `apps/worker` (empty skeleton, no jobs), `apps/web` and `apps/admin` (Next.js, ar/en shells, `[locale]` routes), `packages/i18n` (ar/en, RTL dir, SAR minor-unit formatting; money rule tested), `packages/ui` (placeholder tokens, logical properties only; brand assets still owed, D-32), `spec/openapi/openapi.yaml` (1 implemented operation) + `planned-paths.yaml` (195 planned paths generated from docs/04; 57 shorthand tokens skipped), `spec/milestones`, `spec/db`, drift and secret scripts, CI file, `.env.example`.

## D. Not done / known gaps
- Redis start/health (B3 half) and a Redis connectivity check; dev IdP and vault stub (wait for D-04/D-12). `docker-compose.yml` is intentionally not written (no container engine on this macOS version); the Homebrew-based `scripts/dev-services.sh` replaces it for local dev, and a container setup can be added when an engine is available.
- Tools not yet used: SBOM generation, dependency license check, `pnpm audit` (CI-only, no remote), commit hooks/commitlint.
- `pnpm approve-builds` not run: esbuild/@scarf build scripts are ignored by pnpm 10; everything verified works without them.
- Boundary lint is convention-based (`./internal/` rule), not a full dependency graph check.
- Drift check is regex-based on Nest decorators (dynamic routes are reported as errors, not understood).
- Web/admin typecheck script regenerates Next types silently before `tsc`; verified working in `pnpm verify`.
- OpenAPI planned-paths inventory is path-only; methods/bodies come from each milestone.

## E. Needed from the owner
1. Nothing for B3 beyond waiting for the Redis build (or `brew install redis` finishing in your own terminal).
2. Before M01 S02: D-04 identity provider, D-12 vault, D-03 workflow engine (all OPEN).
3. Say whether to commit S01 work to the local `main` branch.
