# DEFECT-15 — the organization's concurrent-run ceiling can be exceeded by a burst of creates

Reporter: Session 07 (QA) · Owner: Session 02 (`apps/api/src/modules/ai/internal/run.service.ts` `create`, baseline M09 code) · Severity: **LOW** (cost-control limit overshoot by the size of a burst; every run still needs its own reservation, budgets and wallet) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-providers abd34766 merged into feature/ai-qa-security) · Found 2026-11-24 during the final re-verification on the merged head (the strict test had passed in isolation several times: the race window is narrow and widened under machine load of 200+)

Where: `create()`: inside one `withOrg` transaction `SELECT count(*) FROM ai.runs WHERE state = ANY(ACTIVE)` is compared with `maxConcurrentRuns`, then `INSERT INTO ai.runs`. Under READ COMMITTED two or more concurrent creates all see `active < max` before any of them inserts, so the ceiling is overshot. (Same shape as DEFECT-11 and the orchestrator's DEFECT-10: a check and its write are separated.)
Reproduction (`qa-run-concurrency.int.spec.ts`): ceiling set to 3, 30 sessions start runs at once, up to 6 rounds, then count active runs: more than 3 were seen in each of two runs.
Expected: never more active runs than the ceiling; the overflow gets 429.
Suggested fix: serialise the check and the insert per organization (`pg_advisory_xact_lock(hashtext(org_id))` or `SELECT … FOR UPDATE` on the organization's `ai.credit_balances` row, which reserve/settle already take first since DEFECT-7), or enforce the ceiling with a counter row updated in the same statement.
Tests: `it.fails('DEFECT-15 …')`; the sequential control (429 at the ceiling, nothing created) passes.

## Re-test result
FIXED and RE-TESTED: `create()` takes `pg_advisory_xact_lock(hashtext('ai.runs.create:'||orgId))` before the count. Before flipping, the unflipped `it.fails` failed with "Expect test to fail"; the ordinary test (30 simultaneous starts, ceiling 3, up to 6 rounds) passes: `qa-run-concurrency.int.spec.ts` 11 passed in 3 consecutive runs. `qa-ai-integrity` 19 passed in 3 runs on the same tree (note: a duplicate in-flight call id can now also be refused with the platform guard code `idempotency_in_progress`, still a 409 with no second dispatch and no charge; the test accepts either code).
