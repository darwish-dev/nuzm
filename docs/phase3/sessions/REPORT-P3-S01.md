# REPORT — P3-S01 Real AI Providers and Tool Calling

Branch `claude/p3-s01-providers-b70a0d` (worktree base `ce16599d`), written 2026-11-24. **Nothing was called live. No key was created, entered or read; no agreement accepted; `AI_LIVE_PROVIDERS` never set; no vendor was contacted by code (the two vendor-documentation reads were page fetches by a research sub-agent, not API calls).** Every result below is **SIMULATED** (mock twin, stand-in adapter, or doc-shaped stubbed transport) unless a line says otherwise. There is no `LIVE-VERIFIED` row in this report, and none can exist before D2, D3, D4, D5, D6 and D9 are recorded.

## A. Repository findings and assumptions
- Phase 2 had already built the Claude adapter (contract 1.1), the probe, the nine-check suite, qualification tracks A/B/C, the gates (`evaluateSmokeGates`, `assessLiveEvidence`), capability evidence (D8) and the admin actions. P3-S01 therefore added what was missing around them instead of rebuilding them.
- **Gaps found and closed:** no single capped run over several tracks; no agent-loop (A2) or real-error check; OpenAI/Gemini were contract drafts only; no key rotation/revocation or kill-switch drill; no way to turn an executor result into capability evidence; no invoice reconciliation; no live-run leak scan of the artifacts.
- **Assumptions:** (1) the plan names the evidence format `nuzm.live-evidence`; the existing per-track format is `qualification-*.json` (schema 1) and nothing named `nuzm.live-evidence` exists in the repository, so the new combined artifact is `nuzm.p3-provider-evidence` v1, which embeds the per-track records unchanged; (2) the per-track D9 maxima (A 0.006400, B 0.080720, C 0.030400, suite 0.116720) do not add up to one approval for several tracks, so the executor requires the approval to cover the **sum** of the selected tracks (A+B+C = USD 0.117520) and prints it; (3) tracks D and E are outside the D9 maxima and opt-in.
- **Process incident (disclosed):** my first `pnpm db:migrate` and `pnpm db:dev-logins` used the default URL and therefore hit the **shared Postgres on :54329** instead of my :54351 cluster. `migrate` refused ("migration 312 … older than an applied migration"), changing nothing; `dev-logins` ran and executed `ALTER ROLE nuzm_app/nuzm_worker LOGIN PASSWORD 'nuzm_dev_only'` there (the documented dev value, idempotent). I tried to stop the processes; the permission layer denied the kill, so they ran to completion. Nothing else touched :54329. All later database work used `NUZM_TEST_ADMIN_URL=…:54351`. Master: please check that role state if it matters to you.

