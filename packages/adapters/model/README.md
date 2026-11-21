# @nuzm/adapter-model

`ModelAdapter` contract (docs/09 §7), the deterministic scripted/record-replay **mock** adapter and the conformance suite (M09 S37).

No real model provider is implemented here: provider choice (D-18) and the human attestation of data terms (HG-09-01) are OPEN. A real adapter is added only from the
provider's official documentation (cited in `docs/adapters/<provider>.md`) and must pass `runModelConformance`.

## Contract 1.1 (D-46, ADR-066, SCR-K-10; slice S-AG1)

Additive to 1.0: a 1.0 adapter and every 1.0 caller work unchanged. New: capabilities `tool-use`, `streaming-tool-calls`, `parallel-tool-calls` (per model, from official documentation and a probe; unknown = unsupported); neutral content blocks (`text`, `tool_call`, `tool_result`) on `ModelMessage`; `tools`, `toolChoice`, `maxToolCalls` on a request; `toolCalls` and `finishReason: 'tool_calls'` on a response; streamed `toolCallDelta`/`toolCallDone` chunks; error codes `invalid_response` and `unsupported_capability`.

- `contractAtLeast`, `effectiveCapabilities`: version negotiation (the 1.1 capabilities count only from an adapter that declares contract >= 1.1.0, and streaming/parallel only with `tool-use`).
- `assertToolRequest`, `toolSpecProblems`, `assertToolCalls`, `parseToolArgs`: the checks every adapter runs; `StreamAssembler`/`assembleStream`: turn a stream into one validated response; `normalizeModelError`: provider failures onto the contract codes (never carries the provider's message).
- The mock implements 1.1 (scripted tool calls; tool-capable models are opt-in: `MOCK_TOOL_MODELS`). `runModelConformance(make, { tools: { arrange } })` runs the 1.0 cases plus the 1.1 cases; behaviour cases need a scenario driver and are reported as skipped without one. A scripted mock proves the CONTRACT shape only, never model quality.
- The Anthropic adapter stays on 1.0: its tool-use capability must be read from the official documentation and probed first (S-AG4).
