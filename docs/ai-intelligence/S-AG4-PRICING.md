# S-AG4 — pricing requirements for Claude (no rate is invented)

> **Phase 2 re-verification 2026-11-24: see §5. The `claude-opus-5-5` list price is UNCHANGED ($4 / $20 per MTok); the probe bound is recomputed from code and stays under the earlier USD 0.24.**

Date: 2026-11-22 · Status: **REQUIREMENTS DOCUMENTED; list prices READ from the vendor's public pages; NOT confirmed against any contract, order form or invoice.** The platform's customer rate card (D6) is the owner's commercial decision; this document supplies the inputs and the rules.

## 1. What was read, how, and when
- Method: a read-only fetch of two public documentation pages on 2026-11-22 (no API call, no account, no key): `https://platform.claude.com/docs/en/about-claude/pricing` and `https://platform.claude.com/docs/en/about-claude/models/overview` (both HTTP 200). The figures below are what those pages state for the model `claude-opus-5-5` ("Claude Opus 5.5"). Neither page shows a "last updated" date (NOT STATED), so the date above is the date it was read.
- Not authoritative for Nuzm: enterprise or negotiated terms, taxes, currency conversion and billing-platform fees are not on a public page. **Before the rate card is set, the owner confirms each figure against the signed agreement or the vendor console (HG-09-01).**

## 2. Figures stated for `claude-opus-5-5` (USD, per million tokens, MTok)
| Item | Stated | Used by the platform? |
|---|---|---|
| Base input / output | $4 / $20 | **Yes**: the adapter's cost input `4.00 / 20.00` (cached 2026-11-03) equals this reading |
| Prompt caching: 5-minute write / 1-hour write / read | $5 / $8 / $0.20 | No (caching is not used, so none are expected). If a response ever reports cache tokens the adapter counts them as plain input: an over-count, never an under-count |
| Batch API (50% off) | $2 / $10 | No |
| Long-context tier | none: the full 1M context is at standard price | n/a |
| Fast mode (premium) | $8 / $40 | No |
| `inference_geo` "us" | 1.1x on every token category; default is "global" at standard price | No (the adapter sends no `inference_geo`) |
| Tool-use system-prompt overhead (`tool_choice` auto or none) | 286 input tokens per tool-using request | **Yes, as input tokens**: it is inside the provider-reported usage, so metering sees it |
| Tool-use overhead for `tool_choice` any or a named tool | **NOT STATED** for this model (the cell is blank) | Do not assume a number; the probe's forced-call step records the reported usage |
| Server tools (web search $10 per 1,000 searches, code execution hours, web fetch) | stated | **No**: no server tool is enabled; the adapter refuses a paused (server-tool) turn |
| Context window / max output (synchronous) | 1M / 128K tokens | Yes (adapter limits) |
| Tokenizer | the page says models from 4.7 on produce about 30% more tokens for the same text | **Yes**: the pre-flight estimate now carries a 1.3 margin (reservations are not too low); billing uses the provider-reported usage |
| Thinking / effort | adaptive thinking is always on; default effort medium | Output includes thinking tokens: they are billed as output and counted inside `max_tokens`, which stays the hard ceiling of every call |
| Retirement | "not sooner than September 22, 2027" | track in the provider row (re-check each quarter) |

## 3. Requirements the pricing process must satisfy
1. **Source of truth for a price** = the signed agreement or vendor console, then the public page. A figure in code or docs carries its source and date (`docs/adapters/anthropic.md`: "cached 2026-11-03"; this document: "read 2026-11-22").
2. **Two different numbers, never mixed:** the vendor's price (our COST, `ModelAdapter.pricing`, decimal strings per million tokens, currency stated) and the customer rate card (credits per million tokens, integer strings, the owner's price, versioned). The rate card must be at or above cost plus the owner's margin; the platform does not compute a margin.
3. **Every price dimension that can appear in `usage` has an owner decision:** input, output, and (if ever enabled) cache write/read, batch, fast mode, geography multiplier, server tools. A dimension that is not decided is **not enabled** (today: all except input and output).
4. **Currency:** the vendor bills in USD; the wallet is in the organization's currency (`AI_CREDIT_CURRENCY`, default SAR). The conversion, rounding and VAT treatment are finance decisions (D6) and must be written down before the rate card is set; the code uses integer minor units only.
5. **Change control:** a vendor price change is detected by re-reading the page quarterly and before every probe; the adapter value, this document and the rate card version change together with a recorded owner approval. Never "fix" a price silently.
6. **Cost controls already in force (verified, `anthropic-adapter.int.spec.ts`):** per-call `max_tokens` ceiling, per-run token and credit caps, organization budgets, wallet balance, reservation before the call, settlement on provider-reported usage, no hidden retry, a closed live gate. For the probe: a stated worst case (`S-AG4-PROBE-PLAN.md` §3) and a hard token cap.
7. **Vendor-side cap** (D4): the dedicated key has a monthly spend limit set in the vendor console by the owner. The platform's caps are a second line, not a substitute.