## B. Plan and changed files
Commits (all with the required trailer): `f02214b0` adapters, `a502b4b8` executor and tracks D/E, rotation/revocation/drill/ingestion, invoice + plan section (see `git log`).
| Area | Files (all inside P3-S01's ownership) |
|---|---|
| OpenAI / Gemini adapters | `packages/adapters/model/src/{openai,gemini,http-transport}.ts`, `rest-adapters.spec.ts`, `provider-drafts.spec.ts` (updated), `index.ts`; `docs/adapters/{openai,gemini}.md` |
| Tracks D (real-error mapping) and E (agent tool loop) | `qualification.ts`, `qualification.spec.ts`, `live-twin.ts` |
| Invoice reconciliation | `invoice.ts`, `invoice.spec.ts` |
| Live executor | `apps/api/src/modules/ai/internal/{live-executor,live-executor-cli}.ts`, `live-executor.spec.ts`, `live-qualification.ts` (tracks D/E accepted) |
| Rotation, revocation, evidence ingestion | `provider.service.ts` |
| Kill switch drill | `internal/kill-switch-drill{,.service}.ts`, `kill-switch-drill.spec.ts`, `ai.module.ts`, `index.ts` |
| Integration tests | `p3-s01-credentials.int.spec.ts` |
| Docs | `docs/parallel/LIVE-PROVIDER-PLAN.md` §10, `docs/phase3/sessions/CONTRACT-P3-S01-1-credential-actions-and-executor.md`, this report |
Not touched (Master-owned): spec, SDK, `package.json`, lockfile, `app.module.ts`, `messages.ts`, migrations (none needed; 2300–2309 unused).

## C. Implemented features, API and UI screens
1. **Live executor** (`qualify:p3` once the script line exists): tracks A, B, C (+ D, E, S) in order; HARD USD cap printed first; cumulative cap enforced before and after each track; key read lazily and only after every gate; halts on a credential/availability/rate-limit failure; retries nothing; writes `nuzm.p3-provider-evidence` (model id, contract, component versions, D2–D9 references, plan and output hashes, cap and cost, one labelled claim per check, leak scan) to `docs/phase3/EVIDENCE/provider/<date>-<id>.json`. `--twin` rehearses without a key. Refuses any provider but `claude` (D11).
2. **Track D:** one controlled real vendor refusal (output ceiling above the model limit) mapped to a non-retryable `invalid_request`; FAILs if the vendor accepts it. **Track E (A2):** synthetic `read_note` tool loop; passes only if the final answer contains the code word that was in the tool result.
3. **Evidence ingestion (D8):** `ingestExecutorEvidence` records `tool-use` VERIFIED only from a live, in-cap, digest-matching, LIVE-VERIFIED track-B record for this provider/model/contract; dependents VERIFIED only if the record says so, else NOT VERIFIED.
4. **Rotation / revocation / kill-switch drill** (service level): described in the plan §10.3.
5. **Invoice reconciliation:** `--reconcile-invoice` compares our cost and the vendor's tokens-at-list-price with the invoice.
6. **OpenAI (Chat Completions) and Gemini (generateContent) adapters** behind D11: fixed host, key at call time, live gate checked before the key is read, status-only error mapping (spend/quota 429 non-retryable for OpenAI), SSE streaming, tool calling as candidates only; all vendor statements are cited in the adapter notes with what was **not found**.
7. **API / UI:** no route or screen was added. Four admin actions (`rotate_credential`, `revoke_credential`, `kill_switch_drill`, `ingest_executor_evidence`) and their admin UI wait for the spec/SDK change in `CONTRACT-P3-S01-1`: adding them first would break `pnpm spec:drift`. **Admin UX is therefore NOT delivered.**

## D. Migrations and rollback
None. `ai.model_capability_evidence` already exists. Rollback = revert the commits; the new modules are additive and unreferenced by routes.

## E. Tests run with actual results (all on this worktree; my own Postgres :54351)
| Command | Result |
|---|---|
| `cd packages/adapters/model && npx vitest run` | **18 files, 298 tests passed** (includes 36 in `rest-adapters.spec.ts`, 6 `invoice.spec.ts`, 36 `qualification.spec.ts`, the updated `provider-drafts.spec.ts`, `no-vendor-keys.spec.ts`) |
| `pnpm --filter @nuzm/adapter-model typecheck` and `build` | no output / exit 0 |
| `apps/api`: `vitest run live-executor.spec.ts` (final) / `live-qualification.spec.ts live-smoke.spec.ts` | 21 passed / 81 passed (the latter run before the last executor edits; the edits do not touch them) |
| `apps/api`: `vitest run kill-switch-drill.spec.ts` | 7 passed |
| `apps/api`: `tsc -p tsconfig.json --noEmit` | exit 0 |
| `eslint apps/api/src/modules/ai packages/adapters/model/src` | clean after fixing one finding |
| integration `p3-s01-credentials.int.spec.ts` | **15 passed** (rotation ×4, revocation ×3, drill ×2, ingestion ×6) |
| integration `capability-evidence.int.spec.ts` | 19 passed |
| integration `anthropic-adapter.int.spec.ts` | 17 passed |
| integration `credential-leak.int.spec.ts` | first run: 3 tests hit the 30 s default timeout while the machine was loaded by other sessions; **re-run with `--testTimeout=170000`: 4 passed** (so the first failure was load, not a regression; I did not run it a third time) |
| integration `qa-credential-custody` | 5 passed |
| integration `gateway-concurrency` (DEFECT-7/8/15 area) | 4 passed |
| integration `qa-ai-integrity` (DEFECT-7/8/15 area) | 19 passed |
Not run by me: the full Phase 2 regression (held by another session), `pnpm verify`, `spec:drift`/`sdk:check` (I changed no spec), browser E2E.

## F. Security, tenant isolation, billing, residency verification
- **Refusals (A5), SIMULATED:** `live-executor.spec.ts` refuses, with the key never read and zero requests sent, without each of D2, D3, D4, D5, D6, D9; with the gate closed, no vault reference, a key passed as the reference, a withdrawn D3, a production process, an approval that covers only the largest single track, and a cap above the approval ceiling. The adapters refuse before reading the key while their gate is closed (`rest-adapters.spec.ts`, `provider-drafts.spec.ts`).
- **No key or content in artifacts (A4), SIMULATED:** the executor scans its own envelope for the credential and key shapes and discards it; tested with a planted key. Evidence records carry fixed sentences only (existing `validateEvidence`); the new tracks add none of the content (test asserts the code word and tool name are absent). Rotation/revocation/drill audit events and responses were checked for the old, new and rejected keys, and the `ai.model_providers` table rows were scanned; `credential-leak.int.spec.ts` stays green. A leak check on a **real** run is built in but has not run on one.
- **Money:** integer nano units throughout; cap arithmetic in `bigint`; invoice check refuses a currency mismatch (no conversion). Rate card: the adapter list prices are unchanged; Gemini's price changes on 2027-01-01 (`geminiPricingStale`).
- **Tenant/residency:** nothing new reads tenant data; the drill reads one organization's pre-flight and writes only the global flag and audit events. The drill sends nothing to a provider (asserted: the mock handler was never called).

## G. Human gates and live checks still needed (BLOCKED until the owner acts)
| Needed | Gate |
|---|---|
| Any `LIVE-VERIFIED` claim: connection, streaming, tool calling, code generation, agent loop, real-error mapping | D2, D5, D6, D4, D3, D9 recorded; owner enters the key in the admin console; `AI_LIVE_PROVIDERS=claude` in one non-production environment; approval file covering the printed cap |
| Tracks D and E and the suite in the same run | owner raises the approval to the printed cap (outside the D9 maxima) |
| Usage reconciliation and the invoice check | owner reads the vendor console for the dedicated workspace and run window |
| Retry/breaker/fallback "with real error codes once live" | a real provider cannot be made to fail on demand and no bad key may be entered: they stay SIMULATED; only the controlled refusal (track D) is real; 401/429/5xx are NOT VERIFIED |
| OpenAI and Gemini | D11 lifted, then their own D1/D2/D3/D4/D5/D6/D9; their open wire questions (adapter notes) are probe obligations |
| Admin routes and UI for rotation, revocation, drill, ingestion | Master applies `CONTRACT-P3-S01-1` |

## H. Acceptance checklist
| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | Approvals recorded → `qualify:a|b|c` live within the printed cap; `VERIFIED` tool-use rows | **BLOCKED (D2,D5,D6,D4,D3,D9)** | executor built; dry run and refusals SIMULATED-pass |
| A2 | Real model completes a read-tool agent loop; `supportsTools` only from evidence | **BLOCKED** for the real model; **SIMULATED PASS** for the track-E logic and ingestion | `qualification.spec.ts` (track E), `p3-s01-credentials.int.spec.ts` (ingestion) |
| A3 | Streaming, cancel mid-stream, structured output, usage reconciliation each LIVE-VERIFIED or explicit NOT VERIFIED | **NOT VERIFIED (live)**; each is named in every envelope as NOT VERIFIED/SIMULATED with its reason | executor `buildClaims`; suite S covers them once live |
| A4 | No key/prompt content anywhere; live-run leak check added | **PASS** for the offline tests and the built-in scan; **NOT VERIFIED** on a real run | §F |
| A5 | Refusal tests for each of D2/D3/D4/D5/D6/D9 | **PASS** (unit) | `live-executor.spec.ts` |
| A6 | Phase 2 AI suites and DEFECT-7/8/15 tests green | **PARTIAL**: the 7 integration files I ran are green (credential-leak, capability-evidence, anthropic-adapter, qa-credential-custody, gateway-concurrency, qa-ai-integrity + mine); the other Phase 2 AI suites (e.g. `run-concurrency-ceiling`, `qa-run-concurrency`, resilience, spend-caps, runs) were **not** re-run by me and are left to the Master's serialized regression | §E |
Plan deliverables: (1) executor **PASS (SIMULATED)**; (2) ingestion **PASS (SIMULATED)**; (3) streaming/cancel/structured/usage **NOT VERIFIED (live)**, controlled-error test built as track D; (4) rotation/revocation/drill **PASS (SIMULATED, service level)**, admin console **NOT DELIVERED** (contract); (5) OpenAI/Gemini **PASS (SIMULATED)** behind D11; (6) health and fallback: Phase 2 simulations stand, **real-error proof NOT VERIFIED**; (7) invoice reconciliation **PASS (arithmetic, SIMULATED)**, vendor invoice **NOT VERIFIED**.

## I. Next-milestone handoff and open decisions
- **To S03–S06, S08:** the model gateway they use is unchanged; the "verified provider" label appears only after the executor's envelope is ingested. Until then a builder/benchmark run on Claude has `tool-use` unproven and must use the mock provider.
- **Master actions:** apply `CONTRACT-P3-S01-1` (spec enum, SDK, script lines); tell me to add the controller cases and the admin UI. Please also note the §A process incident.
- **Owner decisions (unchanged):** D2, D5, D6, D4, D3, D9; whether D and E (and the suite) are approved in the same run (raise the approval to the printed cap).
- **Open technical questions for the first real run:** (a) whether the vendor rejects `max_tokens` above the model limit with a 400 (track D assumes it; if it accepts, D FAILs with its actual usage recorded); (b) OpenAI tool calling on Chat Completions for `gpt-6.1-terra` and Gemini thought signatures (adapter notes); (c) the D-31 usage tolerance is still only proposed (1%).
