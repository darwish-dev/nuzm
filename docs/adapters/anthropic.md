# Adapter: Anthropic Claude (model)

Status: **implemented (dev profile only), NOT VERIFIED for quality, NOT enabled anywhere.** Provider choice (D-18) and the human attestation of its data terms
(HG-09-01) are still OPEN; nothing here is a statement about either.

Code: `packages/adapters/model/src/anthropic.ts` (`AnthropicModelAdapter`), contract `docs/09 §7`, conformance `runModelConformance`.

## Sources (official documentation; re-check before relying on a number)
- Anthropic Messages API and SDK usage (`@anthropic-ai/sdk`, pinned 1.8.0): https://platform.claude.com/docs/ and https://github.com/anthropics/anthropic-sdk-typescript
- Model list, context windows, output limits and list prices (claude-opus-5-5: 1M context, 128K max output, USD 4 / 20 per million input / output tokens). The values in the
  adapter come from the documentation's model table as cached on 2026-11-03. They can be re-read live with the Models API (`GET /v1/models/{id}` returns
  `max_input_tokens` and `max_tokens`); the connection test in the admin console lists models with the stored key.

## What the adapter declares
| Fact | Value | Why |
|---|---|---|
| model | `claude-opus-5-5` only | one price pair per adapter in the contract; a second model needs its own price row |
| region | `unspecified` unless the provider row says otherwise | where Claude processes data is a human, legal statement |
| data terms | `attested: false`, retains/trains `unknown` | only a human attests (HG-09-01); the gateway reads the attested terms from the provider row |
| pricing (our cost input) | USD 4.00 in / 20.00 out per million tokens | documentation list price; the customer-facing credit rate card is a separate, human-set row |

## How a call is made
- One host, fixed in code: `https://api.anthropic.com` (never from the environment, a request or the database). `ANTHROPIC_BASE_URL` and environment tokens are ignored.
- The key is read from the sealed secret store at call time through `getApiKey`; the adapter keeps nothing but the client built for the current key.
- `max_tokens` is the gateway's ceiling. No `temperature`/`top_p` (removed on this model), no assistant prefill, thinking left at the model default, effort `medium`.
- `responseFormat: json` adds one trusted instruction to the system text; the caller still validates the JSON against its schema.
- `maxRetries: 0`: retries are the gateway's decision (attempts per candidate). The SDK error classes are mapped most specific first to the contract's error codes; the upstream message is never passed on.
- Refusals (`stop_reason: refusal`) come back as `finishReason: refusal`. **Server-side fallbacks are NOT enabled**: a fallback would serve the request from another model, which has its own price and its own data terms; that is a decision for the owner.

## What still has to happen before a customer request can use it
1. Registered adapter (done, dev profile only: registered when the process is not in production).
2. A rate card for `claude-opus-5-5` on the provider row (credits per million tokens): the owner's pricing.
3. Human attestation of the data terms (HG-09-01) with a reference.
4. A request to enable and an approval by a different person (two-person rule).
5. A region on the provider row and an approved residency assessment / organization policy that allows customer content to go there (M04): a compliance record, not a setting.
6. An AI credit balance on the organization.
Production is blocked until the production vault (D-12) exists: the key cannot be stored there, so the adapter is not registered in a production process.
