# DEFECT-7 — parallel calls of one run deadlock in the gateway; a settle that loses the deadlock leaves the customer charged with no usage record

Reporter: Session 07 (QA) · Owner: Session 02 (`apps/api/src/modules/ai/internal/gateway.service.ts`, `budget.service.ts`) · cc Master, Session 05 (the agent loop may issue several model calls of one run at once) · Severity: **HIGH** (money and metering integrity; found by a dynamic test, Phase 2) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-providers f02209cd merged into feature/ai-qa-security) · Found 2026-11-24 on `integration/ai-engine` `39658725`

Evidence class: SIMULATED model (MockModelAdapter), real PostgreSQL 16, real ledger, real hash-chained audit. No provider, no real money.

## Where
- `gateway.service.ts` settle path (`settleOk`, the tail around lines 610-740): `ledger.post(...)` (wallet debit, **its own transaction, already committed**) → then ONE usage transaction: `INSERT ai.model_usage`, `emitUsage(...)`, `UPDATE ai.runs SET spent_credits…`, `UPDATE ai.reservations … 'settled'`, `UPDATE ai.credit_balances SET reserved_credits = …`, `UPDATE ai.runs SET reserved_credits = …`.
- `budget.service.ts` `reserve()` (≈ line 55-190): `lockBalance` (row lock on `ai.credit_balances`) **then** `UPDATE ai.runs SET reserved_credits = …`.

## Mechanism (from the PostgreSQL server log, `deadlock detected`)
Lock order inversion on two rows. The reserve of call 2 takes `ai.credit_balances(org)` and then wants `ai.runs(X)`; the settle of call 1 of the same run already holds `ai.runs(X)` (the `spent_credits` update comes first) and then wants `ai.credit_balances(org)`. PostgreSQL aborts one of them with `40P01` after one second. Logged cycles contain `UPDATE ai.runs SET reserved_credits…`, `UPDATE ai.runs SET spent_credits…` and `UPDATE ai.credit_balances SET reserved_credits = greatest(0, …)` (three- and four-process cycles are common).

## Consequence (reproduced, `apps/api/src/qa/qa-ai-integrity.int.spec.ts`)
When the settle transaction is the victim, the wallet debit **was already committed**:
- the ledger has `ai:call:<org>:<callId>` (e.g. 27 credits) and the wallet is lower, **but there is no `ai.model_usage` row** and no metering events for the call, and `ai.runs.spent_credits` never counts it (so the per-run cap under-counts and later calls can overspend the run cap);
- the caller gets an error (`40P01: deadlock detected`), the reservation is then released;
- in a workload of 60 calls over 6 runs (10 parallel per run), 3 to 9 calls per round were charged without a usage record; wallet gap = n × 27 credits exactly;
- reservations were also seen left `held` after the workload (87 and 261 credits) when the release itself lost a deadlock; only the TTL sweeper frees them.
The same workload with the calls of each run executed one after another (runs in parallel) reconciles exactly (usage = ledger = wallet, per call and in total): the defect needs two calls of the SAME run in flight.

## Expected
A charge and its usage record can never disagree: every committed wallet debit has exactly one usage row with the same credits, however the calls interleave; no deadlock between reserve, settle and release; a failed settle never keeps the debit.

## Suggested fix (the owner decides)
1. One lock order everywhere: take `ai.credit_balances` first, `ai.runs` second, in reserve, settle and release (e.g. in settle, `UPDATE ai.credit_balances` before `UPDATE ai.runs`), or drop the per-run `reserved_credits` counter from the hot path.
2. Retry the usage transaction on `40001`/`40P01` (the ledger post is idempotent on `ai:call:<org>:<callId>`, so re-running settle is safe) and make a settle that cannot complete visible (an `outcome='error'` usage row plus an alert), never silent.
3. Preferably write the usage row first (or in the same transaction as the debit) so the two cannot diverge; add a reconciliation check (`ai:call:*` ledger transactions without an `ok` usage row) to the existing wallet-drift test.
4. Run `release` in the same lock order, and record the `40P01` in the call's error code.

## Tests
`qa-ai-integrity.int.spec.ts`: `it.fails('DEFECT-7 …')` states the secure expectation (zero charges without usage, zero wallet gap; fails today by reproducing the deadlock). Control that passes today and must keep passing: "calls of one run in sequence (runs concurrent) … usage = ledger = wallet, per call and in total". When the fix lands, turn the `it.fails` into an ordinary `it`.

## Re-test result
FIXED and RE-TESTED: reserve/settle/release take the balance lock first and settle/release retry on 40P01/40001 (`feature/ai-providers` f02209cd). `qa-ai-integrity.int.spec.ts` 19 passed in 3 consecutive runs: the DEFECT-7 test (4 rounds of 60 calls, 10 in flight per run, provider failures, key creation and top-ups racing) is an ordinary test, shows zero charges without usage, wallet gap 0, nothing held, no `ai.settle.incomplete` event; the PostgreSQL log shows no deadlock during the fixed runs.
