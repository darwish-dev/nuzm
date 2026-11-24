# REPORT-02 — Session 02, AI Providers / S-AG4

- Session: 02 · branch `feature/ai-providers` · worktree `/Users/elaf/Projects/nuzm/.claude/worktrees/ai-providers` · own Postgres `:54342` (database `nuzm_dev`, test databases `nuzm_test_*` created by the harness) · migrations 1900–1919: **1900 used** (`ai.model_rate_card_versions`)
- Baseline: `9d16e7f3` (code baseline `f81872d5`). Head when this report was last updated: see `git log` (last code commit `4b910f14`, docs `224fc159`).
- Scope: SESSION-02.md. **No live provider call, probe, credential, agreement, paid resource or live flag was used, accepted or enabled.** Every result below is VERIFIED OFFLINE (mock providers, stubbed transports), never LIVE-VERIFIED.

## 1. Gap list and outcome
Existing before this session (read, not redone): Claude adapter at contract 1.1, conformance kit, gated probe wrapper, evidence table 1870, provider service (configure / attest / two-person enable / vault key / kill switch), gateway (kill switch, secret scan, residency, data terms, ranking, reservation, settle, metering), budgets/credits, usage rows, `AiProvidersPanel`.

| # | Gap found | Outcome | Class / evidence |
|---|---|---|---|
| G1 | Retry = bare attempt counter (no backoff, jitter, `Retry-After`, abort-aware wait) | **Closed** | VERIFIED OFFLINE: `resilience.spec.ts`, `anthropic.spec.ts` (Retry-After from 429/529), `resilience.int.spec.ts` |
| G2 | No circuit breaker | **Closed** (per provider, half-open single trial) | VERIFIED OFFLINE: `resilience.spec.ts`, `resilience.int.spec.ts` |
| G3 | No provider health monitor | **Closed in the service** (in memory, per process); HTTP route + UI DEPENDENT on CONTRACT-1 | VERIFIED OFFLINE |
| G4 | Fallback = any allowed candidate; no approved-fallback policy | **Closed** (opt-in policy; default unchanged; can only narrow) | VERIFIED OFFLINE: `fallback.spec.ts`, `ai-config.spec.ts`, `resilience.int.spec.ts` |
| G5 | Rate cards: no history/effective dates; no FX interface; no vendor-cost→credit derivation | **Closed offline** (integer math, `FxRateSource`, derivation *preview*, version history table 1900); real numbers = D6 OWNER-BLOCKED | VERIFIED OFFLINE: `ratecard.spec.ts`, `rate-card-history.int.spec.ts` |
| G6 | Context management (fit a conversation, keep tool call/result pairs) | **Closed as a library** (`fitContext`); not forced on callers (agent loop = Session 05) | VERIFIED OFFLINE: `context.spec.ts` |
| G7 | Model discovery / capability registry (logic inline in the gateway) | **Closed**: one pure rule shared by gateway and registry view; Claude `discoverModels` behind the live gate | VERIFIED OFFLINE: `registry.spec.ts`, `provider-insights.int.spec.ts`, `capability-evidence.int.spec.ts` (unchanged, still green) |
| G8 | Usage reporting per provider/model/day | **Closed in the service**; HTTP route + UI DEPENDENT on CONTRACT-1 | VERIFIED OFFLINE: `provider-insights.int.spec.ts` |
| G9 | Rate card history table | **Closed** (migration 1900); manifest rows = CONTRACT-2 | VERIFIED OFFLINE (migrate, classification coverage, residency hooks, ROPA coverage on my cluster) |
| G10 | OpenAI / Gemini contracts and offline fixtures | **Closed as contracts only** (D11): drafts, no adapter, shared status→error mapping; no wire fixture invented | VERIFIED OFFLINE: `provider-drafts.spec.ts`; docs `openai.md`, `gemini.md` |
| G11 | Token classes (cache/reasoning) not modelled | **Documented** as a contract-1.2 proposal; do not implement before the owner prices them | OWNER-BLOCKED (D6 ext.), `CONTRACT-3` |
| G12 | Admin UI for health / usage / registry / rate-card history | **NOT DONE — DEPENDENT**: needs the routes in the spec and the regenerated SDK (CONTRACT-1) and i18n keys; building UI against unspecified routes would fail `spec:drift`. Data shapes and routes are fully specified in CONTRACT-1. | DEPENDENT (Master) |
| L1 | Live probe, live connection test, live discovery, real key, agreement, real rate card, residency approval | **Untouched** | OWNER-BLOCKED (D2, D3, D4, D5, D6, D9) / EXTERNAL-BLOCKED |

