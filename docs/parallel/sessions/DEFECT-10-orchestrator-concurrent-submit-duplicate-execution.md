# DEFECT-10 — concurrent `submit` calls with one idempotency key create several jobs and run the request several times

Reporter: Session 07 (QA) · Owner: Session 04 (`packages/domain/src/ai/execution-gateway/orchestrator.ts`) · cc Master, Session 05 · Severity: **MEDIUM** (duplicate execution of one request; the bug is in the ORDER of the check, so it carries over to a durable store) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-sandbox c9c7c557 merged into feature/ai-qa-security; domain dist rebuilt) · Found 2026-11-24 on `integration/ai-engine` `39658725`

Evidence class: SIMULATED (MockExecutionPort; nothing executes).

## Where
`orchestrator.ts` `submit()`: the duplicate check `this.keys.get(org + key)` happens, then `await this.d.port.request(...)` (and the earlier `await this.emit(...)`), and only AFTER those awaits does the code call `this.keys.set(...)`. Two submits that overlap both pass the check before either registers the key.

## Reproduction (`apps/api/src/qa/qa-exec-orchestrator.int.spec.ts`)
10 concurrent `submit` with the same `idempotencyKey` and request → several different job ids; draining the queue runs the profile several times (`port.calls.length > 1`). A real worker pool plus a model that repeats a tool call would hit this; with a network profile (install-deps) it would also create several approvals.

## Expected
One key = one job = one execution, however the submits interleave (the `Idempotency-Key` rule of CLAUDE.md section 4).

## Suggested fix
Reserve the key synchronously before any `await` (put a pending marker in `keys` first, or key the check and the insert in one atomic step / unique constraint when the store becomes durable), and return the same job to every duplicate. Add the request fingerprint to the stored key and answer a different request with the same key as a conflict (see OBS-S04-1).

## Tests
`it.fails('DEFECT-10 …')` (secure expectation) + `CONFIRMED TODAY` control (delete with the fix) in `qa-exec-orchestrator.int.spec.ts`; the sequential duplicate control passes.

## Re-test result
FIXED and RE-TESTED: the `it.fails` is an ordinary test and passes (10 concurrent submits = one job, one execution); the CONFIRMED TODAY control was deleted. O-11 (same key, different request or run → `idempotency_key_conflict`, also while the first is in flight), O-12 (`decision_not_issued_by_gateway`: hand-made, altered and cross-org/run decisions are refused; pristine one runs) and O-13 (artifact `kind`: symlink, hard link, device, dir refused) are verified by new ordinary tests: `qa-exec-orchestrator.int.spec.ts` 19 passed. Note: API tests import `@nuzm/domain` from `dist`, so `pnpm --filter @nuzm/domain build` is needed after a domain change.
