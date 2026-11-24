# Adapter: OpenAI (model, Chat Completions) — IMPLEMENTED BEHIND D11, NOT VERIFIED LIVE

Status (P3-S01, 2026-11-24): `packages/adapters/model/src/openai.ts` (`OpenAIModelAdapter`) is implemented against the documentation below and exercised only against a **stubbed transport** with
doc-shaped payloads (`rest-adapters.spec.ts`: SIMULATED). It is **not registered** in any registry, holds no key, and refuses every call unless `liveEnabled()` is true (the `AI_LIVE_PROVIDERS` gate,
D3) and a key exists. Sequencing decision **D11** still stands: OpenAI stays disabled and un-probe-able until its own D1/D2/D3/D4/D5/D6/D9 evidence exists. Nothing in this file is `LIVE-VERIFIED`.

## Source (read 2026-11-24, by the P3-S01 session; official pages only)
`platform.openai.com` URLs redirect to `developers.openai.com`. Pages: `/api/reference/resources/chat` (first 39,929 of 229,021 characters verbatim; the rest by model summary),
`/api/reference/resources/chat/subresources/completions/streaming-events`, `/api/reference/overview`, `/api/docs/guides/error-codes`, `/api/reference/resources/models/methods/list`,
`/api/docs/models`, `/api/docs/pricing`, `/api/docs/guides/migrate-to-responses`, `/api/docs/guides/reasoning`. The pages carry no "last updated" date.

## Operations used
| Adapter step | Documented operation | Notes |
|---|---|---|
| complete / stream | `POST https://api.openai.com/v1/chat/completions` | host fixed in code; `Authorization: Bearer <key>`; no organisation/project header |
| output ceiling | `max_completion_tokens` | `max_tokens` is documented as deprecated and incompatible with o-series |
| roles | `developer` (replaces `system` "with o1 models and newer"), `user`, `assistant`, `tool` | system text is sent as `developer` |
| JSON output | `response_format: {type:"json_object"}` plus an instruction message | `json_schema` is recommended by the vendor for models that support it: not used (support per model unknown) |
| tools | `tools[]` `{type:"function", function:{name, description, parameters}}`; `tool_choice` `none`/`auto`/`{type:"function",function:{name}}`; `parallel_tool_calls` boolean (default true) | `strict` not used |
| tool call in a response | `choices[0].message.tool_calls[]` `{id, type:"function", function:{name, arguments (string)}}` | arguments are parsed by the adapter; invalid JSON is `invalid_response` |
| tool result | `{role:"tool", tool_call_id, content}` after an assistant message carrying `tool_calls` | the wire has no error flag: an error result is prefixed `[error]` |
| finish reasons | `stop`, `length`, `tool_calls`, `content_filter` (+ deprecated `function_call`) | `content_filter` and `message.refusal` → `refusal` |
| usage | `usage.prompt_tokens`, `usage.completion_tokens` | `null` when absent; reasoning tokens are inside `completion_tokens` per the documented "including … reasoning tokens" wording for the ceiling (billing treatment NOT VERIFIED) |
| streaming | `stream:true`, `stream_options:{include_usage:true}`; SSE; `delta.content`; `delta.tool_calls[]` `{index, id?, function:{name?, arguments?}}`; final chunk has `choices: []` and `usage`; `data: [DONE]` | "if the stream is interrupted or cancelled, you may not receive the final usage chunk" (usage then `null`: the gateway estimates and flags it) |
| request id | response header `x-request-id` | accepted only when it has the `req_…` shape used by the evidence schema |
| discovery | `GET /v1/models` → `{object:"list", data:[{id, object, created, owned_by}]}` | read-only, nothing billed |

## Errors (what the documentation states, and what it does not)
401 (invalid key, not a member of an organisation, IP not authorised), 403 (country/region not supported), 429 (rate limit and several billing codes), 500, 503 are listed; 404/409/413/422 have **no
numeric mapping** in the guide. Mapping: 408/504/524 → `timeout`, 429 → `rate_limited` (retryable, with `Retry-After`), other 5xx → `unavailable`, 401/403 and any other 4xx → non-retryable
`invalid_request`. A 429 whose `error.code`/`error.type` is one of `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
`organization_usage_limit_exceeded` is **not retryable** (documented: "Retrying billing, spend, or quota errors won't restore API access"). Only those allow-listed identifiers are read from the
body; the vendor's message is never carried.

## Declared facts (model, limits, price)
`gpt-6.1-terra`: context 1.05M, max output 128K, USD 1 / 5 per 1M tokens input/output (standard, short context ≤ 272K; models and pricing pages, "Functions" listed under Tools). Not claimed: quality,
rate limits, deprecation dates, region, retention, training use (all unknown until D2/D5 evidence).

## Conflicts and unknowns carried as obligations (all stay `unknown = unsupported` until a VERIFIED evidence row, D8)
1. **Tool calling on Chat Completions for the declared model.** The models page lists "Functions" for GPT-6.1 Terra, but the reasoning guide states "Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol", and the migrate guide states that "Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort` values other than `none`". The adapter therefore sets `reasoning_effort:"none"` when tools are sent; whether the declared model accepts that is **NOT VERIFIED** (a rejection records NOT VERIFIED in the probe and tools stay off). If the probe fails the follow-up is the Responses API (the vendor's recommended API for new projects), which is a separate adapter and an ADR.
2. `temperature` restrictions on newer models are NOT FOUND: the adapter sends none. Tool-call id format constraints are NOT FOUND: only `[A-Za-z0-9_-]{1,64}` ids are echoed back.
3. The error body is documented only by field names (`error.message/type/code/param`), not as a literal example.
4. Streaming `finish_reason` placement and the first-fragment rule for `id`/`name` were read from a model summary of the schema, not verbatim; the stream path is NOT VERIFIED.
5. Context/max-output of non-flagship models: NOT FOUND (not declared).

## Decisions required before the first live request (D11)
D1 residency · D2 agreement and data terms (HG-09-01) · D3 live gate in a named non-production environment · D4 dedicated key with a vendor-side cap · D5 region/ROPA · D6 rate card · D9 bounded probe with its own cost
bound (`probeCostBound` uses this adapter's pricing). Tracked in `docs/parallel/OWNER-DECISIONS.md`.

## Offline fixtures
`rest-adapters.spec.ts` (doc-shaped payloads, labelled SIMULATED). No payload was recorded from the real service; none may be invented as "recorded".