Capabilities asked for in SESSION-02, status: Claude adapter, provider abstraction, credential management, provider configuration, streaming, cancellation, tool calling, parallel tool calling, structured output, token accounting (re-verified, existing), budget enforcement, capability evidence, probe wrapper, audit logging → **already VERIFIED OFFLINE before this session; their suites are re-run green (see §5)**. Newly VERIFIED OFFLINE: retry policy, circuit breakers, health monitoring, approved fallback routing, model discovery, capability registry, context management, dynamic rate cards, currency-conversion interface, usage reporting. Blocked: provider administration **APIs/UI** for the new read models (DEPENDENT), OpenAI/Gemini adapters (OWNER-BLOCKED D11), anything live.

## 2. Completed work (commits on `feature/ai-providers`)
`1e3ee4d2` resilience primitives · `cca426c5` rate cards / FX / derivation · `795b9d8c` context fitting · `4f8a8455` capability registry + discovery · `d454a4b7` fallback policy · `414f0e6d` gateway wiring + insights service + integration tests · `f5d48154` migration 1900 + rate card history · `d35363f9` manifest patch (separate commit, Master-owned file) · `88e3db4f` CONTRACT-1/2/3 · `06895700` OpenAI/Gemini contracts + HTTP status mapping · `4b910f14` formatting + unit fake · `224fc159` S-AG4-RESILIENCE.md, anthropic.md update.

Design findings made by the tests (fixed before commit): (1) a circuit per **model** hammered a down provider once per model on every call → circuit is now per **provider** (health still per provider and per provider/model); (2) a half-open circuit's single trial was allowed a retry (one probe became two requests) → failures are now recorded per attempt and an opened circuit ends retries on that candidate; (3) `Date.parse('-5')` made a negative `Retry-After` look like a date → only HTTP-date-shaped strings are parsed.

## 3. Remaining / blocked tasks
| Task | Class | Needed from |
|---|---|---|
| HTTP routes (4 GETs + `discover_models`) and admin UI screens (health, registry, usage, rate-card history; AR+EN, states, E2E, screenshot) | DEPENDENT | Master applies CONTRACT-1, regenerates SDK; i18n block; then Session 02 (or a continuation) adds controller + UI |
| Manifest rows for migration 1900 | DEPENDENT | Master (CONTRACT-2; patch already in commit `d35363f9`) |
| Wire `fitContext` into callers | DEPENDENT | Session 05 (agent loop / builder) decides trimming policy |
| Future-dated rate card activation | not built (needs gateway selection by time + approval flow) | owner decision |
| Cache/reasoning token classes | OWNER-BLOCKED | D6 extension, CONTRACT-3 |
| OpenAI / Gemini adapters | OWNER-BLOCKED | D11 (after Claude is verified), each with its own D1–D9 |
| Live probe / connection test / discovery / real key / rate card / residency approval | OWNER-BLOCKED / EXTERNAL-BLOCKED | D2, D3, D4, D5, D6, D9 |

## 4. Modified files
- `packages/adapters/model/src`: **new** `resilience.ts`, `ratecard.ts`, `context.ts`, `registry.ts`, `fallback.ts`, `provider-drafts.ts` (+ a `.spec.ts` each); **edited** `types.ts` (`ModelAdapterError.retryAfterMs`, optional `discoverModels`, `DiscoveredModel`), `anthropic.ts` (Retry-After on 429/5xx, `discoverModels`, optional `models.list` on the client type), `anthropic.spec.ts`, `index.ts`.
- `apps/api/src/modules/ai`: **new** `internal/provider-insights.service.ts`, `provider-insights.int.spec.ts`, `resilience.int.spec.ts`, `rate-card-history.int.spec.ts`; **edited** `internal/gateway.service.ts` (retry/breaker/health/fallback wiring, `providerHealth()`, capability resolution via the shared function), `internal/provider.service.ts` (rate card history), `internal/model.ts` + `ai-config.spec.ts` (config), `internal/provider-credential.spec.ts` (fake), `ai.module.ts` (registers `ProviderInsightsService`), `index.ts`, `testing/ai-harness.ts` (deterministic env for the shared suites; ROPA processor codes for my mock providers).
- `docs/adapters/openai.md`, `gemini.md`, `anthropic.md`; `docs/ai-intelligence/S-AG4-RESILIENCE.md`; this report; `CONTRACT-1/2/3`.
- **Outside my ownership row (flagged for the Master):** `packages/db/migrations/ai/1900__…(.down).sql` (allowed: my migration range) and `spec/db/ownership.yaml` (**Master-owned**; kept in its own commit `d35363f9` so it can be kept, re-keyed or reverted; without equivalent rows the migration fails validation).

