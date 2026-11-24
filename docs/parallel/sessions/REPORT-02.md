# REPORT-02 — Session 02, AI Providers / S-AG4

- Session: 02 · branch `feature/ai-providers` · worktree `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-providers` · Postgres port 54342 (not yet started) · migrations 1900–1919 (none used yet)
- Baseline commit: `9d16e7f3` (code baseline `f81872d5`). Current commit: see `git log` (updated at each checkpoint).
- Machine note: load average was 55 at start; only pure unit tests were run until it drops.

## 1. Gap list (found 2026-11-24 by reading the existing S-AG4 code; class per MASTER-PLAN §3)
Existing and offline-verified (not re-done): Claude adapter at contract 1.1 (tools, parallel, streaming, cancel, error mapping), conformance kit, probe wrapper (gated), evidence table 1870, provider service (configure/attest/two-person enable/vault key/kill switch), gateway (kill switch, secret scan, residency, data terms, ranking, reservation, call, settle, metering), budgets/credits, usage rows, admin UI `AiProvidersPanel`.

| # | Gap | Class | Plan |
|---|---|---|---|
| G1 | Retry policy is a bare attempt counter: no backoff, no jitter, no `Retry-After`, no abort-aware wait | READY | `resilience.ts` RetryPolicy + wire in gateway |
| G2 | No circuit breaker: a failing provider is re-tried on every call | READY | `resilience.ts` CircuitBreaker + gateway skip |
| G3 | No provider health monitor (success rate, latency, last error, breaker state) | READY | `resilience.ts` HealthMonitor, in-memory; API = contract request |
| G4 | Fallback is "any allowed ranked candidate"; there is no explicit approved-fallback policy | READY | `fallback.ts` policy (opt-in, default = today's behaviour) |
| G5 | Rate cards: one JSON per provider row, version is a free string, no effective dates, no history; no cost-side card; no currency conversion interface; no vendor-cost → credit derivation | READY (numbers = D6 OWNER-BLOCKED) | `ratecard.ts` versions + effective dates, `FxRateSource` interface, bigint conversion, derivation preview |
| G6 | Context management: gateway only excludes a model whose window is too small; nothing fits a conversation into a window while keeping tool call/result pairs intact | READY | `context.ts` |
| G7 | Model discovery / capability registry: static `models()` only; merge of declared + evidence + rate card lives inline in `GatewayService.offers` | READY | `registry.ts` pure merge reused by the gateway; Claude `discoverModels` gated like the live gate |
| G8 | Provider usage reporting: usage rows exist, no aggregate per provider/model/period | READY (service) / DEPENDENT (API + UI need CONTRACT) | usage report service + CONTRACT request |
| G9 | Rate-card version history table (append-only) | READY (migration 1900) / DEPENDENT (ownership manifest = Master) | decide after G5 |
| G10 | OpenAI / Gemini: no contract documents or offline fixtures | MOCKABLE (adapters OWNER-BLOCKED by D11) | docs + draft descriptors + synthetic fixtures, no adapter |
| G11 | Token accounting: provider-reported or flagged estimate exists; cache/reasoning token classes not modelled | NOT IN CONTRACT 1.1 — recorded as a contract-1.2 proposal | CONTRACT request |
| G12 | Admin UI: no health, usage or rate-card-history views | DEPENDENT on contract/SDK regeneration | after G3/G8 contracts |
| L1 | Live probe, live connection test, real key, real agreement, real rate card | OWNER-BLOCKED (D2, D3, D4, D5, D6, D9) / EXTERNAL-BLOCKED | not touched |

## 2. Completed tasks
(none yet)

## 3. Remaining / blocked tasks
See the gap list; blocked rows are class-tagged above.

## 4. Modified files · migrations · contract requests
(none yet)

## 5. Tests run (actual results)
(none yet)

## 6. Security findings
(none yet)

## 7. Integration requirements for the Master
(none yet)

## 8. Delivery completion · readiness
Not yet assessed.

## 9. Heavy-run requests
None yet.

## 10. Escalations / new owner decisions found
None yet.
