# S-AG4 preparation — Anthropic Claude as the proposed first provider

Date: 2026-11-22 · Status: **PREPARED, NOT ENABLED.** Claude is the *proposed* first provider; D-18 (provider and residency) and HG-09-01 (contract and data terms) are still **OPEN**. Nothing here is a statement about Anthropic's contract terms, regions or retention: those facts come only from the signed agreement and are recorded by a human. No live provider request has been made or is possible in this build (§5, gate G9).
Later documents: the final approval checklist `S-AG4-DECISIONS.md` (supersedes §8 as the checklist), `S-AG4-PROBE-PLAN.md`, `S-AG4-PRICING.md`. Governing documents: ADR-066, SCR-K-10, SCR-K-11, `docs/09 §7`, `docs/adapters/anthropic.md`, `docs/runbooks/anthropic-live-enablement.md`.

## 1. HG-09-01 — model provider API contract and enterprise data terms (owner)
**What it must produce.** A signed agreement (or accepted online terms plus a written confirmation) and a reference the platform stores on the provider row: `attestationRef` (3–200 characters) and the flags `retainsPrompts` and `trainsOnData` (`true`, `false` or `unknown`). `attest` is a human platform-admin action; the code refuses an empty reference and never fills the flags itself (`provider.service.ts: attest`).

**Evidence package the owner assembles (to be answered from the contract, not from this document):**
| # | Question | Why the platform needs it | Where it is recorded |
|---|---|---|---|
| 1 | Legal entity, agreement type, version and date; who signed | accountability | `attestationRef` |
| 2 | Is customer prompt/completion content used to train models? | `trainsOnData` | provider row `data_terms` |
| 3 | Is content retained? For how long, for what (abuse monitoring, support)? Is a zero-retention option available and in force for this key? | `retainsPrompts` | `data_terms` |
| 4 | Where is the content processed and stored (country/region)? Can the region be chosen or pinned? Does support or abuse review access content from other regions? | residency (D-18), `region` | provider `region`, ROPA |
| 5 | Sub-processors and their locations | ROPA, PDPL | ROPA processor entry |
| 6 | Data processing addendum / transfer mechanism; breach notification time; deletion on request; audit rights | PDPL role and transfer assessment (D-14, D-16, HG-04-01) | transfer assessment |
| 7 | Acceptable-use terms for an AI coding agent that edits customer projects | product legal | counsel memo |
| 8 | Rate limits, price list, currency, model deprecation notice | rate card, cost limits | rate card version |
| 9 | Who at the vendor is the security contact; status/incident channel | runbook `ai-provider-outage` | runbook |

**What the code does with the answer (verified by tests, §5):**
- An **unattested** provider can never be enabled (service check and table CHECK); unknown flags are treated as "may retain and may train", so `personal` and `customer-content` are not sent to it unless the owner sets `AI_ALLOW_UNATTESTED_SENSITIVE` (**must stay false**).
- Attesting again, replacing the key or changing the rate card disables the provider again (it must be re-requested and re-approved).
- The `claude` provider is **not** one of the `mock-*`/`local-*` development-reference codes, so the two-person rule applies: one admin requests, a different admin enables.

## 2. D-18 — provider and inference residency
**The decision still open:** in-Kingdom / locally hosted model versus an external API, per data class, governed by D-14 (residency stance), D-16 (PDPL roles) and HG-04-01 (counsel memo). Options, as they bind the code:
| Option | Meaning for Claude | What must exist before customer content flows |
|---|---|---|
| A. In-Kingdom only | Claude is not used for `customer-content` or `personal` data unless the contract provides in-Kingdom processing that a human has verified | a verified in-Kingdom region on the provider row |
| B. External API with transfer assessment | Claude is allowed per organization when that organization's policy permits the target country and an approved, unexpired transfer assessment covers (class, region, processor) | counsel memo, per-class assessment, org policy, ROPA entry |
| C. Hybrid | public/internal content to Claude; customer content to an in-Kingdom model when one exists | A or B for the classes that go out |

**What the platform enforces regardless of the option (M04 residency service, called by the gateway for every candidate provider and every call):** the organization policy mode (default `in_kingdom_only`), the per-class floor, allow-listed countries, approved and unexpired transfer assessments, and the processor's ROPA entry covering the data class. An unverified or unspecified region is never in-Kingdom (it is "other"). A failure of the check is a denial. A provider that is not allowed is never a fallback candidate, so residency cannot be crossed by a retry. The agent's calls use data class `customer-content` (the loop) — the strictest class a builder prompt can carry.

**For Claude specifically the provider row is created with region `unspecified`** (`save_claude_key`): a human states the real region only after answering question 4 above. Until then the residency check denies customer content, which is the intended safe state.

