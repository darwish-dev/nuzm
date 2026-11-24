# Adapter: Google Gemini (model) — INTEGRATION CONTRACT ONLY

Status: **DRAFT, NOT IMPLEMENTED. There is no adapter, no host, no key handling and no live call.** Sequencing decision **D11** (approved 2026-11-22): no adapter work for Google Gemini until Claude is verified
(`docs/ai-intelligence/S-AG4-DECISIONS.md`). This note and `packages/adapters/model/src/provider-drafts.ts` (`PROVIDER_DRAFTS.gemini`) prepare the contract so the work can start the day D11 is lifted.

## Sources
**None cited yet.** `docs/adapters/README.md` requires an adapter to be written only against the vendor's official documentation (URL, version, date read, exact operations). Every vendor statement in
this area is therefore *unknown = unsupported* until a human or a later session cites it. The machine-readable table has `source: null, verified: false` for every row.

## What an adapter has to map (neutral contract 1.1, `packages/adapters/model/src/types.ts`)
Each row is an obligation on the future adapter; the vendor column is intentionally empty.
| # | Neutral element | Vendor operation / field | Source | Verified |
|---|---|---|---|---|
| 1 | `complete`: messages and system text → request | — | — | no |
| 2 | `complete`: response → `text`, `finishReason`, `usage` (null when not reported) | — | — | no |
| 3 | `responseFormat: json` | — | — | no |
| 4 | `stream`: chunks → `delta` / `done` with usage | — | — | no |
| 5 | `tools` → vendor tool declarations (name rule, JSON-Schema subset, `TOOL_LIMITS`) | — | — | no |
| 6 | `toolChoice` auto / none / `Google Gemini` | — | — | no |
| 7 | assistant `tool_call` block ↔ vendor call representation | — | — | no |
| 8 | user `tool_result` block ↔ vendor result representation (`isError`) | — | — | no |
| 9 | parallel tool calls: control and maximum per response | — | — | no |
| 10 | streamed tool-call deltas → `toolCallDelta` / `toolCallDone` | — | — | no |
| 11 | cancellation: caller signal aborts; a consumer that stops reading aborts | — | — | no |
| 12 | errors → `ModelErrorCode` with a Retry-After hint (use `modelErrorFromHttpStatus` for status-based mapping) | — | — | no |
| 13 | token counting: provider-reported usage; local estimate with a documented margin | — | — | no |
| 14 | model listing (`discoverModels`) and per-model limits | — | — | no |

## What the platform will not assume (comes from the signed terms and a probe)
Agreement terms, retention, training use, region, sub-processors; model ids, context windows, output limits, prices, rate limits, deprecation dates; which tool-calling, streaming and parallel behaviours work
(unknown = unsupported until a VERIFIED evidence row exists for the contract version); that any credential exists.

## Decisions required before the first live request (same set as Claude, answered for Google Gemini)
D1 residency option · D2 agreement and data terms (HG-09-01) · D3 live gate in a named non-production environment · D4 dedicated non-production key with a vendor-side monthly cap · D5 region statement and ROPA entry ·
D6 customer rate card, currency and VAT · D9 approval of a bounded probe with its own plan and cost bound. Tracked in `docs/parallel/OWNER-DECISIONS.md` (D11 row) and `docs/ai-intelligence/OWNER-APPROVAL-CHECKLIST.md`.

## Acceptance for the future adapter (offline first)
1. `runModelConformance` with a scenario driver passes, no case skipped. 2. One host fixed in code; none from the environment, a request or the database. 3. Refuses before the key is read while the provider is
not listed in `AI_LIVE_PROVIDERS`. 4. Never passes an upstream message on. 5. Exercised against a stubbed transport (request shapes, a recorded-shape stream) before any live probe. 6. Capability evidence recorded through the
audited probe wrapper (D9) before any tool capability counts. 7. Documented here with citations, then `docs/runbooks/` enablement steps like `anthropic-live-enablement.md`.

## Offline fixtures available now
- The mock provider family (`MockModelAdapter`, ids `mock-*`) already stands in for any second provider in gateway tests (routing, fallback, residency, budgets, breaker, retry): `apps/api/src/modules/ai/resilience.int.spec.ts`, `gateway.int.spec.ts`.
- `modelErrorFromHttpStatus` (shared status → contract error mapping) is unit-tested and provider-neutral.
- Recorded wire fixtures for Google Gemini do **not** exist and must not be invented: they are created from a stubbed transport against cited documentation when D11 is lifted.
