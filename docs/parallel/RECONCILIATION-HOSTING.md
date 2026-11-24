# Reconciliation plan: AI-engine line and the HestiaCP hosting line (prepared, NOT executed)

Date: 2026-11-24 · Author: Master · Status: dry run done in a throwaway worktree (scratch directory, since removed); neither branch was changed. Nothing is merged; nothing is pushed (D-01); no owner decision to join the lines exists yet.

Lines: **A** = `integration/ai-engine` (this effort). **B** = `claude/merge-branches-run-import-295c4d` @ `3460525c` (HestiaCP replaces CloudPanel, Dynadot, desktop/mobile/landing work, knowledge/agent merges; sibling branches `friendly-mirzakhani-43fa75`, `modest-nash-bee4e2`, `quizzical-gagarin-0ba54f` point at the same commit).

## 1. Dry-run result (`git merge --no-commit --no-ff B` on A)
- **Textual conflicts: 1** — `spec/db/ownership.yaml` (both lines edit migration ranges and tables).
- **Semantic conflicts (no git conflict, would fail at runtime):**
  | Ordinal | Line A | Line B | Effect |
  |---|---|---|---|
  | 1900 | `ai` model_rate_card_versions | `domains` dnet_registrar | `schema_migrations.ordinal` is the PRIMARY KEY (`packages/db/src/runner.ts:24`): the second file cannot apply; the loader also validates uniqueness (`migrations.ts:64`) |
  | 1920 | `ai` benchmark_runs | `platform` docs_feedback | same |
  | 1980 | `deploy` deployment_cancelled | `hosting` hestia_panel | same |
  | ADR-067 | `ADR-067-execution-gateway.md` | `ADR-067-hestiacp-hosting-panel.md` | two accepted-looking ADRs with one number |
- **Behavioural overlap to review by S06/S04 owners:** line B **removes** `apps/api/src/modules/hosting/internal/agent/*`, `admin-agents.controller.ts`, `hosting/agents` admin page and `internal/mock/isolation.spec.ts`, and renames the CloudPanel adapter into `internal/mock/sim/`. Line A's E2E and S06 deployment tests reference the hosting node/agent screens (`admin-hosting-agents`, `admin-hosting-node`). After a join those specs and screenshots must be re-derived, not assumed.
- Also in B and not in A: `spec/openapi` (about 9k lines changed), SDK schema, i18n, lock file, UI css, `pnpm-workspace.yaml`. A regeneration of the SDK and a lock-file regeneration are needed.

## 2. Proposed procedure (when the owner authorizes joining the lines)
1. Choose direction: merge **B into A's integration branch** in a new branch `integration/ai-engine+hosting` (never into `main` or the owner's working branches).
2. Renumber **line A's colliding migrations** (A's are newer and unapplied outside local dev databases): `1900 ai → 2210`, `1920 ai → 2211`, `1921 ai → 2212`, `1980 deploy → 2213` (the end of the S07 reserve, so no Phase 2 session block is used; see §3). Update `spec/db/ownership.yaml` ranges (one entry per range), and record the rename in each file header. Databases that already applied the old ordinals (the Master/worker scratch DBs and the owner's dev DB if it ever ran them) need a documented fix-up: drop and re-create scratch DBs; for a dev DB, rename the `schema_migrations` rows in a one-off script reviewed by the owner (no automatic rewrite of history).
3. Rename `ADR-067-execution-gateway.md` to `ADR-068-execution-gateway.md` and update every reference (`grep -rn "ADR-067"` partitions into hosting vs execution references by context); update `docs/adr/README`/index if present.
4. Resolve `spec/db/ownership.yaml` by hand, one entry per range/table; regenerate SDK (`pnpm sdk:generate`), lock file, `spec:drift`.
5. Re-run everything serialized: lint, typecheck, unit, integration (concurrency 2), isolated E2E ar and en, `scan:secrets`, compliance suite; re-derive hosting node/agent screenshots and tests.
6. S06 reconciles its deployment target port with line B's provider abstraction (Phase 2 deliverable: the port is designed against B read-only).
Rollback: the join happens only on a new branch; abandoning it deletes nothing.

## 3. Phase 2 interim rules
New migrations in Phase 2 use ordinals 2100+ per session (S07 may use 2200–2209 only). A's four colliding migrations become `2210–2213` at join time. Workers do not touch Phase 1 files.
