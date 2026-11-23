# S-AG4 — the bounded live capability probe (PREPARED, NOT EXECUTED)

Date: 2026-11-22 · Status: **the harness exists and is tested with scripted clients only. It has never run against a live provider, it is not wired to any route, job, console action or environment variable, and it cannot start itself.** Running it live is decision D9 and needs D2, D3 and D4 first.
Code: `packages/adapters/model/src/probe.ts` (`runCapabilityProbe`, `probeWorstCase`, `assertProbeAllowed`), tests `probe.spec.ts` (15). Related: `S-AG4-PREP.md` §6, `S-AG4-PRICING.md`, SCR-K-11 items 3–4.

## 1. Purpose
Decide from observed behaviour whether a **candidate declaration** (the adapter built with contract 1.1: `tool-use`, `parallel-tool-calls`, `streaming-tool-calls`) may stand for one model. Unknown means unsupported (CLAUDE.md §4): until a recorded `VERIFIED` result exists the platform declares nothing.

## 2. The script (fixed; prompts and tools are constants of the module)
| # | Step | Request | Passes when | Feeds |
|---|---|---|---|---|
| 1 | `auto_call` | tools offered, choice auto | a valid tool call, finish `tool_calls` | tool-use |
| 2 | `forced_call` | choice = a named tool | that tool is called | informational (the loop uses auto/none only; with always-on thinking a forced choice may be refused by the service: this records it) |
| 3 | `parallel_calls` | up to 2 calls allowed | two calls with distinct ids in one response | parallel-tool-calls |
| 4 | `streamed_call` | streaming | the assembled stream carries a valid call | streaming-tool-calls |
| 5 | `tool_round_trip` | the call of step 1 answered with a result | the model answers in text and calls nothing | tool-use |
| 6 | `tool_choice_none` | choice none | no call although tools were offered | tool-use |
| 7 | `truncated_call` | `maxTokens` 16 | no truncated call is returned (a refused cut-off answer also passes) | tool-use (safety) |
| 8 | `cancelled_stream` | stream, cancel after two chunks | the stream stops with `aborted` | tool-use (safety) |
Rule: `tool-use` is `VERIFIED` only if 1, 5, 6, 7 and 8 all pass; `parallel-tool-calls` needs `tool-use` and 3; `streaming-tool-calls` needs `tool-use` and 4. A partial probe (stopped early) verifies nothing; steps that did not run are listed as not run.

## 3. Bounds and worst case (shown to the approver before approving)
- At most **8 requests**, no retries; per-request output ceilings 300, 300, 400, 300, 300, 200, 16 and 300 tokens (sum 2,116); an input allowance of 1,200 tokens per request (the tool schemas and the short prompt).
- **Worst case: 11,716 tokens** (2,116 output + 9,600 input). At the list price read on 2026-11-22 (input $4, output $20 per million; `S-AG4-PRICING.md`): about **USD 0.08** (9,600 × $4 + 2,116 × $20 per million), and an absolute upper bound of **USD 0.24** if every token were priced as output. Thinking tokens are billed as output and are inside `max_tokens`, so the ceilings hold. These are arithmetic on a list price, not a quote.
- The approval must state a token cap **at least the worst case** and at least 8 requests, or the probe refuses to start. While running, the total is tracked from provider-reported usage (an unreported count is charged at the allowance) and the probe stops before a request that could pass the cap.
- A credential/availability error, a timeout, a refusal or a rate limit **stops the probe at once**. Only a malformed or cut-off answer (`invalid_response`) is informative and lets it continue.
- Layers outside the probe: the vendor-side monthly cap on the dedicated key (D4), the platform kill switch, `AI_LIVE_PROVIDERS` (D3).

## 4. What it can never send
No customer, organization or project data: the messages are the eight constants above and the tools are the two kit tools (`echo`, `lookup`). The report carries fixed sentences only (no provider message, no key). Nothing a model returns is executed: a returned call is only inspected. It refuses to start in a production process, without a recorded approval (reference, approver, `non-production`, request and token caps), or for an adapter that does not implement contract 1.1.

## 5. How it will be run when approved (design; nothing below exists yet)
1. A platform admin with `admin:ai:manage` and MFA starts `probe_tool_use` (SCR-K-11 item 4) naming the provider, the model, the approval reference and the token cap. Not implemented until D7.
2. The call goes **through the gateway**, not around it, as a dedicated internal organization ("platform probe", own small wallet and budget, data class `public`, no customer content, no membership), so reservation, residency evaluation, metering, budgets, the secret scan and audit are exercised exactly as for customers and the cost is visible and capped. Probe usage is never billed to a customer organization. (A thin adapter around `gateway.invoke` implements the harness's `ModelAdapter` target.)
3. Audit events at start and finish (`ai.provider.probe_started` / `_finished`: actor, provider, model, approval reference, requests, tokens, result per capability, no content).
4. The report is stored (SCR-K-11 item 3 evidence table: provider, model, capability, `VERIFIED` or `NOT VERIFIED`, evidence reference, time, who) and only `VERIFIED` rows declare a capability. A model or adapter change invalidates the row.
5. A failed or partial probe is recorded as `NOT VERIFIED`; nothing is retried automatically.

## 6. Approval record (template the owner fills when D9 is decided)
`ref`: ______ · `approvedBy`: ______ · environment `non-production` · provider/model: Claude / `claude-opus-5-5` · `maxRequests` ≥ 8 · `maxTotalTokens` ≥ 11,716 · vendor-side cap in force (yes/no, amount) · D2 reference · D4 key owner · gate opened by (D3): ______ · date: ______.

## 7. Not in this preparation
No admin action, route, evidence table, job or script that runs the probe; no live call of any kind; no OpenAI or Gemini target (the harness is provider-neutral and is exercised against the scripted mock to show it).
