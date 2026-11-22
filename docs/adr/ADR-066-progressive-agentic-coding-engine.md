# ADR-066: Progressive, provider-neutral Agentic Coding Engine (D-46)

- Status: **Decided by the owner on 2026-11-22 as the TARGET architecture; implementation is staged and NOTHING of the agentic engine exists yet.** The agent recorded the decision; the owner made it. Not production-ready and never to be described as such until each stage is implemented AND verified (acceptance criteria in SCR-K-10).
- Related decisions: D-46 (this), D-21 (sandbox isolation, OPEN, blocks every execution tool), D-38 (hosted Claude Code, separate), D-42 (production restrictions, unchanged), D-18/HG-09-01 (residency and data terms), D-49 (AI-processing permission), ADR-061 (model gateway and credit settlement), ADR-065 (AI Intelligence Center), ADR-015 (sandbox isolation model)
- Spec change: `docs/spec-change-requests/SCR-K-10-agentic-coding-engine.md`; contract text in `docs/09` §7 (planned extension)
- Supersedes nothing. S-K6's single-call adaptation (ADR-065 addendum H) is preserved as the fallback.

## Context
S-K6 adapts a copied template with ONE structured model call and no tools. The audit (`docs/ai-intelligence/AUDIT_AND_PLAN.md`, C6) found that the `ModelAdapter` contract has no tool use, that live provider use needs HG-09-01 / D-18, that running anything needs D-21, and that hosted Claude Code is a separate legal question (D-38). The owner decided to pursue a coding agent, but progressively and without bypassing any of those blockers.

## Decision
Adopt a **staged, provider-neutral Agentic Coding Engine** as the target architecture of the AI Intelligence Center.
1. **Fallback preserved.** The S-K6 single-call adaptation stays, backward compatible and selectable; it is also the automatic fallback whenever the agentic engine is disabled, a provider lacks a verified capability, or a run cannot continue.
2. **Provider-neutral `ModelAdapter` v1.1** (additive to 1.0): structured responses, tool calling (declared tools in, tool-call requests out, tool results back), streaming including tool-call deltas, cancellation, and usage tracking. Capabilities (`tool-use`, `streaming-tool-calls`, `parallel-tool-calls`) are declared per model and come from official documentation and a probe; **unknown means unsupported**.
3. **Read-only tools first:** `read_file`, `list_files`, `search_code`, `inspect_project`.
4. **A controlled coding-agent loop:** planning, exploration with read tools, file edits as patch proposals, diffs, validation, error recovery, checkpoints, cancellation and ceilings. Edits are proposals that go through the existing safe-change pipeline (paths, secrets, canaries, sizes, dependency policy, mode rules) and land on the AI branch only. Tests and builds join the loop only when D-21 allows (point 8).
5. **Multiple providers through adapters,** including Anthropic, OpenAI and Google, **each enabled only for the capabilities verified for it**; provider selection and credentials remain owner/HG items.
6. **One allow-listed, metered execution gateway** for every tool call: tenant isolation, audit logging (redacted), per-call and per-run limits, explicit permissions, kill switch.
7. **Model tool calling is separate from operating-system command execution.** A tool call is a JSON request that a deterministic executor validates against a registered schema; the read-only executor works on a virtual view of the project's files in memory and has no process, filesystem or network access. Anything that runs a program belongs to a different component (the Execution Gateway, stage S-AG6) with its own authorisation, sandbox and approvals; the model can never supply a command line.
8. **No build, test, shell or executable tool is enabled until the D-21 security and execution requirements are satisfied** (an `isolated` runtime that passes the escape suite, then its own ADR). The flag for execution tools is reserved and cannot be turned on before that.
9. **D-42 production restrictions are unchanged.** Every new capability ships behind a feature flag, default off.
10. **Claude Code is a separate, optional integration** (AI Studio S-A8) subject to D-38 and to supported authentication and licensing. It does not share the adapter, the gateway or the loop; the engine never uses the Claude Code binary or a customer's subscription.
11. **Incremental delivery** with real-provider verification and quality benchmarks before any production rollout. A provider or the engine is `LIVE-VERIFIED` (with evidence) or `NOT VERIFIED`; mocks prove plumbing and safety, never quality.
12. **Nothing existing is broken:** existing APIs, database contracts, feature flags and security controls are preserved; new fields and flags are additive; the generic run, approval, budget and audit machinery is reused.