## 5. Migrations · contract-change requests · module registration
- Migration **1900** `ai.model_rate_card_versions` (+ `.down.sql`): expand-only, append-only, platform-scoped RLS, SELECT+INSERT grants. Reversal documented (drop; `configure` writes to it, so the code must be reverted with it).
- `CONTRACT-1` provider insights API (additive) · `CONTRACT-2` manifest rows for 1900 · `CONTRACT-3` contract 1.2 proposal (design note, not requested) · `CONTRACT-4` wording of the run-approval route after the DEFECT-6 fix.
- Module registration: **none needed from the Master**: `ProviderInsightsService` is registered inside `ai.module.ts` (my file). No `app.module.ts` change.

## 6. Tests run — commands and ACTUAL results (this worktree, 2026-11-24)
Environment: own Postgres `:54342`; `NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54342/postgres DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54342/nuzm_dev TEST_CONCURRENCY=2`.
| Command | Result |
|---|---|
| `cd packages/adapters/model && npx vitest run` | **11 files, 163 tests passed** (was 5 files / 105 before this session) |
| `cd packages/adapters/model && npx tsc -p tsconfig.json --noEmit` | clean |
| `cd apps/api && npx vitest run src/modules/ai` (unit) | **5 files, 33 tests passed** |
| `cd apps/api && npx tsc -p tsconfig.json --noEmit` filtered to `modules/ai` | clean (other modules' errors seen earlier were missing local package builds, resolved by the install + dist builds) |
| `npx eslint packages/adapters/model/src apps/api/src/modules/ai` · `npx prettier --check` on my files and docs | clean |
| `vitest run --config vitest.integration.config.mts src/modules/ai/resilience.int.spec.ts` | **15/15 passed** |
| `… provider-insights.int.spec.ts` | **10/10 passed** |
| `… rate-card-history.int.spec.ts` | **5/5 passed** |
| `… gateway.int.spec.ts` (existing, 40+ tests, run after the gateway rewiring) | **passed** (together with insights: 52 passed before my own test fixes) |
| `… capability-evidence.int.spec.ts`, `anthropic-adapter.int.spec.ts`, `injection.int.spec.ts` (existing) | **3 files, 100 tests passed** |
| `… runs.int.spec.ts` (existing) | **21/21 passed** |
| FINAL: whole `src/modules/ai` integration directory in one run after formatting (before the DEFECT-6 fix) | **8 files, 196 tests passed** |
| After the DEFECT-6 fix: `run-approval-actor.int.spec.ts` + `runs.int.spec.ts` | **2 files, 25 tests passed** |
| `pnpm db:migrate` on my cluster; `pnpm compliance:classification-coverage` / `residency-hooks` / `ropa-coverage` | 1900 applied; "3376 columns in 269 tables, all classified"; both others OK |
Not run (by rule, heavy): `pnpm verify*`, full integration, E2E, console builds, `spec:lint/drift` (no spec change was made by me beyond the ownership manifest rows).

## 7. Security findings and review of my own changes
- **S-1 (medium, design, open): a tenant can influence the shared circuit.** Provider health failures that are caused by a customer's request (an enormous prompt that times out, a request that provokes a 5xx) count toward the per-provider breaker, so one tenant could open the circuit for everyone for `AI_BREAKER_OPEN_MS`. Mitigations in place: only `timeout/unavailable/rate_limited` count; `invalid_request`, content filtering and cancels never count; threshold 5 and a 30 s open window; budgets and run caps already bound a tenant's volume. Options for the owner/Session 07: count only 5xx/connection errors (not caller-attributable timeouts), per-organization attribution, or a higher threshold. Not changed without a decision.
- **S-2 (low, info):** `Retry-After` comes from an untrusted peer: bounded by `AI_RETRY_MAX_MS` (a longer hint means fail over, not wait); the parser rejects junk, negatives and values beyond 9 digits; the wait is cancellable.
- **S-3 (low, info):** health and breaker state are per process (restart = closed, several instances do not share); `scope: "process"` is part of the contract so no operator mistakes it for a fleet view.
- **S-4 (info):** model discovery and the usage report never log or return a key; discovery is refused unless the provider is in `AI_LIVE_PROVIDERS`, never in production, and the adapter checks the gate again before reading the key; the result is explicitly not capability evidence and an undeclared model is never offered. The usage report is parameterised SQL (group/order built from fixed enums), platform-read scope, bounded range and rows. Reads are not audited (the existing admin list is not either): recommended to add when the route exists.
- Existing controls untouched: residency, data terms, attestation, two-person enable, vault-only keys, live gate, kill switch, budget reservations, audit, metering. The approved-fallback policy can only remove candidates, so it cannot weaken residency or budgets (tested).
- No secret, credential, key, screenshot or generated evidence file was committed (`git diff --name-only` reviewed). Test keys are generated at run time with a `test-only-` prefix.

- **DEFECT-6 (Session 07, medium) FIXED in my area:** `POST /v1/ai/runs/{id}/approvals` accepted any `ai:write` holder, including an API key. The handler now requires a session actor and `ai:approve` (403 otherwise); the false "hash must still match" comment in `run.service.ts` is corrected. Tests: `run-approval-actor.int.spec.ts`. Spec wording: `CONTRACT-4`. DEFECT-4 (deploy, Session 06) shares the root cause. **DEFECT-2** (`packages/domain/src/ai/ssrf.ts`) is outside every session row: not touched, Master to assign.

## 8. Integration requirements for the Master
1. Apply CONTRACT-2 (or keep commit `d35363f9`) **before or with** this branch, otherwise migration validation fails for everyone (`ordinal 1900 outside ranges allowed for ai`) and `ModelProviderService.configure` needs the table.
2. Apply CONTRACT-1 (spec + SDK), tell Session 02 whether `discover_models` returns a new schema or an envelope field, and provide the i18n block convention; then the controller lines and the admin screens follow.
3. `AI_BREAKER_THRESHOLD`/`AI_RETRY_BASE_MS` are set to deterministic values by `testing/ai-harness.ts` for all AI integration suites that use it (other sessions' AI suites that use the harness inherit this: intended).
4. Local setup note: this worktree's per-package `node_modules` links were incomplete (several adapter packages had none); one `pnpm install --frozen-lockfile --offline` fixed it (do not hand-link a package: pnpm then moved the SDK folder aside and I had to restore it). The API integration harness also needs the dependency packages built once (`pnpm --filter '@nuzm/api^...' build`, git-ignored output).

## 9. Delivery completion · readiness
- Gap closure: 10 of 12 gaps closed offline (G1–G10), G11 documented/owner-blocked, G12 dependent. Share of SESSION-02's READY/MOCKABLE items done: **all READY/MOCKABLE items that do not depend on a Master-owned contract are done**; the two DEPENDENT items (API exposure, admin UI) are specified and queued.
- Estimated S-AG4 completion: Claude-path engineering ≈ 70% (from ≈ 22% at the baseline by the Master's measure); the remaining ~30% is the human-gated live part (D2–D6, D9 evidence), exposure/UI and OpenAI/Gemini (D11). This is an estimate, not a measurement.
- Readiness: ready to merge into `integration/ai-engine` after CONTRACT-2 is accepted (see §8.1). Nothing live is enabled; every new behaviour is inert for a real provider until the owner opens the existing gates.

## 10. Next available tasks · heavy-run requests · escalations · new owner decisions
- Next (after the Master accepts CONTRACT-1): controller lines + admin screens (`apps/admin/components/AiProvidersPanel.tsx`, new `ai-providers-*` files), contract tests, unit/component tests, E2E + screenshot (heavy-slot request below). Also: audit event for usage-report reads; optional per-org attribution for S-1.
- Heavy-run requests (for the Master, on the integration branch after merging): (a) `pnpm verify` (lint, typecheck, unit, spec lint/drift, sdk check, secret scan); (b) the API integration directory `src/modules/ai` plus `src/modules/billing`/`compliance` regression (the gateway and the provider service changed); (c) migration up/down/up of 1900 on a scratch database; (d) after the UI exists: the AI admin E2E.
- Escalations: **none blocking.** Material decisions recorded below.
- New owner decisions found (append to `OWNER-DECISIONS.md`): **BRK** retry/breaker defaults and whether customer-attributable timeouts may open the shared circuit (S-1) — recommend tune after the first real provider is verified; **FBK** approved fallback pairs once ≥ 2 real providers exist (recommend `approved_only`, pairs only between providers with equivalent attested data terms and residency); **HLT** shared health store for several API instances (ops decision; Redis not installed locally); **FX** which exchange-rate source and who approves fixed rates (finance; part of D6); **RCV** whether rate cards may be future-dated (needs an approval flow); **TOK** pricing of cache/reasoning tokens (D6 extension, CONTRACT-3).