## 3. Gates between "a key is saved" and "a customer's project reaches Claude"
Each gate is independent; all must be open. New gates of this preparation are **G9** and **G10**.
| Gate | Rule | Enforced in | Evidence |
|---|---|---|---|
| G1 | `ai.enabled` flag (global or org) and the kill switch | AI module guard, gateway | `gateway.int.spec.ts` (flag and kill-switch tests) |
| G2 | A key in the non-production vault (production profile cannot store one) | `ModelProviderService.setCredential/saveClaudeKey`, `SecretStore` | `provider-credential.spec.ts`, `anthropic-adapter.int.spec.ts` (vault block) |
| G3 | Data terms attested by a human with a reference (HG-09-01) | `attest`, table CHECK | `gateway.int.spec.ts` (provider enabling rules) |
| G4 | A rate card with the model (credits per million tokens, integer strings) | `configure`, `assertEnableable` | same |
| G5 | Two people: request then enable by a different admin | `requestEnable`, `enable` | same |
| G6 | Residency per organization and data class (D-18/D-14) | `GatewayService.verdicts` → `assertResidency` | `gateway.int.spec.ts` (residency tests) |
| G7 | ROPA processor entry for `claude` covering the data classes | residency evaluator | `ropa-coverage`, evaluator specs |
| G8 | Credit balance, budgets and per-run caps | `BudgetService.reserve` | `anthropic-adapter.int.spec.ts` (cost limits) |
| **G9** | **The owner lists `claude` in `AI_LIVE_PROVIDERS`** (default empty; ignored in production). Closed: the adapter refuses before reading the key and the admin connection test is refused. | `AnthropicModelAdapter.liveEnabled`, `ai.module.ts`, `ModelProviderService.testConnection` | `anthropic-v11.spec.ts`, `anthropic-adapter.int.spec.ts`, `ai-config.spec.ts`, `provider-credential.spec.ts` |
| **G10** | **Tool calling counts for a real provider only while the latest recorded evidence row for (provider, model, capability) is VERIFIED for the adapter's current contract** (S-AG4b, D8 approved 2026-11-22; the interim `AI_CLAUDE_CONTRACT` switch was removed; the Claude adapter is built as a 1.1 candidate and declares nothing until evidence exists; dev-reference `mock-*`/`local-*` providers are exempt) | `GatewayService.offers`, `ModelProviderService.recordCapabilityEvidence`, migration 1870 | `capability-evidence.int.spec.ts` |
| G11 | `knowledge.generation`, `knowledge.agentic_generation`, `ai.agent.read_tools` (all default off) | S-K6/S-AG2/S-AG3 | S-AG3 tests |
| G12 | Production: no key can be stored (D-12) and the adapter is not registered | `ai.module.ts`, `provider.service.ts` | `provider-credential.spec.ts` |

## 4. Non-production credential vault (prepared, nothing hardcoded)
- **Storage:** the admin console action `save_claude_key` (or `set_credential`) seals the key in the `SecretStore` (`vault://dev/…` AES-256-GCM files under `.dev-vault/`, or `vault://mem/…` in tests). The database stores only the vault **reference**; the audit event, the API answers and the provider list carry only the reference.
- **Read:** the adapter reads the key at call time through `getApiKey`, only for a reference matching `^vault://(dev|mem)/ai-`, and keeps nothing but the SDK client built for the current key; a replaced key is picked up on the next call.
- **Lifecycle:** saving a key disables the provider again; `clear_credential` deletes the stored key and the reference and disables the provider; rotation is "save again" (then request and approve enabling again).
- **Production:** the key cannot be stored and the adapter is not registered (D-12: Vault/OpenBao/KMS not decided). The adapter code does not change when the production vault arrives: only the `SecretStore` implementation.
- **No secret in code:** the integration test stores a key through the admin API and then searches every row of every table for it (none found); `pnpm scan:secrets` covers the repository (its one existing finding is unrelated, see the report). Test keys are generated at run time with a `test-only-` prefix.
- **Network:** one host fixed in code (`https://api.anthropic.com`); `ANTHROPIC_BASE_URL` and environment tokens are ignored.

## 5. The Anthropic adapter at contract 1.1 (implemented, offline-verified only)
`packages/adapters/model/src/anthropic.ts`, option `contract: '1.1'` (default `'1.0'`: unchanged behaviour and no tool capability).

| Contract element | Messages API mapping (from the provider documentation; **NOT LIVE-VERIFIED**) |
|---|---|
| `tools` | `tools[]` with `input_schema`; checked first (`assertToolRequest`): declared capability, well-formed specs, limits |
| `toolChoice` auto / none / `{name}` | `{type:'auto'}` / `{type:'none'}` / `{type:'tool', name}`; `disable_parallel_tool_use: true` unless more than one call was asked for |
| assistant `tool_call` block | `tool_use` block (`id`, `name`, `input`) |
| user `tool_result` block | `tool_result` block (`tool_use_id`, `content`, `is_error`), placed first in its message |
| history with tool blocks but **no tools** (the forced last turn of the agent loop) | written as plain text (the API refuses tool blocks without `tools`); the result text is already fence-framed as untrusted data by the loop |
| response `tool_use` + `stop_reason: tool_use` | `toolCalls` + `finishReason: tool_calls`; validated (declared names, unique ids, object arguments, within the allowed number) |
| `stop_reason: max_tokens` with a tool call; `pause_turn`; `tool_use` with no call | `invalid_response`, never retried, never passed on |
| streaming | `content_block_start` / `input_json_delta` / `content_block_stop` → `toolCallDelta` / `toolCallDone`; the gateway assembler validates; usage from the final message |
| cancellation | the caller's signal aborts the request; a consumer that stops reading aborts it too |
| errors | fixed sentences and the HTTP status only; no upstream message, no key |
Conversations the API would refuse (an unanswered call, an orphan result, a bad id) are refused **before** a billed call.

