# Agentic Coding Engine — slice S-AG1 report (ModelAdapter contract 1.1 and conformance kit)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this slice `6602d74`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope. No real provider call, no tool, no agent loop, no execution exists; production stays BLOCKED on D-42; execution tools on D-21.**
Governing documents: ADR-066, SCR-K-10 (§2, §4, §8, §10), `docs/09` §7, AC-AG-01..12 (this slice targets AC-AG-02 and AC-AG-03 and must not break AC-AG-01).

## A. Repository findings and assumptions
- The contract lives in `packages/adapters/model` (types, scripted mock, conformance kit, an Anthropic adapter at contract 1.0 written from official documentation, used only with a human-attested provider row). The gateway (`apps/api/.../gateway.service.ts`) is the only caller; it already did residency, data terms, budget reservation, secret scan, retry and fallback.
- Adapters do not depend on `@nuzm/domain` (layering), so the pure helpers that adapters need sit in the adapter package and the schema validation of tool-call ARGUMENTS sits in the domain package, used by the gateway.
- `finishReason` is not stored anywhere (no migration needed); `ai.model_usage` already records tokens, so tool-call tokens flow through the existing metering.
- **Decision for your attention:** `GET /v1/ai/models` is a public contract with an enum of five capabilities. I kept it exactly as is (the 1.1 capabilities are filtered out of that response) instead of changing OpenAPI without your approval (SCR-K-10 §7). The gateway itself routes on all capabilities. If you want the new capabilities visible to clients, approve the exact schema delta.
- **Decision for your attention:** streaming semantics at the gateway: a stream that fails after a chunk was delivered is not retried and not repeated on another candidate (a caller never receives a delta twice); a failure before the first chunk is retried as before.
- The Anthropic adapter was deliberately NOT upgraded: its tool-use capability must be read from official documentation and probed first, which is S-AG4 (needs your provider and credential decisions). It stays on contract 1.0 and the kit reports its 1.1 cases as skipped.
- Environment: Postgres :54339; no browser E2E (no UI changed; the plan's E2E rows belong to S-AG3).

## B. Plan and changed files
- `packages/adapters/model/src/`: `types.ts` (contract 1.1 types, negotiation, token estimate counting blocks), `tools.ts` (new: spec and request checks, argument parsing, call checks, `StreamAssembler`/`assembleStream`, `normalizeModelError`), `mock.ts` (implements 1.1: scripted tool calls, streamed tool-call deltas, cancellation, opt-in tool models, scenario driver), `conformance.ts` (+ contract 1.1 cases, options, `KIT_TOOLS`), `index.ts`, specs (`tools.spec.ts` new, `mock.spec.ts`, `anthropic.spec.ts`), `README.md`.
- `packages/domain/src/ai/`: `tools.ts` + spec (validation of tool calls against declared schemas), `routing.ts` (+ capabilities, + `alsoRequires`), `index.ts`.
- `apps/api/src/modules/ai/`: `internal/model.ts` (call and result types), `internal/gateway.service.ts` (negotiation, tool and streaming support, extended secret scan, public model list unchanged), `gateway.int.spec.ts` (+15 tests).
- Docs: this report, SCR-K-10 §10, ADR-066 progress, `docs/09` §7, plan table.
- Not touched: OpenAPI, database, web/admin consoles, the S-K6 adaptation code, any feature flag.

## C. Implemented
1. **Contract 1.1 types** (additive): capabilities `tool-use`, `streaming-tool-calls`, `parallel-tool-calls`; neutral content blocks; `tools`, `toolChoice`, `maxToolCalls`; `toolCalls` and `finishReason: 'tool_calls'`; stream chunks `toolCallDelta`/`toolCallDone`; error codes `invalid_response` and `unsupported_capability`.
2. **Negotiation:** `contractAtLeast`, `effectiveCapabilities`; a 1.0 adapter is never offered for tools whatever its models declare.
3. **Validation and normalisation:** `assertToolRequest` (tool fields need contract 1.1 and `tool-use`; specs well formed; choice names a declared tool; parallel needs the capability), `parseToolArgs` (JSON object, bounded), `assertToolCalls`, `normalizeModelError` (abort, 429, 408/timeouts, 4xx, 5xx and network, content filters; never carries the provider's message).
4. **Streaming:** `StreamAssembler` validates a stream chunk by chunk (contiguous indexes, id and name first, no data after done, finished calls, parseable arguments, declared tools, call limits, finishReason consistency) and returns the same shape as `complete`.
5. **Cancellation and usage:** the mock and the gateway honour `AbortSignal` mid-stream (reservation released, nothing charged); usage counts tool specs as input and tool calls as output, including the flagged estimate.
6. **Gateway support (backward compatible):** tools, tool choice, parallel limit, streaming with `onChunk`, message blocks; tool specs checked before reservation; outbound secret scan over tool results, tool-call arguments and tool specs; returned `toolCalls` are only those whose tool is declared and whose arguments satisfy its schema, the rest come back as `rejectedToolCalls` with reasons; nothing is executed.
7. **Conformance kit:** the 1.0 cases unchanged, plus 1.1 cases (version and capability consistency, unsupported-capability refusal, malformed specs, choice, parallel, a single call, stream equals complete, parallel limits, no call needed, `toolChoice: none`, malformed arguments in complete and in a stream, undeclared tool, tool-result round trip, cancellation mid-stream, usage and truncation, error normalisation). Behaviour cases need a scenario driver and are reported as skipped without one.
8. **Mock** at contract 1.1 with opt-in tool models; default models and answers unchanged.

## D. Migrations and rollback
None (no database or OpenAPI change). Rollback: the gateway features are used only by callers that pass `tools`/`stream`, and there are none yet; reverting the commit restores 1.0 exactly.

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| `@nuzm/adapter-model` unit | **47 passed** (was 20): helpers and negotiation, tool specs and requests, arguments and calls, stream assembly (valid, interleaved parallel calls, every malformed shape), error normalisation, the mock at 1.1, the Anthropic adapter unchanged at 1.0 |
| Conformance kit on the mock with a scenario driver | **28 cases, all passed, none skipped** (1.0 cases unchanged plus 1.1 cases); without a driver the behaviour cases are reported **skipped**, never passed; on the Anthropic adapter the 1.1 cases are reported skipped (contract 1.0) and every other case passes |
| Domain unit | **827 passed** (6 new: `validateToolCalls`, routing with `alsoRequires`) |
| API unit 1070 · web 844 · admin 348 · i18n 9 · ui 24 · db 55 · worker 60 · adapters | all passed (unchanged) |
| API integration, AI + knowledge + app builder + builder modules: 15 files | **358 passed** (incl. 15 new gateway tests; the S-K6 single-call adaptation tests and every existing AI test unchanged: AC-AG-01) |
| New gateway tests | an ordinary request is answered exactly as before; a tool request is routed to a tool-capable model, validated and metered; malformed tool specs refused before anything is reserved or sent; arguments that fail their schema come back as rejected calls with reasons; an undeclared tool or malformed arguments from a provider fail the call with no charge; no tool-capable model: 422 and the adapter is never called; a 1.0 adapter is never offered for tools; the secret scan covers tool results, tool-call arguments and tool specs; blocks round trip intact and count as prompt tokens; a flagged estimate counts tool calls; streaming delivers deltas, equals the non-stream result and is charged once; a stream that fails after it started is not retried or repeated and charges nothing; cancelling mid-stream releases the reservation; kill switch and residency apply to tool calls; the public model list keeps the five 1.0 capabilities |
| `pnpm lint` (eslint + prettier) | PASS after fixing a README format issue and a literal test key (the fake credential is now assembled at run time) |
| `pnpm typecheck` (52/52), `pnpm build` (28/28) | PASS |
| `spec:lint`, `spec:drift` (501 routes), `sdk:check`, `compliance:claims-guard` | PASS (no OpenAPI or database change) |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched) |
Not run: `pnpm verify:full` and the browser E2E (no UI or API route changed); the full API integration suite (the AI, knowledge, app-builder and builder modules were run); any call to a real provider (none is enabled: NOT VERIFIED).

## F. Security, tenant isolation, billing, residency
- Tool calling is data: nothing is executed anywhere in this slice. The gateway returns validated requests; there is no tool registry or executor yet.
- The outbound scan now covers every channel a secret could take to a provider in a tool loop (results, arguments, specs). Residency, data terms, kill switch, budget reservation and fallback rules apply to tool calls unchanged (tested, including that an EU provider is never called).
- A provider's raw error message is never carried (it may echo a prompt or a key). A malformed or undeclared tool call from a provider fails the candidate and is never returned or charged.
- Billing and metering: unchanged recipes; tool tokens are part of input/output tokens; a failed or cancelled stream charges nothing. Tenant isolation: no new tables; the gateway paths are the existing tenant-scoped ones.
- Known gaps: output-side secret scanning of tool-call arguments is the caller's job today (the loop, S-AG3, and the tool gateway, S-AG2, own it); the token estimate for tool specs is characters / 4 (a flagged approximation, not a billing figure); no live provider has been exercised.

## G. Human gates and live checks still needed
- **Real providers (S-AG4):** official documentation of each provider's tool calling, data-terms attestation (HG-09-01), residency decision (D-18), provider selection and sandbox/test credentials supplied by you. Until then every provider capability is `NOT VERIFIED` and the Anthropic adapter stays on 1.0.
- **OpenAPI delta** for the 1.1 capabilities in the public model list, if you want clients to see them.
- D-21 (execution tools), D-42 (production) unchanged.

## H. Acceptance checklist
| Criterion | Status |
|---|---|
| AC-AG-01 flags off: system unchanged; S-K6 single-call tests pass unchanged | PASS (S-K6 knowledge and app-builder integration suites re-run) |
| AC-AG-02 contract 1.1 additive; 1.0 adapters and callers pass unchanged; negotiation tested | PASS (Anthropic adapter and the whole existing AI suite unchanged; negotiation tests) |
| AC-AG-03 kit covers tool calling, malformed arguments, parallel calls, streaming assembly, cancellation and usage; undeclared capabilities refused by the gateway | PASS for the mock and for contract shape; **a LIVE provider is NOT VERIFIED** (S-AG4) |
| AC-AG-04..08 tool gateway, isolation, loop | NOT STARTED (S-AG2, S-AG3) |
| AC-AG-09 provider verification | NOT STARTED, BLOCKED (S-AG4) |
| AC-AG-10 benchmarks, AC-AG-11 UI | NOT STARTED |
| AC-AG-12 execution tools | NOT STARTED, BLOCKED (D-21) |

## I. Handoff: dependencies for S-AG2 and S-AG3
**S-AG2 (read-only tool registry and execution gateway), can start now with the mock:**
- Uses: `ToolSpec`, `ToolCall`, `ContentBlock` and `validateToolCalls` from this slice; `GatewayResult.toolCalls/rejectedToolCalls` as input.
- Needs from you: approval of the exact `docs/05`/OpenAPI delta only if it adds tables or endpoints (the plan expects the existing `ai.tool_calls`, `ai.run_steps` to suffice; a read-only view of a run's tool calls for the customer UI is an additive endpoint).
- To build: the registry and allow-list per run kind and mode (extending `checkToolCall`), the four read-only tools over a virtual in-memory snapshot of the project, per-call and per-run limits, redacted audit rows in `ai.tool_calls`, metering counts, the template AI-processing gate on `read_file` and `search_code` (reuse the S-K6 context assembly rules), output secret scan, tenant and project isolation tests, the static test that the executors cannot import process, filesystem or network modules (AC-AG-05..07), and the flags `ai.agent.read_tools` (default off) and the reserved `ai.agent.exec_tools`.
**S-AG3 (agent loop), after S-AG2 (and S-AG1, done):**
- Uses: the gateway's tool and streaming support, `rejectedToolCalls` for tool-error feedback, message blocks for results, the S-K6 `ADAPT_SCHEMA`, `checkProposal` and `ChangeService` apply path, the run engine's checkpoints and cancellation.
- To build: the plan, explore, propose, validate, apply state machine with ceilings (turns, tool calls, tokens, minutes), recovery and fallback to the single call, the diff in the run result, the flag `knowledge.agentic_generation`, the customer timeline UI (Arabic and English, e2e, axe, screenshots).
- Needs from you before real use: the S-AG4 items above; for tests, the mock suffices.
**Cross-cutting open items:** the benchmark thresholds in AC-AG-10 (PROPOSED, for your acceptance before S-AG5) and the provider selection.
