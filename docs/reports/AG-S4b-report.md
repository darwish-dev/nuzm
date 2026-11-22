# S-AG4b report — approved decisions D7, D8, D10, D11 carried out

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this work `83150c7`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED offline. No live request was made; nothing is VERIFIED for any real provider, so no tool is offered to any real provider. Anthropic's terms are not accepted, no international transfer is approved, the probe was not executed.**
Approvals (owner, in chat, 2026-11-22): **D7, D8, D10, D11** as proposed in `docs/ai-intelligence/S-AG4-DECISIONS.md`. D1, D2, D4, D5, D6, D12 remain pending; D3 and D9 are approved only as mechanisms/plans.

## A. Findings and assumptions
- D7 "as proposed" was taken to mean **variant B** (a boolean `supportsTools`, the recommended and zero-warning form), not three new capability strings.
- **Defect found while testing D8:** the gateway never required the `parallel-tool-calls` capability for a request that asks for more than one call per response (it only required `tool-use`, and `streaming-tool-calls` for streams); the adapter alone refused. With evidence now gating capabilities, that gap would have let a model with verified `tool-use` but no verified parallel calls be asked for two calls. Fixed: such a request is routed only to a model that declares (and, for a real provider, has verified) `parallel-tool-calls`.
- Assumption: recording evidence needs `admin:ai:approve` (platform admin and security), not only `manage`, because it decides what the platform offers.

## B. Changed files
- DB: `packages/db/migrations/ai/1870__ai__model_capability_evidence(.down).sql`; `spec/db/ownership.yaml` (table, platform-scoped list, nine column classes).
- API: `ai/internal/provider.service.ts` (evidence view, `recordCapabilityEvidence`, refused `probeToolUse`, `verifiedCapabilities`), `ai/internal/gateway.service.ts` (evidence-gated capabilities, `supportsTools`, parallel routing), `ai/admin-ai-providers.controller.ts` (two actions), `ai/ai.module.ts` (Claude adapter built as a 1.1 candidate), `ai/internal/model.ts` (`AI_CLAUDE_CONTRACT` removed).
- Spec/SDK: `spec/openapi/openapi.yaml`, `packages/sdk/src/schema.ts`.
- Tests: `ai/capability-evidence.int.spec.ts` (12, new), `ai/internal/ai-config.spec.ts` (D10), `ai/anthropic-adapter.int.spec.ts` (one assertion).
- Docs: `S-AG4-DECISIONS.md` (§5 approvals recorded), SCR-K-11 (accepted, applied, as implemented), `S-AG4-PREP.md`, `docs/adapters/anthropic.md`, the enablement runbook, ADR-066 progress, this report.

## C. Implemented
1. **D7:** `AiModel.supportsTools`; `AiModelProvider.contractVersion`, `liveCallsApproved`, `capabilityEvidence`; `AiCapabilityEvidence`; admin actions `record_capability_evidence` and `probe_tool_use` (with their optional fields). **Backward compatibility vs the previous spec: 0 breaking, 0 warnings** (`scripts/openapi-compat.ts`); Spectral, drift (502/502) and SDK check pass.
2. **D8:** append-only `ai.model_capability_evidence`. A real provider's `tool-use`, `streaming-tool-calls` or `parallel-tool-calls` counts only while the **latest** row for (provider, model, capability) is `VERIFIED` and recorded for the adapter's current contract; a dependent capability also needs verified `tool-use`; `NOT VERIFIED` withdraws; a different adapter build no longer inherits it. Dev-reference `mock-*`/`local-*` providers are exempt. The Claude adapter is now registered as a 1.1 candidate and declares nothing until evidence exists.
3. **Recording rules:** `admin:ai:approve`; audited (`ai.provider.capability_evidence_recorded`); refuses `VERIFIED` for an adapter on contract 1.0, for a capability the adapter does not declare, for a dependent capability without verified `tool-use`, and malformed input; never changes anything else.
4. **`probe_tool_use`:** in the contract, validates its input, audits the refusal (`ai.provider.probe_refused`) and answers 422; it sends nothing. The wrapper that would run the probe through the gateway is **not built** (D9 execution is not approved).
5. **D10:** pinned by tests: `AI_ALLOW_UNATTESTED_SENSITIVE` defaults to false and only the exact string `true` enables it; production and executable tools stay closed.
6. **D11:** sequencing recorded; the neutral contract is unchanged (the evidence table, `supportsTools` and the probe are provider-neutral).

