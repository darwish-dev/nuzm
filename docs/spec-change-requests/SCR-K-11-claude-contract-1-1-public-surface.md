# SCR-K-11 — Public surface of the Claude adapter at contract 1.1 (S-AG4 preparation)

Status: **PROPOSED. Nothing in this request is applied to `spec/openapi/openapi.yaml` except one description sentence (§1, item 0). Each change below needs the owner's acceptance (SCR-K-10 §7).**
Related: ADR-066, SCR-K-10 §2 and §7, `docs/ai-intelligence/S-AG4-PREP.md`, `docs/adapters/anthropic.md`.

## 1. What changes and why
| # | Change | Where | Needed for | Kind |
|---|---|---|---|---|
| 0 | **Applied (documentation only):** the description of `POST /v1/admin/ai/model-providers/{id}/connection-test` says it is refused with `422 unsupported_capability`, before the key is read, while live calls to the provider are not approved (`AI_LIVE_PROVIDERS`). No schema, status code or field changed (422 is already declared). | `testAiModelProviderConnection` | honesty of the contract | none |
| 1 | `AiModel.capabilities` enum gains `tool-use`, `streaming-tool-calls`, `parallel-tool-calls`. Today `GET /v1/ai/models` filters them out (a test pins this), so a client never sees a value outside the enum. | `AiModel` | showing which models can drive the agent | additive enum widening |
| 2 | `AiModelProvider` gains read-only `contractVersion` (string, `1.0.0` or `1.1.0`) and `liveCallsApproved` (boolean: this environment lists the provider in `AI_LIVE_PROVIDERS`). | `AiModelProvider` | the admin console can show why a provider serves nothing | additive fields |
| 3 | New admin action `record_capability_evidence` on `POST /v1/admin/ai/model-providers` and a table `ai.model_capability_evidence (provider, model, capability, state, evidence_ref, probed_at, probed_by)` (migration in range `K`, `ai` extended by `K`, already allowed). A capability counts as declared only for a row in state `VERIFIED` with an evidence reference; this replaces the interim `AI_CLAUDE_CONTRACT` environment switch. | admin API, DB | "unknown = unsupported" (CLAUDE.md §4) | new action + table (additive) |
| 4 | New admin action `probe_tool_use` (LIVE; one bounded request per capability, no customer data, billed at list price, capped) that writes the evidence rows of item 3. **Not implemented**: it is a live provider call and stays off until the owner approves credentials, data terms and residency. | admin API | LIVE-VERIFIED capability record | new action (additive) |
| 5 | None for runs, plans, the timeline or the agentic flag (already in the contract since S-AG3). | — | — | — |

## 2. Compatibility impact
- **Existing public clients (customer API, SDK, console):** nothing changes while items 1–4 are not applied. After item 1, a client with a closed enum (a generated union type with an exhaustive `switch`) sees three new strings: the SDK in this repository is generated from the spec and its consumers only read `capabilities` as data, but third-party generated clients may need regeneration. Mitigation if that matters: keep the three values off `GET /v1/ai/models` and expose one boolean (`supportsTools`) instead; both are additive, the boolean is safer for closed enums.
- **Admin console:** items 2–4 add fields and actions the console may ignore; the `connection-test` call may now answer 422 where it used to call the vendor (item 0): the console already renders 422 as "not available".
- **Idempotency, auth, tenancy:** unchanged. The new admin actions require `admin:ai:manage`, MFA step-up and the audit event of the existing actions; nothing is org-scoped.
- **Database:** item 3 is expand-only (a new table); reversal is `DROP TABLE` in dev/staging, forward-fix in production.
- **Error registry:** no new code. A call refused by the live gate is `service_unavailable` (503) to the customer path (the adapter answers a non-retryable `unavailable`, the gateway has no other candidate) and `unsupported_capability` (422) on the admin connection test.
- **Versioning:** all four are minor, additive changes; no path or operation is renamed or removed.

## 3. Out of scope
OpenAI and Gemini adapters (they implement the same contract; their public surface is identical), embeddings, any execution tool, any production rollout.

## 4. Validation of the proposal (2026-11-22; details in `docs/ai-intelligence/S-AG4-DECISIONS.md` §2)
- `scripts/scr-k-11-draft.ts <dir>` builds the proposal from the current spec into draft documents (never into `spec/`); `scripts/openapi-compat.ts <base> <head>` compares them (rules and tests: `packages/sdk/src/compat.ts`).
- Item 1 as three capability strings (`draft-enum`): 0 breaking, **1 warning** (a value added to a response enum). Item 1 as a boolean `supportsTools` (`draft-flag`): **0 breaking, 0 warnings**. Items 2–4 (provider fields, two new request-enum values and their optional fields): 0 breaking.
- Both drafts pass Spectral; the SDK generates from both; `apps/web`, `apps/admin` and `apps/api` typecheck against the generated types. Recommendation unchanged: item 1 as the boolean.
- Not applied to `spec/openapi/openapi.yaml`. Applying needs the owner's acceptance (D7).
