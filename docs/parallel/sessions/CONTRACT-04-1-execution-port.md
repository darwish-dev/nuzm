# CONTRACT-04-1: ExecutionPort contract location, version 0.1 plus one additive field

- **Requester:** Session 04 (Sandbox and Execution Gateway)
- **Contract:** `ExecutionPort`, `ExecutionOutcome`, `ArtifactRef` (SHARED-CONTRACTS §2, version 0.1)
- **Current text:** SHARED-CONTRACTS §2 says the Master creates `packages/domain/src/ai/contracts/`; until then workers code against the sketch.
- **Proposed text:**
  1. The implementation already exists, offline, in `packages/domain/src/ai/execution-gateway/port.ts` (`ExecutionPort`, `ExecutionOutcome`, `ExecutionRunContext`, `ArtifactRef`, `PortOrigin`, `MockExecutionPort`) and is reachable as `executionGateway.*` from `@nuzm/domain`. On merge, the Master re-exports these names from `packages/domain/src/ai/contracts/index.ts` (`export { type ExecutionPort, … } from '../execution-gateway/port'`); no type is moved or renamed.
  2. Additive: `ExecutionOutcome.artifacts[]` gains an **optional** `sha256?: string`. A runtime adapter that hashed the file reports it; without it the orchestrator refuses the artifact (`no_content_hash`). Shape otherwise exactly as the 0.1 sketch.
  3. Additive: `ExecutionPort.origin: 'MOCK' | 'REAL'` (read-only property) so a consumer can label results; the mock is always `MOCK`. `run(decision, ctx)`'s `ctx` is `ExecutionRunContext = { orgId; runId; approvalId?; signal? }`.
- **Why:** Session 05 builds `MockBuildPort` on `MockExecutionPort`; a single re-export point avoids a second definition. The `sha256` and `origin` additions let artifact handling and result labelling be honest without a second contract.
- **Additive?** Yes. No existing member changes.
- **Tests added:** `port.spec.ts` (mock behaviour), `orchestrator.spec.ts` (artifact hash handling), `execution-port.spec.ts` (sandbox-runtime port).
- **Sessions affected:** 05 (consumer), 06 (artifact consumer), 01 (re-export).
- **Master answer:** _(pending)_
