# Adapter: Google Gemini (model, `generateContent`) — IMPLEMENTED BEHIND D11, NOT VERIFIED LIVE

Status (P3-S01, 2026-11-24): `packages/adapters/model/src/gemini.ts` (`GeminiModelAdapter`) is implemented against the documentation below and exercised only against a **stubbed transport** with
doc-shaped payloads (`rest-adapters.spec.ts`: SIMULATED). Not registered, no key, refuses every call unless `liveEnabled()` (D3) and a key exist. **D11** stands: disabled and un-probe-able until its own
D1/D2/D3/D4/D5/D6/D9 evidence exists. Nothing here is `LIVE-VERIFIED`.

## Source (read 2026-11-24 by the P3-S01 session; official pages only)
`ai.google.dev/gemini-api/docs` and `/api` redirect (301) to `aistudio.google.com`. Pages: `/api-reference/generate-content` (read to ~char 79,858 of 103,138), `/generate-content/generate-content`
(~39,912 of 149,681), `/generate-content/stream-generate-content` (request part verbatim; response/streaming part by model summary only), `/docs/function-calling` (documents the **Interactions API**, not
generateContent), `/docs/troubleshooting`, `/docs/api-errors` (Interactions API error codes), `/docs/api-key`, `/api-reference/models`, `/models/list-models`, `/docs/models`, `/docs/models/gemini-3.8-flash`,
`/docs/pricing`. `/docs/authentication` returned 404. The pages carry no "last updated" date except the model page ("September 2026").

## Operations used
| Adapter step | Documented operation | Notes |
|---|---|---|
| complete | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `v1beta` is the version in every documented example |
| stream | `POST …/models/{model}:streamGenerateContent?alt=sse` | `alt=sse` appears in the examples but its semantics are **not documented** |
| auth | header `x-goog-api-key` (API-key page) | the query form `?key=` also appears; the header is used so the key never enters a URL |
| request | `contents[]` (`role` "user"/"model", `parts[].text`), `systemInstruction`, `generationConfig.maxOutputTokens`, `generationConfig.responseMimeType` | no `temperature` (documented "silently ignored" on 3.6 Flash and newer) |
| tools | `tools[].functionDeclarations[]` `{name, description, parametersJsonSchema}`; `toolConfig.functionCallingConfig.mode` `AUTO`/`ANY`/`NONE` + `allowedFunctionNames` | `parametersJsonSchema` is "mutually exclusive with `parameters`"; the contract's name rule (`[a-z][a-z0-9_]{0,63}`) is stricter than the documented one |
| call in a response | `parts[].functionCall {name, args, id?}` | `id` is **optional**: the adapter derives a stable id (`gc<index>_<hash>`) when absent |
| result | `parts[].functionResponse {name, response (object; "error" key on failure), id?}` in a `user` turn | role for the result turn is **not stated**; only "user"/"model" are documented, so `user` is used |
| finish reasons | `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`, `MALFORMED_RESPONSE` … | refusals → `refusal`; the malformed/unexpected/too-many/missing-signature ones → `invalid_response`; `promptFeedback.blockReason` without a candidate → `refusal` |
| usage | `usageMetadata.promptTokenCount` (+ `toolUsePromptTokenCount`), `candidatesTokenCount` + `thoughtsTokenCount` | thinking tokens are billed as output ("Output price (including thinking tokens)") |
| discovery | `GET /v1beta/models?pageSize=100` → `models[].name` (`models/{id}`) | read-only |

## Errors
The generateContent reference documents **no error body**, and the error page documents the Interactions API's snake_case codes (`rate_limit_exceeded` 429, `payment_required` 402 "Don't retry", …). The adapter
therefore maps by **HTTP status only**: 408/504 → `timeout`; 429 → `rate_limited` (retryable; the troubleshooting page says retry on 429/408/5xx and not on 400/402/403); 5xx → `unavailable`; every other 4xx →
non-retryable `invalid_request`. `Retry-After` is not documented; it is honoured if a response carries it. The vendor's body is never read into a message. **Spend/quota 429s cannot be told apart from rate limits**
(no documented generateContent code): a quota 429 will be retried within the retry policy's bounds and then fail over: NOT VERIFIED.

## Declared facts
`gemini-3.8-flash` (badge "Stable"): input limit 1,048,576, output limit 65,536, "Function calling" supported (model page). Price USD 0.75 / 3.75 per 1M input/output **through 2026-12-31**, then 1.50 / 7.50 from
2027-01-01 (pricing and model pages): `GEMINI_PRICING_VALID_UNTIL` / `geminiPricingStale()` flag the date; the adapter **must be re-read before 2027-01-01**. Data use (pricing page): free tier content is used to improve
products, paid tier content is not: only the paid tier is acceptable (D2 decides). Not claimed: quality, rate limits, region, retention.

## Conflicts and unknowns carried as obligations (stay `unknown = unsupported` until a VERIFIED evidence row, D8)
1. **Parallel function calls** are documented only for the Interactions API, not for generateContent: `parallel-tool-calls` is **not declared**; a response with two calls is `invalid_response`.
2. **Streamed function calls**: the streaming framing, where `usageMetadata` appears and whether a call arrives whole were **NOT FOUND** for streamGenerateContent: `streaming-tool-calls` is **not declared**. The adapter reads SSE `data:` events, each a whole response, usage from the last chunk that has it: NOT VERIFIED.
3. **Result-turn role** `user` vs `function`: the Tool reference mentions `Content.role "function"` while `Content.role` is documented as only user/model. `user` is used; the probe will say.
4. **Thought signatures**: `MISSING_THOUGHT_SIGNATURE` is a documented finish reason, but the field that carries a signature was **not read**; the adapter does not echo one. If a tool round trip fails with that reason the probe records NOT VERIFIED and tool use stays off (the contract has no field for opaque provider data; a follow-up contract change would be a Master request).
5. Temperature range conflict in the docs (0–2 vs 0–1) is moot: none is sent. `responseSchema` is not a documented generationConfig field (`responseJsonSchema` is): not used.
6. Token limits and tool support of other models (3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite): NOT FOUND (not declared). `gemini-2.5-flash` is deprecated (routing changes 2026-12-01).

## Decisions required before the first live request (D11)
Same set as OpenAI: D1, D2 (paid tier terms), D3, D4, D5, D6, D9 with its own cost bound.

## Offline fixtures
`rest-adapters.spec.ts` (doc-shaped, SIMULATED). No payload was recorded from the real service.
