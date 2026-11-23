# Agentic Coding Engine — S-AG4 preparation report (Anthropic Claude as the proposed first provider)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this work `911ba99`; nothing merged or pushed) · Status: **PREPARED and VERIFIED OFFLINE. NO live provider request was made, and none is possible in this build: the live-egress gate is closed by default.** Claude is the proposed first provider; D-18 and HG-09-01 are OPEN; model quality, the live API behaviour of the tool mapping, data terms and residency are **NOT VERIFIED**. Production and executable tools are untouched and stay off.
Governing documents: ADR-066, SCR-K-10, SCR-K-11 (new), `docs/ai-intelligence/S-AG4-PREP.md` (new, the decision list), `docs/runbooks/anthropic-live-enablement.md` (new).

## A. Repository findings and assumptions
- Much of the credential path already existed: provider rows with human attestation and the two-person enable rule, a sealed non-production secret store, a one-field "save Claude key" action, an adapter registered only outside production, and a **live** admin connection test (a model listing) that called the vendor whenever a key was stored. This preparation reviewed them, added the missing gate and tests, and documented them rather than duplicating them.
- The Anthropic adapter was on contract 1.0 with no tool capability (a test pinned that "until probed in S-AG4").
- **Assumption:** the wire mapping for tools follows the vendor's Messages API documentation as I know it; it was **not** checked against the live service or re-read online in this session (no network call was allowed). `docs/adapters/anthropic.md` says to re-read the documentation before relying on it.
- **Finding fixed (cancellation):** a call whose caller signal was already aborted never fired its abort event in the gateway, so the provider call still went out. Fixed in `gateway.service.ts` with a regression test. This applies to every provider, not only Claude.
- **Behaviour change you should know about:** the admin connection test for Claude is now refused (422 `unsupported_capability`) before the key is read until the owner lists `claude` in `AI_LIVE_PROVIDERS`. It is a request to the vendor with the key, so I treated it as a live request (decision D3).

## B. Plan and changed files
- **Adapter:** `packages/adapters/model/src/anthropic.ts` (contract 1.1 as an opt-in; live gate), `anthropic-v11.spec.ts` (new, 17 tests).
- **API:** `ai/internal/model.ts` (`liveProviders`, `claudeContract`), `ai/ai.module.ts` (wiring), `ai/internal/provider.service.ts` (connection test gated), `ai/internal/gateway.service.ts` (pre-aborted signal), specs `ai/anthropic-adapter.int.spec.ts` (new, 17), `ai/internal/ai-config.spec.ts` (new, 4), `ai/internal/provider-credential.spec.ts` (updated, +1).
- **Spec/SDK:** one description sentence on `testAiModelProviderConnection` in `spec/openapi/openapi.yaml`; SDK regenerated (descriptions only).
- **Docs:** `docs/ai-intelligence/S-AG4-PREP.md`, `docs/spec-change-requests/SCR-K-11-claude-contract-1-1-public-surface.md`, `docs/runbooks/anthropic-live-enablement.md`, updates to `docs/adapters/anthropic.md` and `docs/09 §7`, this report.
- Not touched: migrations, UI, the loop, production wiring, OpenAI/Gemini.

## C. Implemented
1. **HG-09-01 and D-18 documented** (`S-AG4-PREP.md` §1–2): the evidence package the owner must assemble (nine questions answered from the contract only), what the code does with the answer, the three D-18 options as they bind the residency service, and a gate table G1–G12 mapping every control to its code and test. No vendor term is asserted.
2. **Credential vault (non-production), reviewed and hardened:** keys are sealed, only references are stored and shown, replaced keys are picked up on the next call, removal deletes the key, production cannot store one. New test: a key saved through the admin API is searched for in **every row of every table** (none) and in every answer; the production profile refuses to store a key.
3. **Live gate (G9):** `AI_LIVE_PROVIDERS` (default empty, ignored in production). Closed: the adapter refuses before reading the key or building a client; the connection test is refused; through the gateway the caller gets 503, no upstream call, no charge, nothing reserved.
4. **Anthropic adapter at contract 1.1** (opt-in `contract: '1.1'`, `AI_CLAUDE_CONTRACT=1.1`; default 1.0 and unchanged): tools and tool choice, `tool_use`/`tool_result` mapping, parallel calls, streamed tool calls, cancellation (including a consumer that stops reading), history validation before a billed call, the tool-free forced turn sent as text, rejection of cut-off or paused answers, fixed-sentence errors.
5. **OpenAPI changes and compatibility documented** (SCR-K-11); one description-only edit applied.
6. **Decisions for you:** `S-AG4-PREP.md` §8 (D1–D12).

## D. Migrations and rollback
None. (SCR-K-11 item 3 proposes `ai.model_capability_evidence` as an expand-only migration after your approval.)