**Verified offline (this preparation):** the conformance kit **with a scenario driver** (all cases, none skipped); the real SDK against stubbed `fetch` (request shapes, a recorded-shape event stream); cancellation, error mapping, key non-disclosure; through the **real gateway**: provider-reported usage metering, per-organization isolation, run budget and wallet limits (refused before any provider call), streaming equal to non-streaming and charged once, a stream that drops is neither retried nor charged, cancel releases the reservation, an undeclared tool or malformed arguments fail the call at no cost, schema-violating arguments are rejected with reasons, a tool result is data and the secret scan covers it.
**NOT verified:** that the live service accepts these requests as written, that the model uses tools well, the declared limits and price, the data terms, latency, and every behaviour under real load. A live probe (§6) is needed and is a human-gated step.

## 6. The live probe plan (not run; needs G2–G9 and the owner)
One bounded request per capability on the proposed model with a throw-away prompt and **no customer data**: (1) one tool call with a forced tool; (2) a parallel pair; (3) a streamed tool call; (4) a tool result round trip; (5) a cancelled stream; (6) the token-limit stop with a tool. Cost: a few cents at the list price in the adapter, capped by `maxTokens`. The result is recorded as `VERIFIED` or `NOT VERIFIED` evidence (SCR-K-11 items 3–4, once approved); only `VERIFIED` rows may declare a capability. Re-read the documentation first (model id, limits, price are cached from 2026-11-03).

## 7. Findings made while preparing
- **Fixed (cancellation):** a call whose caller signal was **already aborted** never fired its `abort` event in the gateway, so the call still went out. Now the attempt is aborted immediately (adapter refuses, reservation released). A regression test covers it.
- **Interim switch:** `AI_LIVE_PROVIDERS` is an environment setting, not an audited record (the `AI_CLAUDE_CONTRACT` switch was replaced by the audited evidence table on 2026-11-22).
- **Behaviour change to be aware of:** the admin "connection test" for Claude used to call the vendor whenever a key was stored; it is now refused until `AI_LIVE_PROVIDERS` lists `claude` (decision D3).

## 8. Decisions that need your approval before any live integration
| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | **D-18:** which option (A in-Kingdom only, B external with transfer assessment, C hybrid) and whether Claude may receive `customer-content` at all | B only after counsel's memo, per organization and per class; otherwise public/internal content only | any customer-content call |
| D2 | **HG-09-01:** agreement and data terms for the Claude API: sign or accept the terms, and record the reference and the answers to §1 (training, retention, zero-retention, region, sub-processors, DPA) | obtain zero-retention if offered; attest only what the contract states | enabling the provider |
| D3 | Approve opening the live gate: set `AI_LIVE_PROVIDERS=claude` in a named non-production environment. Decide whether the key-validating connection test (model listing, no customer data) may run before D1/D2 | allow the connection test as the very first live step once the key is approved; keep model calls closed until D1 and D2 | any live request |
| D4 | Credentials: who creates the Claude API key (a dedicated non-production workspace key with a spend limit set at the vendor), who stores it (admin console, never chat or files), rotation owner | dedicated key, vendor-side monthly cap, rotate at the end of the trial | live probe |
| D5 | Region statement for the provider row (question 4) and the ROPA processor entry for `claude` (data classes, region, purpose) | state it from the contract only | residency allow |
| D6 | Rate card for `claude-opus-5-5`: credits per million input and output tokens (your price, above the vendor list price 4.00 / 20.00 USD) | set with margin; version it | enabling |
| D7 | Accept the OpenAPI delta of SCR-K-11 (items 1–4), including the choice between the three capability strings and a single `supportsTools` boolean | boolean + provider fields + evidence table | admin visibility, evidence |
| D8 | Declare tool calling for Claude only from recorded probe evidence (replace `AI_CLAUDE_CONTRACT`) | yes. **APPROVED 2026-11-22 and implemented (S-AG4b)** | agent on Claude |
| D9 | Approve the live probe (§6): scope, cost cap and who runs it | run once in the non-production environment | LIVE-VERIFIED |
| D10 | Keep `AI_ALLOW_UNATTESTED_SENSITIVE=false` and production closed: confirm | confirm | — |
| D11 | OpenAI and Gemini: when to prepare their adapters (same contract; each needs its own HG-09-01 and D-18 answer, price row and probe) | after Claude is verified | S-AG4 for them |
| D12 | Still open and unchanged: D-12 (production vault), D-21 (execution isolation), D-42 (production rollout), AC-AG-10 benchmark thresholds, D-38 | — | production, executable tools |