## 4. What is still NOT known (do not fill in)
The negotiated price (if any), the tool-use overhead for a forced tool choice, whether any region other than "global" and "us" exists for this model and whether processing in the Kingdom is possible (the pages state only "global" and "us"; absence from a page is not a statement that it is unavailable), the contractual currency and invoicing terms, and the price of the other models. These come from the agreement or the vendor (D2, D5, D6).

## 5. Phase 2 re-verification (2026-11-24) — current official figures and the probe cost, recomputed
**Method.** Read-only fetches of public documentation on **2026-11-24** (no API call, no account, no key): `https://platform.claude.com/docs/en/about-claude/pricing`, `https://platform.claude.com/docs/en/about-claude/models/overview` (canonical `…/docs/en/models/overview`), `…/docs/en/api/rate-limits`, `…/docs/en/api/errors`, `…/docs/en/manage-claude/workspaces`, `…/docs/en/manage-claude/authentication` (all HTTP 200). Neither pricing page shows a "last updated" date (NOT STATED). **A public list price is not a contract price**: D6 still needs the owner's confirmation against the agreement or the console.

### 5.1 Figures as stated on 2026-11-24 (USD per million tokens; cache and batch columns omitted where unused)
| Model (API id) | Input | Output | Retirement stated | Used by the platform |
|---|---|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | 4 | 20 | not sooner than 2027-09-22 | **Yes** (the adapter's only model). **Unchanged** against the 2026-11-22 reading and the adapter's cached 2026-11-03 value. |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | 2 | 10 | not sooner than 2027-09-28 | No (candidate for cheaper test runs: needs its own adapter row, probe and rate card) |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | 0.10 (prompt ≤ 100k) / 0.50 (> 100k) | 0.50 / 2.50 | not sooner than 2027-10-07 | No (priced by prompt length) |
| Claude Fable 5.2 (`claude-fable-5-2`) | 8 | 40 | not sooner than 2027-11-09 | No |
Other facts unchanged and still relevant: context 1M and max output 128K tokens (Opus 5.5); tool-use system-prompt overhead 286 input tokens for `tool_choice` auto/none; the overhead for a forced tool choice is **NOT STATED** for Opus 5.5 (the cell is blank; the probe's forced-call step records the reported usage); `inference_geo: "us"` is 1.1x on every token category and the adapter never sends it; adaptive thinking is always on (default effort medium) and thinking tokens are billed as output inside `max_tokens`; the tokenizer of 4.7 and later produces about 30% more tokens for the same text. **Nothing differs from §2, so no rate, bound or rate-card input changes.** (Opus 5.5 cache-hit pricing is now stated as 0.05x base input; caching is not used.)

### 5.2 The probe cost, computed (not typed): `probeCost()` in `packages/adapters/model/src/probe-cost.ts`, tested in `probe-cost.spec.ts`
Integer arithmetic in nano-dollars, rounded UP. Plan: 8 requests, no retries (the adapter is built with `maxRetries: 0`; the harness never repeats a request and stops at the first credential, availability, timeout, refusal or rate-limit failure). Each request is charged its **full output ceiling** (`maxTokens`, thinking included) and the **full input allowance of 1,200 tokens** (a generous bound: the two kit tool schemas are about 1,200 characters, about 300 tokens, times the 1.3 tokenizer margin, plus the 286-token tool overhead and a one-line prompt: roughly 700; this is an estimate, not a measurement, and the real usage is reported by the vendor).
| # | Request | Input allowance × $4/M | Output ceiling × $20/M | Hard maximum |
|---|---|---|---|---|
| 1 | `auto_call` | 1,200 → $0.004800 | 300 → $0.006000 | **$0.010800** |
| 2 | `forced_call` | 1,200 → $0.004800 | 300 → $0.006000 | **$0.010800** |
| 3 | `parallel_calls` | 1,200 → $0.004800 | 400 → $0.008000 | **$0.012800** |
| 4 | `streamed_call` | 1,200 → $0.004800 | 300 → $0.006000 | **$0.010800** |
| 5 | `tool_round_trip` | 1,200 → $0.004800 | 300 → $0.006000 | **$0.010800** |
| 6 | `tool_choice_none` | 1,200 → $0.004800 | 200 → $0.004000 | **$0.008800** |
| 7 | `truncated_call` | 1,200 → $0.004800 | 16 → $0.000320 | **$0.005120** |
| 8 | `cancelled_stream` | 1,200 → $0.004800 | 300 → $0.006000 | **$0.010800** |
| | **Total** | 9,600 tokens → **$0.038400** | 2,116 tokens → **$0.042320** | **USD 0.080720** (11,716 tokens) |
- **Hard maximum: USD 0.080720.** Arithmetic: 9,600 × 4 / 1,000,000 = 0.0384; 2,116 × 20 / 1,000,000 = 0.04232; sum 0.08072.
- **Absolute ceiling (every one of the 11,716 tokens priced as output): 11,716 × 20 / 1,000,000 = USD 0.234320** — below the earlier **USD 0.24** bound (so that bound still holds, now with the arithmetic shown).
- **Retries.** None are counted because none can occur. If a retry of every request were allowed anyway, each request would count again in full: **USD 0.161440** (the function's `retriesPerRequest: 1`). The gateway's retry policy (2 attempts per candidate) does not apply to the probe, which calls the adapter directly.
- **If `inference_geo: "us"` were ever used** (it is not): ×1.1 → USD 0.088792 and ceiling USD 0.257752.
- **Compared with the earlier figures:** earlier "about USD 0.08" and "bound USD 0.24": **same rates, same result** (0.080720 and 0.234320). **No rate differs from the 2026-11-22 reading.**
- The same bound at other list prices, for the record: Sonnet 5.5 (2/10): USD 0.040360; Haiku 5.5 (0.10/0.50, prompt ≤ 100k): USD 0.002018; Fable 5.2 (8/40): USD 0.161440. Only Opus 5.5 is used.

### 5.3 The live-verification suite (all nine checks) — `liveSuiteCost()` in `live-verification.ts`
The suite adds five small requests to the probe: `streaming` (500 out), `structured_output` (500), `cancel_mid_stream` (300; **skipped when the probe's own cancelled stream ran**, but still budgeted), and two recovery requests of the retry/breaker check (100 each), each with a 300-token input allowance. **Worst case: 13 requests, 14,716 tokens (11,100 in / 3,616 out) = USD 0.116720; every-token-as-output ceiling USD 0.294320.** The approval's money ceiling must cover 116,720,000 nano-USD (the runner refuses a lower one). Itemized extras at 300 in / listed out: streaming $0.011200, structured $0.011200, cancel $0.007200, recovery $0.003200, half-open trial $0.003200.

### 5.4 What the vendor says about spend limits (read 2026-11-24; used by `S-AG4-SPEND-CAPS.md`)
Organization monthly cap by tier: Start USD 500, Build USD 1,000, Scale USD 200,000, Custom none; an owner may set a lower limit under the tier cap in the Console ("Spend limits") and per-workspace limits. At the tier cap the API answers **HTTP 429 `rate_limit_error` with `details.error_code = "enforced_spend_limit_reached"` and no `retry-after`**; at an owner-set organization or workspace limit it answers **HTTP 400 `invalid_request_error`** with a message starting "You have reached your specified …". The adapter now maps both to a **non-retryable** `rate_limited` (earlier the 429 would have been retried). Who may set a limit in the Console: NOT STATED. Authentication: `Authorization: Bearer <key>` (legacy `x-api-key` also accepted), `anthropic-version` required; the three documented methods are API key, workload identity federation and app attestation.