## Architecture (layers, all behind existing controls)
```
customer request ──▶ plan (S-K7/S-K6) ──▶ run engine (metered, budget, kill switch, residency, secret scan)
                                              │
                         ┌────────────────────┴─────────────────────┐
                         ▼ single-call adaptation (S-K6, fallback)    ▼ agent loop (S-AG3, flag)
                                                    PLAN → EXPLORE ⇄ read tools → PROPOSE → VALIDATE(static) → APPLY(AI branch)
                                                              │ tool-call requests
                                                              ▼
                                         Tool Execution Gateway (allow-list · schema · permission · limits · metering · audit · tenant isolation)
                                                              │
                                  read-only executors (in-memory virtual project view)        ✗ no OS access
                                                              ┊
                           (S-AG6, blocked by D-21) Execution Gateway ─▶ isolated sandbox runtime ─▶ build/test results
model access only through ModelAdapter v1.1 (Anthropic · OpenAI · Google · mock) via the metered gateway (ADR-061)
```

## Alternatives considered
- **Build the full tool set (including run) at once:** rejected; D-21 is open and no provider is verified.
- **Embed Claude Code as the engine:** rejected as the engine; D-38 and licensing make it a separate optional integration.
- **Single-provider tool format (Anthropic only):** rejected; the contract is provider-neutral so adapters carry the differences.
- **Let the model write to the workspace directly:** rejected; every edit stays a proposal through the safe-change pipeline.
- **Stay single-call forever:** possible, but the owner chose to pursue the agent; this ADR keeps that option open by preserving the fallback and gating rollout on benchmarks.

## Consequences
- Positive: a path to a capable coding agent without weakening isolation; the single call stays as a safe floor; every stage is independently verifiable and reversible by flag.
- Negative: more moving parts (contract version negotiation, a tool gateway, a loop); real-provider verification and benchmarks cost time and money and need owner-supplied sandbox credentials; the value of the agent over the single call is unproven until S-AG5.
- **Remains BLOCKED / NOT VERIFIED:** execution tools (D-21), live provider behaviour and data terms (HG-09-01, credentials), production (D-42), agent quality (benchmarks), Claude Code commercial use (D-38).

## Implementation milestones
S-AG0 (done: S-K6) · S-AG1 contract v1.1 and conformance · S-AG2 read-only tool gateway · S-AG3 agent loop on the mock · S-AG4 real provider adapters and verification · S-AG5 benchmarks and rollout gates · S-AG6 execution tools (BLOCKED on D-21). Detail, acceptance criteria and gates: SCR-K-10.

## Progress
- 2026-11-22: **S-AG1 done** (contract 1.1, negotiation, helpers, mock, gateway support, conformance kit; report `docs/reports/AG-S1-report.md`). Everything else in this ADR is still NOT implemented.
- 2026-11-22: **S-AG2 done** (read-only tool gateway: four tools, limits, audit, isolation, template AI-processing gate, flag `ai.agent.read_tools` default off; report `docs/reports/AG-S2-report.md`). The loop, real providers and execution tools are still NOT implemented.
- 2026-11-22: **S-AG3 done** (read-only agent loop on the mock provider: plan, explore, propose, validate, apply; ceilings, checkpoints, cancellation, fallback to S-K6, persisted steps, customer timeline, flag `knowledge.agentic_generation` default off; the S-AG2 per-run quota race fixed with a per-run advisory lock; report `docs/reports/AG-S3-report.md`). Real providers, execution tools and benchmarks are still NOT implemented.
