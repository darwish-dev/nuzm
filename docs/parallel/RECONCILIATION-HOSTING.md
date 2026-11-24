# Reconciliation plan: AI-engine line and the HestiaCP hosting line (prepared, NOT executed)

Date: 2026-11-24 · Author: Master · Status: dry run done in a throwaway worktree (scratch directory, since removed); neither branch was changed. Nothing is merged; nothing is pushed (D-01); no owner decision to join the lines exists yet.

Lines: **A** = `integration/ai-engine` (this effort). **B** = `claude/merge-branches-run-import-295c4d` @ `3460525c` (HestiaCP replaces CloudPanel, Dynadot, desktop/mobile/landing work, knowledge/agent merges; sibling branches `friendly-mirzakhani-43fa75`, `modest-nash-bee4e2`, `quizzical-gagarin-0ba54f` point at the same commit).

## 0. UPDATE 2026-11-24 (later): the hosting line is now in local `main`
The hosting master session reports that `main` is at `f8d88fd5` and contains the HestiaCP/Dynadot line plus its three sprint branches (S04 VPS with auto-installed Hestia, S05 site tools and business email, S06 backups/WordPress/monitoring): about 40 commits and 200+ files since `ec1df9cd`; nothing pushed. Consequences, re-measured by a new dry run (`git merge --no-commit --no-ff main` on `integration/ai-engine` @ `4feb1d84` in a throwaway worktree, aborted and removed; neither branch changed):
- **Textual conflicts: 2** — `spec/db/ownership.yaml` and `docs/07-open-decisions-and-blockers.md` (their D-51..D-55 rows vs the `D-AG-ROLLOUT` row).
- **Duplicate migration ordinals in the joined tree: 3** — 1900 (`ai/model_rate_card_versions` vs `domains/dnet_registrar`), 1920 (`ai/benchmark_runs` vs `platform/docs_feedback`), 1980 (`deploy/deployment_cancelled` vs `hosting/hestia_panel`). Main also uses 1940, 1960, 1981-1983, 1985, 1990 (no clash with ours).
- **ADR numbers:** 067 = HestiaCP, **068 = hestia-backups-wordpress-monitoring (taken)**. Our Execution Gateway ADR therefore becomes **ADR-069** (not 068 as written below); hosting will stay out of ADR >= 069 and migration ordinals 2100-2219. Decisions D-51..D-55 are taken on main; ours use `D-AG-*` ids.
- **Hosting public surface:** unchanged (`HostingAdapter`, site-ops contract); the CloudPanel adapter is a test double at `hosting/internal/mock/sim/`; the real adapter is `HestiaHostingAdapter`; agent enrolment and agent routes are gone (our S06 must not depend on them; S06 was told).
- The hosting session verified (mock panels only, nothing on a real node): hosting integration 165 passed; unit, typecheck and spec checks pass; cloud integration was still running.
- Proposed join order (from the hosting session, accepted by the Master as the plan, **not executed**): hosting is already in main, so the AI-engine line is brought onto main by a **new branch** `integration/ai-engine-on-main` (merge `main` into a copy of `integration/ai-engine`, renumber 1900/1920/1921/1980 to `2210-2213`, rename the ADR to ADR-069 and update references, resolve the two textual conflicts, regenerate SDK and lock, full regression). This needs the owner's go-ahead for anything beyond a local branch; `main` itself is never changed by this plan.

## 1. Dry-run result (the first one, before the hosting line entered main) (`git merge --no-commit --no-ff B` on A)
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
3. Rename `ADR-067-execution-gateway.md` to `ADR-069-execution-gateway.md` and update every reference (`grep -rn "ADR-067"` partitions into hosting vs execution references by context); update `docs/adr/README`/index if present.
4. Resolve `spec/db/ownership.yaml` by hand, one entry per range/table; regenerate SDK (`pnpm sdk:generate`), lock file, `spec:drift`.
5. Re-run everything serialized: lint, typecheck, unit, integration (concurrency 2), isolated E2E ar and en, `scan:secrets`, compliance suite; re-derive hosting node/agent screenshots and tests.
6. S06 reconciles its deployment target port with line B's provider abstraction (Phase 2 deliverable: the port is designed against B read-only).
Rollback: the join happens only on a new branch; abandoning it deletes nothing.

## 3. Phase 2 interim rules
New migrations in Phase 2 use ordinals 2100+ per session (S07 may use 2200–2209 only). A's four colliding migrations become `2210–2213` at join time. Workers do not touch Phase 1 files.
