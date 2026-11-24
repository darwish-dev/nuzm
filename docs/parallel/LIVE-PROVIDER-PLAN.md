# LIVE-PROVIDER-PLAN — taking Claude from "offline-verified" to "LIVE-VERIFIED"

Author: Session 02 (providers) · Date: 2026-11-24 · Status: **PLAN. Nothing in it has been executed: no live call, no real key, no agreement accepted, no gate opened.** Companion documents: `docs/ai-intelligence/S-AG4-PRICING.md` §5 (cost), `S-AG4-SPEND-CAPS.md` (caps), `S-AG4-PROBE-PLAN.md`, `docs/parallel/sessions/PHASE2-02-approval-inputs.md` (the owner's questions).

## 0. Stance
- **Provider:** Claude only (the provider selected by the owner). OpenAI and Gemini stay contracts and fixtures (`docs/adapters/openai.md`, `gemini.md`; D11): no adapter, no live step.
- **Authentication:** only the vendor's **official, documented API-key authentication** (`Authorization: Bearer <key>` from a key created in the vendor Console, in a dedicated workspace). **No credentials from a consumer subscription (Claude.ai Pro / Max or any chat-product login) and no unofficial mechanism** (session cookies, scraped tokens, reverse-engineered endpoints) are ever used or accepted. The vendor's pages read on 2026-11-24 list three documented authentication methods (API key, workload identity federation, app attestation); only the API key is implemented. Whether the vendor's *terms* address consumer credentials was **not** read here (terms are on another host); counsel covers it under D2.
- **Labels:** every claim carries `LIVE-VERIFIED` (a real provider answered, in a run that passed every gate, with an evidence file), `SIMULATED` (mock twin, or faults injected on our side), or `NOT VERIFIED`. A mock never turns a BLOCKED row into PASS (CLAUDE.md §6).
- **Who does what:** the owner performs every act that is theirs (accepting terms, creating the key, setting the vendor cap, recording decisions). The agent prepares, runs offline checks, and runs the live steps **only** after the evidence rows exist.

## 1. Sequence (each step: gate → action → evidence → rollback)
| Step | Gate (must already hold) | Action | Who | Evidence recorded | Rollback |
|---|---|---|---|---|---|
| L0 | none | Offline readiness (**done**): adapter 1.1 candidate, probe, live-verification suite and mock twin, smoke runner (dry-run default), spend caps, resilience, rate-card history, admin read models | agent | commit ids + test counts in `REPORT-02` | n/a |
| L1 | D2 decided | Review agreement and data terms; accept as a human; record the flags and reference; admin action `attest` | owner (+ counsel) | evidence row **D2** (reference) | `attest` can be superseded; provider stays disabled |
| L2 | D5 decided | Provider row region = what the contract says; ROPA entry for `claude`; residency position for D1 (public content only for the probe) | owner + counsel | evidence row **D5** | edit the row; residency policy refuses on `unspecified` |
| L3 | D6 decided | Set the customer rate card (credits per million tokens, versioned) via `configure`; check the history (`GET …/{id}/rate-card-versions`) | owner (+ finance) | evidence row **D6** + rate-card version id | publish a new version (history is append-only) |
| L4 | D4 decided | Vendor Console: dedicated workspace, dedicated key, **vendor monthly cap** (`S-AG4-SPEND-CAPS.md` §2); then **type the key into the Nuzm admin console** (`Save Claude key`); it is sealed in the non-production vault, only `vault://dev/ai-claude` is stored/shown | owner | evidence row **D4** (workspace name, cap, key owner, rotation date; **no key**) | `Clear credential` + revoke the key in the Console |
| L5 | D3 decided; L1–L4 done | Open the live gate in ONE named non-production environment: `AI_LIVE_PROVIDERS=claude`; the provider is enabled by two people (`request_enable`, `enable`) | owner + two admins | evidence row **D3** (environment, date) | unset `AI_LIVE_PROVIDERS` (closes every live path immediately); kill switch |
| L6 | L5 | **Connection test** (`connection-test` action): lists the key's models; no prompt, nothing billed; confirms the key and the host | agent (admin action) | audit event + result `ok` (L6 evidence note) | clear credential |
| L7 | L6 | **Model discovery** (`POST …/model-discovery`): reconcile the vendor's listing with the adapter's declared model; read-only; **not** capability evidence | agent | audit `ai.provider.models_discovered` + the reconciliation | none needed |
| L8 | D9 decided; L1–L7 | Record the run approval: `AI_PROBE_APPROVALS` entry in that environment, the approval file (caps for requests, tokens **and money**), the evidence file (D2–D6, D9 rows). Run the smoke runner as a **dry run** and read the plan and worst-case cost together with the owner | owner + agent | evidence row **D9**; the dry-run plan printed | remove the approval entry |
| L9 | L8 | **Execute once**: `live-smoke-cli … --execute`. The runner re-checks every gate **before** reading the key, runs the nine-check suite (≤ 13 requests, ≤ 14,716 tokens, ≤ USD 0.116720), writes a report to an operator-chosen file **outside the repository** | agent | the report file (kept by the owner), summary in `REPORT-02` | stop the process; kill switch; revoke the key |
| L10 | L9 | **Reconcile usage**: the owner reads the vendor Console's usage for the dedicated workspace and the run's window and saves the figure; `live-smoke-cli --reconcile report.json --vendor-usage usage.json`. Without it, `usage_reconciliation` stays NOT VERIFIED | owner + agent | reconciled report | n/a |
| L11 | L9 passed | **Record capability evidence** (D8): run the console action `probe_tool_use` once (≤ 8 requests, ≤ USD 0.080720); it writes one evidence row per capability (`VERIFIED` only when the whole rule held). Only then does the router offer tools on Claude | agent (admin action) | `model_capability_evidence` rows (probe reference) | a failed or partial probe records `NOT VERIFIED`; nothing is retried |
| L12 | L10, L11 | Close: AC-AG-09 recorded with the evidence links; `LIVE-VERIFIED` claimed **only** for the checks below (§5); the gate is closed again unless the owner decides otherwise | agent + owner | `REPORT-02` Phase 2 + evidence index | unset the gate; rotate the key |
Stop rules at every live step: a credential, availability, timeout, refusal or rate-limit failure **stops the run at once** (nothing is retried); a cap reached stops it before the next request; `Ctrl-C`/abort cancels the request in flight.

## 2. Gates, in one place (a live request needs ALL of them; each is enforced in code and unit-tested)
| Gate | Enforced by | Refusal tested in |
|---|---|---|
| Provider is `claude` (D11) | `evaluateSmokeGates` | `live-smoke.spec.ts` |
| Not a production process (D-12) | adapter-package and runner | `live-evidence.spec.ts`, `live-verification.spec.ts`, `live-smoke.spec.ts` |
| `AI_LIVE_PROVIDERS` lists the provider (D3) | runner, `assertLiveSuiteAllowed`, the adapter itself (checks again before the key is read) | same + `anthropic-adapter.int.spec.ts` |
| `AI_PROBE_APPROVALS` entry with the same reference; file caps ≤ the entry (D9) | runner | `live-smoke.spec.ts` |
| Approval covers the worst case in requests, tokens **and money** | runner, suite | `live-verification.spec.ts`, `live-smoke.spec.ts` |
| Evidence rows D2, D3, D4, D5, D6, D9 standing for provider `claude`, non-production, not withdrawn, no placeholders, no credential-shaped text | `assessLiveEvidence` | `live-evidence.spec.ts` |
| Credential is a `vault://dev/ai-…` reference, never a key | runner | `live-smoke.spec.ts` |
| `--execute` given (default is a dry run) | runner | `live-smoke.spec.ts` |
| Kill switch off, wallet funded, budgets | gateway (for console actions) | `gateway.int.spec.ts`, `spend-caps.int.spec.ts` |

## 3. Evidence files (kept by the owner, **outside the repository**; never committed, never pasted into chat)
| File | Content | Written by | Used by |
|---|---|---|---|
| `evidence.json` | list of `{decision: D2|D3|D4|D5|D6|D9, ref, recordedBy, recordedAt (ISO), provider: "claude", environment: "non-production", outcome: approved|withdrawn}`; a later `withdrawn` row revokes | the owner (or the Master on the owner's word) | `live-smoke-cli` (every gate) |
| `approval.json` | `{ref, approvedBy, environment, maxRequests, maxTotalTokens, maxCostNano}`; **must equal an `AI_PROBE_APPROVALS` entry's reference and not exceed it** | the owner | `live-smoke-cli` |
| `usage.json` | `{inputTokens, outputTokens, source}` read from the vendor Console for the workspace and window | the owner | `--reconcile` (and `--vendor-usage`) |
| `report.json` | the suite report: per check `ok / ran / evidence (live \| simulated \| none) / fixed-sentence detail`, request and token totals, cost in nano-USD, `usage` ledger | `live-smoke-cli` (file mode 0600) | `--reconcile`, `REPORT-02` summary |
Repository records (committed, no secrets): the commit ids, the checks' pass/fail summary, and the evidence **references** (not the files). A report is never committed: it names no key and no content, but it is generated evidence.

## 4. Rollback and emergency stops (fastest first)
1. **Kill switch** (admin action) — every model call refused at once.
2. **Unset `AI_LIVE_PROVIDERS`** and restart the process — every live path refuses before the key is read.
3. **Clear the credential** in the admin console and **revoke the key** in the vendor Console — the key is dead on both sides.
4. **Lower or remove the vendor-side cap** is *not* a rollback; lowering it is a further brake (`S-AG4-SPEND-CAPS.md`).
5. Withdraw an evidence row (`outcome: withdrawn`) — the runner refuses to start again.
Data: a live run sends only the suite's constant prompts (public content). Nothing of a customer is sent (D1 not needed). The report holds no provider text.

## 5. What `LIVE-VERIFIED` will require, per claim
A claim is `LIVE-VERIFIED` only when **(a)** the run passed every gate, **(b)** the check ran against the real adapter with `evidence: live` in a saved report, and **(c)** its evidence reference is recorded.
| Claim | Instrument | Live evidence | Stays SIMULATED even in a live run |
|---|---|---|---|
| The key and host are valid; the declared model is visible to the key | L6 connection test, L7 discovery | audit events | — |
| Streaming works (text, stop, usage on the final chunk) | suite `streaming` | `live` | — |
| Structured (JSON) output works | suite `structured_output` | `live` | — |
| Cancelling mid-stream stops the stream | suite `cancel_mid_stream` (or the probe's step 8) | `live` | — |
| Tool calling (single, forced, parallel, streamed, round trip, none, truncated) | the probe (suite `tool_calling`, and L11 for the evidence table) | `live`; **capability declared only from the L11 `VERIFIED` rows** (D8) | — |
| Our token accounting matches the vendor's | L10 reconciliation | `live` **only** with the vendor figure | the check is NOT VERIFIED until the figure exists |
| Health monitor arithmetic | suite `health` | `live` (fed by real requests) | — |
| **Retry and circuit breaker** | suite `retry_and_breaker` | **never live**: faults are injected on our side because a real provider cannot be made to fail on demand | **always `simulated`** |
| **Approved fallback routing** | suite `fallback_routing` | **never live**: needs a second approved provider and an injected failure | **always `simulated`** (with one provider only the refusal path runs) |
| The vendor's spending-limit answers are mapped as documented | `anthropic.spec.ts` (stubbed shapes) | **never exercised live** (exceeding a real cap is not a test we run) | **NOT VERIFIED** against the real service |
Not claimable from this plan, ever: model **quality** (S-AG5 benchmarks), customer-content residency (D1), production readiness (D-42), security review (a named reviewer).

## 6. Cost table (list prices read 2026-11-24; arithmetic in `S-AG4-PRICING.md` §5; **not a quote**)
| Step | Requests (max) | Tokens (max) | Hard maximum at $4 / $20 per MTok |
|---|---|---|---|
| L6 connection test, L7 discovery | 0 billed (model listing) | 0 | USD 0 |
| L9 nine-check suite (includes the whole probe) | 13 | 14,716 | **USD 0.116720** (ceiling if all tokens priced as output: 0.294320) |
| L11 `probe_tool_use` (writes the evidence rows) | 8 | 11,716 | **USD 0.080720** (ceiling 0.234320) |
| **All live steps together** | **21** | **26,432** | **USD 0.197440** |
| Vendor cap recommended for the dedicated workspace | — | — | USD 5 / month (owner's decision, D4) |
Retries are not counted because none occur (adapter `maxRetries: 0`; the harness never repeats a request). If L9 is skipped (the probe alone suffices for the evidence table), the total is USD 0.080720.

## 7. After LIVE-VERIFIED
Closing the gate again is the default. Re-run the suite (a) on any adapter change, (b) when the vendor changes the model or prices (re-read the pages quarterly and before every run), (c) after a key rotation. A model or adapter change invalidates the evidence rows (they carry the adapter contract version).

## 8. Exact commands (operator; nothing here is run by CI)
```bash
# dry run: evaluates every gate, prints the plan and the worst-case cost, sends nothing, reads no key
pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/live-smoke-cli.ts --vault-ref vault://dev/ai-claude --approval ~/nuzm-live/approval.json --evidence ~/nuzm-live/evidence.json
```
```bash
# the run itself (adds --execute; every gate is checked again before the key is read)
pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/live-smoke-cli.ts --vault-ref vault://dev/ai-claude --approval ~/nuzm-live/approval.json --evidence ~/nuzm-live/evidence.json --report ~/nuzm-live/report.json --execute
```
```bash
# later, with the vendor's figure from the Console: arithmetic only, no key, no request
pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/live-smoke-cli.ts --reconcile ~/nuzm-live/report.json --vendor-usage ~/nuzm-live/usage.json --report ~/nuzm-live/report-reconciled.json
```
The environment of the process needs `SESSION_SEAL_KEY` (reads the sealed dev vault), `AI_LIVE_PROVIDERS=claude` and the `AI_PROBE_APPROVALS` entry. Exit codes: 0 all passed, 1 a check failed or was not verified, 2 refused (nothing sent), 3 unexpected failure.
