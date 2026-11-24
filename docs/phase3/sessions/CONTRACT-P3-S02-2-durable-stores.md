# CONTRACT-P3-S02-2 — durable execution stores: ownership manifest, migration range, classification (request to the Master, from P3-S02)

Status: REQUEST. Migrations `2310`, `2311`, `2312` (schema `execution`, nine tables) are committed in `packages/db/migrations/execution/` with `.down.sql` files and documented reversal. They need these edits to shared files, which P3-S02 does not make:

1. `spec/db/ownership.yaml`: apply `CONTRACT-P3-S02-2-durable-stores.ownership.patch` (generated from the working copy that the integration tests ran against; `git apply` on a clean `integration/phase3` tree, or merge by hand). It adds:
   - schema `execution` (`owner_module: execution`, `created_by: P3-S02`) listing `approvals, attestations, job_transitions, jobs, kill_switch, quota_reservations, runtime_nodes, usage_records, workspaces`;
   - migration range `P3-S02: "2310-2319"` (rename to your convention);
   - `tenant_less`: `execution.runtime_nodes`, `execution.attestations` (platform data, RLS by platform scope);
   - classification of every column (all `internal`; a column-by-column list is in the patch) and one exception: `execution.jobs.lease_token` (an opaque worker lease id, not an authentication token).
2. Verify: `pnpm db:migrate` on a clean database, `pnpm db:test-rls`, `pnpm compliance:classification-coverage`, `pnpm compliance:ropa-coverage` (the tables hold no personal data except two user ids, `execution.approvals.decided_by` and `execution.kill_switch.by_user_id`, which are `internal` like `ai.*.created_by`; if the ROPA check wants an entry, it is the existing "execution audit" processing activity, otherwise one new line), `pnpm compliance:residency-hooks` (every tenant table has `data_region`).
3. Not requested now: wiring. `PgExecutionStore` (`apps/api/src/modules/execution/internal/store.ts`) is not registered in `app.module.ts` and nothing constructs it; the in-memory gateway components stay the default and the flag `ai.agent.exec_tools` stays off. When the Master wires it, the queue/approval/kill-switch ports take this store behind the existing interfaces.

Integration result (SIMULATED data, real PostgreSQL 16, runtime role, RLS enforced): see `REPORT-P3-S02.md` §E. Rollback: `docs/security/sandbox/DURABLE-STORES-DESIGN.md` (forward-only in production).
