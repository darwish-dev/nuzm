# DEFECT-8 — a call id sent several times at once reaches the provider several times (the customer is charged once, the platform pays the provider N times)

Reporter: Session 07 (QA) · Owner: Session 02 (`apps/api/src/modules/ai/internal/gateway.service.ts`, `budget.service.ts` `reserve`) · cc Master · Severity: **LOW-MEDIUM** (platform cost, not customer money; needs a duplicated in-flight call id, e.g. a step resumed twice by two workers) · Status: OPEN · Found 2026-11-24 on `integration/ai-engine` `39658725`

Evidence class: SIMULATED provider (a counting `MockModelAdapter`).

## Where
`budget.service.ts` `reserve()`: when a `held` reservation already exists for the call id it is **reused** ("a retried call id: reuse the open reservation, never double hold"), so every concurrent duplicate proceeds to `adapter.complete`. Only the settle step is idempotent (`ai:call:<org>:<callId>` ledger key, `ON CONFLICT (org_id, call_id) DO NOTHING`).

## Reproduction (`apps/api/src/qa/qa-ai-integrity.int.spec.ts`)
12 simultaneous `gateway.invoke` with ONE `callId`: customer side is correct (1 usage row, 1 ledger transaction, 1 wallet debit, no held reservation). The adapter was invoked **9, 10 and 11 times** in three runs (expected 1). Provider spend (`cost_minor`) is recorded only once, so the cost ledger also under-reports the provider's invoice by the same factor.

## Expected
One call id = one provider invocation. A second caller that finds the call in flight waits for or is refused with a clear "in progress" conflict; only a call whose reservation has expired (crashed worker, swept) may be re-dispatched.

## Suggested fix
Mark the reservation with a claim (`claimed_at`/`attempt`) set by the call that creates it; a duplicate that finds a held, unexpired claim answers `409 call_in_progress` instead of dispatching. Keep the existing behaviour for an expired claim (crash recovery).

## Tests
`it.fails('DEFECT-8 …')` in `qa-ai-integrity.int.spec.ts`; the customer-side twin passes today. Flip to an ordinary `it` with the fix.