## D. Migrations and rollback
`1870__ai__model_capability_evidence`: expand only, one new platform-scoped table (insert and select only for the application role). Reversal (`DROP TABLE`, dev/staging; production is forward-fix) **verified** on a scratch database: up → down (table gone) → up (table back). It withdraws every recorded declaration, which is the safe direction. Classification coverage (3,368 columns), `db:test-rls` and ROPA coverage pass.

## E. Tests run with actual results
| Command / suite | Result |
|---|---|
| `capability-evidence.int.spec.ts` | **12 passed**: no evidence = no tools (422, provider never called) and `supportsTools: false`; validation; permission (read-only platform role and org user refused, nothing written); VERIFIED turns tools on, provider list shows the evidence, public list `supportsTools: true`, audit event without secrets; parallel needs its own evidence; append-only with latest-wins and the application role unable to update or delete; NOT VERIFIED withdraws (and dependents with it); a different adapter contract no longer inherits; a 1.0 adapter cannot be verified; the probe action refuses, audits, sends nothing; dev-reference providers still serve tools |
| All AI integration specs (`src/modules/ai`: gateway, anthropic-adapter, capability-evidence, runs, injection) | **159 passed** |
| `@nuzm/adapter-model` | 80 passed |
| `apps/api` unit tests of the ai module | 30 passed |
| `apps/web` | 861 passed |
| `pnpm lint`, `pnpm typecheck` | exit 0 |
| `pnpm spec:lint`, `spec:drift`, `sdk:check`, `compliance:claims-guard`, `compliance:classification-coverage`, `db:test-rls` | OK |
| Full `pnpm test:integration` (clean run) | api 2119 passed, 1 failed (pre-existing `domains-search`), 2 skipped; db 102, platform 32, worker 92 |

## F. Security, isolation, metering, cost
Nothing live exists. Evidence is platform data (no `org_id`); customers never see it (only `supportsTools`); recording needs the approve permission and is audited; the table is append-only for the application role; the gateway's metering, budgets and residency paths are unchanged. The parallel-routing fix narrows what can be requested.

## G. Full-suite result
`pnpm test:integration` on an otherwise idle machine: db 102, platform 32, worker 92 passed; **api 2119 passed, 1 failed, 2 skipped**; the one failure is the pre-existing `domains-search` registrar probe matrix (R1 of `test-failure-remediation-plan.md`). An earlier run of the same suite, made while I was also running typechecks and the web tests, showed 21 failures (17 in `agent-tools.int.spec.ts` after a 30 s timeout that expired a session, plus single timeouts in `domains-orders` and `invoices` PDF rendering); all of those files pass when run alone (30, 42 tests) and in the clean full run above, so they were load effects, not regressions. This is the same class of problem as R4 in the remediation plan.

## H. Human gates and live checks still needed
D1, D2, D3 (opening), D4, D5, D6, D9 (execution) and D12 as in `S-AG4-DECISIONS.md`. Pre-existing failures (domains-search, scan:secrets, zatca:guard, admin load timeouts, port 4000) are unchanged and have their own plan (`test-failure-remediation-plan.md`).

## I. Acceptance
| Item | Status |
|---|---|
| D7 applied, backward compatible | PASS |
| D8 evidence table and evidence-gated declarations | PASS (offline); live evidence **NOT VERIFIED** |
| D10 pinned | PASS |
| D11 recorded | PASS |
| Probe executed | NO (BLOCKED: D2, D3, D4, D9) |
| Live calls, tools offered to a real provider, production, executable tools | none, none, closed, closed |