## E. Tests run with actual results
| Command / suite | Result |
|---|---|
| `@nuzm/adapter-model` tests | **64 passed** (47 before; +17: conformance with scenario driver, request shapes against the real SDK on a stubbed `fetch`, a recorded-shape event stream, cancellation, live gate, errors) |
| `anthropic-adapter.int.spec.ts` (real gateway, scripted client, no network) | **17 passed**: tool calls and metering of provider-reported usage; tools reach the provider as declared; schema-violating arguments rejected, undeclared tool fails at no cost; a tool result is data and the secret scan covers it; tenant isolation; a call id charged once; run-budget and wallet limits refuse before any provider call; run cap; `max_tokens` ceiling; streaming equal to non-streaming and charged once; a dropped stream is not retried or charged; cancel aborts the request and releases the reservation; a pre-aborted signal never reaches the provider; live gate closed on the registered Claude adapter (a counting `fetch` is never called) and through the gateway; vault no-leak scan; production refuses a key |
| `ai-config.spec.ts` (4), `provider-credential.spec.ts` + `claude-probe.spec.ts` (19), API unit tests of the `ai` module | all pass |
| `pnpm test:integration` (whole workspace) | db 102, platform 32, worker 92 passed; **api 2107 passed, 1 failed, 2 skipped**; the one failure is the pre-existing `domains-search` registrar probe matrix (below) |
| `npx turbo run test --filter='!@nuzm/e2e'` | 49 of 52 tasks successful; domain 880, adapter-model 64, i18n 9, sdk 4 passed; the failure is `apps/admin` (below) |
| `pnpm lint`, `pnpm typecheck` | exit 0 |
| `pnpm spec:lint`, `pnpm spec:drift` (502/502), `pnpm sdk:check`, `pnpm compliance:claims-guard` | all OK |
| Browser E2E | **not re-run**: no UI or route changed |

**Unrelated failures, reported separately (none touches this work):**
1. `domains-search.int.spec.ts` registrar probe matrix: expects two registrars, a `dnet` registrar from another slice exists (recorded in earlier reports).
2. `pnpm scan:secrets`: one finding in `apps/api/src/modules/domains/internal/registrar-dnet-settings.spec.ts:9`.
3. `pnpm zatca:guard`: the generator sources differ from the pinned hash since commit `8e314fd`; no ZATCA file is changed here and the pin was not updated (an owner decision).
4. `apps/admin` tests under the parallel unit run: 4 timeouts (30 s) in `knowledge-upload.spec.ts` and `KnowledgeIngestion.spec.tsx` under load; **348/348 pass when the admin suite runs alone**.
5. `pnpm test` at the default ports cannot start the Playwright package here because an unrelated process holds port 4000.
6. `docs/reports/evidence/M12-tenant-sweep.json` is regenerated by test runs and left uncommitted.

## F. Security, tenant isolation, metering, cost limits, streaming, cancellation, tool calls
- **Tenant isolation:** usage rows, wallet and content stay per organization (tested with two organizations: neither sees the other's rows or text; an unfunded organization is refused before any provider call).
- **Metering:** the provider-reported tokens are recorded once per call id (`estimated: false`), no bodies stored, one upstream call (no hidden retry).
- **Cost limits:** run budgets (tokens and credits), the run cap and an empty wallet refuse before the provider is called; nothing stays reserved.
- **Streaming and cancellation:** deltas reach the caller as they arrive and equal the non-stream result; a failed stream is not repeated; cancel (mid-stream or before the call) aborts the request, releases the reservation and charges nothing.
- **Tool-call security:** only declared tools; arguments must be an object and pass the gateway's schema validation (violations are returned as rejected calls with reasons, never as calls); undeclared tools, duplicate ids, too many calls, cut-off or paused answers are errors; tool results travel as data blocks, never as instructions or system text; the outbound secret scan covers tool results; nothing is executed by the adapter or the gateway (no execution tool exists).
- **Secrets:** no key in code, rows, audit, answers or errors (tested); one fixed host; environment tokens and base URL ignored.

## G. Human gates and live checks still needed
Everything in `S-AG4-PREP.md` §8: D1 (D-18 option and customer-content use), D2 (HG-09-01 agreement and data terms), D3 (open the live gate, and whether the key-validating connection test may run first), D4 (who creates, stores and rotates the vendor key; a vendor-side spend cap), D5 (region statement and ROPA entry), D6 (rate card), D7 (OpenAPI delta, SCR-K-11), D8 (declare tools only from recorded probe evidence), D9 (the live probe: scope, cost cap, who runs it), D10 (confirm `AI_ALLOW_UNATTESTED_SENSITIVE=false` and production closed), D11 (OpenAI and Gemini timing), D12 (D-12, D-21, D-42, AC-AG-10, D-38 stay open).

## H. Acceptance checklist
| Item | Status | Evidence |
|---|---|---|
| 1 HG-09-01 and D-18 requirements reviewed and documented | PASS (documentation) | `S-AG4-PREP.md` §1–3 |
| 2 Non-production credential vault integration, no hardcoded secret | PASS (offline) | vault tests; no live key was used |
| 3 Anthropic ModelAdapter v1.1 prepared | PASS offline; **NOT VERIFIED live** | adapter and gateway tests; conformance with driver |
| 4 OpenAPI changes and compatibility documented | PASS (SCR-K-11; only a description edited) | SCR-K-11 |
| 5 Isolation, metering, cost limits, streaming, cancellation, tool-call security verified | PASS on the scripted provider | section E |
| 6 Affected tests re-run; unrelated failures reported separately | PASS | section E |
| 7 No live provider request enabled | PASS | gate G9 closed by default; counting `fetch` never called |
| 8 No production rollout, no executable tools | PASS | production adapter not registered; `ai.agent.exec_tools` unchanged |
| Live-verified capabilities, data terms, residency, pricing | **NOT VERIFIED / BLOCKED (D1, D2, D4, D5, D9)** | |

## I. Next steps
Your answers to §8 of `S-AG4-PREP.md`. After D1–D6 and D9: follow `docs/runbooks/anthropic-live-enablement.md`, run the approved probe in a non-production environment, record the evidence, then (after D7/D8) implement the evidence table and move tool declaration from the environment switch to recorded evidence. OpenAI and Gemini adapters follow the same contract and need their own HG-09-01 and D-18 answers (D11).
