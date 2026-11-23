# S-AG4 — pricing requirements for Claude (no rate is invented)

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
