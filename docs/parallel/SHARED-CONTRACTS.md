# Shared contracts (existing names are reused; nothing here is a new abstraction unless marked NEW)

Only the Master approves a change. Workers request changes with a file `docs/parallel/sessions/CONTRACT-<n>-<title>.md` containing: requester, contract, change, reason, compatibility (additive only unless stated), tests. Breaking changes are refused unless the Master schedules a migration across sessions.

## 1. Existing contracts to reuse (verify the exact current definition in code before using)
| Requested name | Existing definition (today) | Owner of change |
|---|---|---|
| AIProvider | `ModelAdapter` (`packages/adapters/model/src/types.ts`, `mock.ts`, contract 1.1) + provider row `ProviderDto` (`apps/api/src/modules/ai/internal/provider.service.ts`) | 02 |
| AIModel / ModelCapabilities | `ModelInfo` + `ModelCapability` (adapter-model `types.ts`); public list item with `supportsTools`; evidence rows `ai.model_capability_evidence` | 02 |
| AgentRun / AgentTask | `ai.runs`, `RunContext`, `RunKindHandler` (`apps/api/src/modules/ai/internal/run-kinds.ts`); `AgentCheckpoint` (`appbuilder/internal/studio/agent-loop.ts`); generation plans | 05 (loop), 02 (runs) |
| ToolDefinition / ToolInvocation / ToolResult | `ToolDecl`, `RequestedCall`, `RejectedCall` (`packages/domain/src/ai/tools.ts`); `READ_TOOL_SPECS` and results (`agent-tools/`) | 05 |
| ExecutionRequest / ExecutionResult | `ExecRequest`, `ExecDecision`, profiles (`packages/domain/src/ai/execution-gateway/index.ts`); runtime `ExecResult` (`appbuilder/internal/sandbox/runtime.ts`) | 04 |
| Workspace | `ReadOnlyWorkspace` (domain `agent-tools/workspace.ts`); sandbox workspace handle (`SandboxRuntime`) | 05 (read), 04 (runtime) |
| Project / FileOperation | builder project and version model, `PatchOp` (`benchmarks/types.ts`) mirrors the patch shape | 05 |
| BuildRequest / BuildResult | mobile builds (`apps/web/lib/mobile.ts`, `mobile` module); web-app build runs | 05 / 06 — **NEW unified contract needed (see §2)** |
| DeploymentRequest / DeploymentResult | `deploy` module DTOs and the site publisher port (`apps/api/src/modules/deploy`) | 06 |
| BenchmarkTask / BenchmarkResult | `GoldenTask`, `TaskScore`, `RunOutcome`, `BenchmarkReport` (`packages/domain/src/ai/benchmarks`) | 03 |
| UsageRecord | `ai.model_usage` rows + metering events (`docs/12`, central pipeline) | 02 |
| BudgetPolicy | `ai.budgets` and `BudgetService` | 02 |
| ApprovalPolicy | `ai.approvals` / `ApprovalKind` (`run.service.ts`), `requiresApproval` in `decideExec` | 05 (builder kinds), 04 (execution kind) |
| AuditEvent | `AuditSink` / `AuditEvent` (`apps/api/src/common/audit.ts`), action naming `ai.*` | all emit; Master owns the type |

## 2. NEW contracts the Master defines before dependent work starts (initial proposal, versioned `0.1`)
These are TypeScript interfaces in `packages/domain/src/ai/contracts/` (Master creates them in the first integration batch; until then each worker codes against the sketch below in its own module and adapts on merge).
- `ExecutionPort`: `request(ExecRequest): Promise<ExecDecision>` · `run(decision, ctx): Promise<ExecutionOutcome>` where `ExecutionOutcome = { status: 'completed'|'failed'|'timeout'|'terminated'|'refused'; exitCode: number|null; stdout: string; stderr: string; truncated: boolean; durationMs: number; artifacts: {path:string; bytes:number}[] }`. Implementations: `MockExecutionPort` (Session 04; scripted outcomes, **never executes anything**), the real runtime port (SECURITY-BLOCKED).
- `BuildPort`: `build(BuildRequest): Promise<BuildResult>`, `BuildRequest = { projectId; versionId; profile: 'typecheck'|'unit-tests'|'build'; orgId; runId }`, `BuildResult = { status; logs: string; artifacts: ArtifactRef[]; durationMs }`; Session 05 consumes `MockBuildPort` (built on `MockExecutionPort`), Session 06 provides the deployment-side artifact handling.
- `ArtifactRef = { id; path; bytes; sha256; createdAt }`.
- `DeploymentPort` = the existing site publisher port; Session 06 documents it; Session 05 uses it only through the existing builder deploy screens.
All ports are additive, feature-flagged, default off, and carry `orgId` and `runId` from verified auth context only.

## 3. Contract-change request template
`docs/parallel/sessions/CONTRACT-<n>-<title>.md`: Requester · Contract · Current text (file:line) · Proposed text · Why · Additive? · Tests added · Sessions affected. The Master answers in the same file (ACCEPTED / REVISED / REFUSED) within the next integration batch.
