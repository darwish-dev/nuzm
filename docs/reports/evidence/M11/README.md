# M11 evidence index

All results were produced in the implementing session's worktree (`.claude/worktrees/m11-automation-2a587e`), Postgres 16 on :54353, Node 22. Nothing here is live-verified; effect ports are fakes.

| Evidence | Command | Result (this session) |
|---|---|---|
| Pure core (expression, DAG, SSRF 60 payloads, signing, retry, limits, cron) | `pnpm --filter @nuzm/domain test` | 217 passed (46 new) |
| API unit | `cd apps/api && npx vitest run` | 721 passed |
| AC-M11-01 / -02 / -03 (runtime) / FR-AUT | `npx vitest run --config vitest.integration.config.mts src/modules/automation` | see report §E |
| AC-M11-04 / -05 / -07 / -08 / FR-MKT | `… src/modules/marketplace` | see report §E |
| AC-M11-06 (matrix part) / -09 / -10 posture / FR-PRG | `… src/modules/programs` | see report §E |
| Worker outbox consumer | `cd apps/worker && npx vitest run --config vitest.integration.config.mts` | 12 passed in the full worker run (4 new) |
| Migrations apply from empty + rollback; RLS; ownership | `pnpm db:migrate`, `pnpm db:test-rls`, `packages/db` int | OK, 43 passed |
| Spec | `pnpm spec:lint && pnpm spec:drift && pnpm sdk:check` | clean, 319 routes, up to date |
| Compliance | `pnpm compliance:classification-coverage`, `:residency-hooks`, `:ropa-coverage`, `:claims-guard` | OK (2200 columns / 178 tables) |
| Secrets | `pnpm scan:secrets` | 0 hits |
| UI | see [ui-notes.md](ui-notes.md) | typecheck/lint/unit only; Playwright, axe, screenshots NOT RUN |

Reproducing the fault matrix: `automation-faults.int.spec.ts` uses seed `1000 + n` per run; the failing seed and crash plan are in the assertion message.
