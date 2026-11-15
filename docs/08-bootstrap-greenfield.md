# Nuzm — Greenfield Repository Bootstrap (executed as Sprint S01 of M01, after HG-00-01)

The project directory is empty (aside from `docs/`). This procedure creates the repository skeleton. It does **not** implement product features. Commands below are the *target* interface; they do not exist until S01 creates them, and the agent must report real output, not assumed output.

## 0. Preconditions
- HG-00-01 documentation approved; D-01 (git host/CI), D-02, D-30, D-32 answered. If D-01 is unanswered, bootstrap targets GitHub Actions as a reversible default and records the assumption.
- Tooling present on the machine is **verified, not assumed**: record `node -v`, `pnpm -v`, `docker --version`, `git --version`, `psql --version`. Missing tool → BLOCKED with install instruction, do not work around by silently changing the stack.

## 1. Steps
1. `git init`, default branch `main`, `.gitignore`, `.editorconfig`, `.gitattributes`, `LICENSE` placeholder (owner decides), `CODEOWNERS` placeholder.
2. Workspace: `pnpm-workspace.yaml`, root `package.json` (private), `turbo.json`, `tsconfig.base.json` (strict), `.nvmrc`/engines pin.
3. Create directories exactly as in `02-system-architecture.md §2`, each package with `package.json`, `tsconfig`, `README.md` (purpose + owner + public API). Empty packages contain no fake logic.
4. Move/keep the approved docs in `docs/`; create `docs/adr/` with ADR-001..016 as **Proposed**, `docs/reports/` with templates (`milestone-report.md`, `gate-review-template.md`, `evidence-index.md`), `docs/runbooks/`.
5. **Machine-readable spec skeleton** (`spec/`):
   - `spec/openapi/openapi.yaml` + per-module files, seeded from `04-unified-api-specification.md` as `x-milestone` tagged *planned* operations (no handlers); `errors.yaml`.
   - `spec/db/ownership.yaml` seeded from `05-…`; `spec/milestones/milestones.yaml` from `03-…`/`06-…`; `spec/providers/capabilities.schema.json`; `spec/compliance/controls.yaml` (empty catalogue); `spec/events/*.json`.
6. Tooling: ESLint (with module-boundary rule), Prettier, `@typescript-eslint` strict, commit hooks, Conventional Commits, `knip`/dependency-cruiser style boundary check (tool choice recorded in ADR), Spectral for OpenAPI lint, secret scanner, dependency audit, license check, SBOM generation.
7. Local environment: `docker-compose.yml` with PostgreSQL, Redis, a mail catcher, an S3-compatible dev emulator, a dev IdP (per D-04), OpenTelemetry collector; `.env.example` with **no real secrets**; `scripts/dev-vault` stub (file-backed, dev only, clearly non-production).
8. App skeletons: `apps/api` (NestJS with health endpoint only), `apps/worker`, `apps/web` and `apps/admin` (Next.js with i18n/RTL scaffold and an empty shell), `packages/ui` with design tokens only.
9. DB: `packages/db` with migration runner, role bootstrap migration (roles in §2.9 of doc 05), RLS test harness, ownership checker.
10. CI pipeline (target jobs): install → lint → typecheck → unit tests → build → spec-lint → spec-drift check → migration apply from empty → RLS/ownership test → dependency/secret scan → SBOM. Required status checks documented.
11. Root scripts (names fixed so `CLAUDE.md` stays valid): `pnpm verify` (all of the above), `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm spec:lint`, `pnpm spec:drift`, `pnpm db:migrate`, `pnpm db:test-rls`, `pnpm dev`.
12. Update `CLAUDE.md` "Commands" section with the *actual verified* commands and their real runtimes.
13. Produce `docs/reports/S01-bootstrap-report.md` with actual outputs.

## 2. Bootstrap exit criteria (all measurable)
| # | Criterion | Evidence |
|---|---|---|
| B1 | `pnpm install --frozen-lockfile` succeeds from clean clone | log |
| B2 | `pnpm verify` exits 0 on skeleton | log |
| B3 | `docker compose up` brings Postgres/Redis healthy; `pnpm db:migrate` applies from empty | log |
| B4 | `GET /healthz` on API returns 200 locally; web and admin render shell in `ar` (RTL) and `en` | screenshots/logs |
| B5 | `spec:drift` fails when an endpoint in code is not in OpenAPI (negative test shown) | log |
| B6 | Module-boundary lint fails on a deliberate cross-module import (negative test shown, then removed) | log |
| B7 | ADR-001..016 exist with status Proposed; human-owned ones listed | files |
| B8 | CI definition committed; first run result recorded (or BLOCKED if D-01/HG-01-01 pending) | run link/log |
| B9 | No secrets in repo; secret scanner clean | log |

## 3. Things bootstrap must not do
Create fake provider adapters that appear to work; commit credentials; choose an IdP/PSP/vault/data provider that is still OPEN without marking the choice a reversible dev default; implement M01+ features early.
