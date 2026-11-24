# P3-S01 — Real AI Providers and Tool Calling

Branch `feature/p3-s01-providers` · worktree `.claude/worktrees/p3-s01` · Postgres 54351 · migrations 2300–2309 · base `integration/phase3`. Read first: `CLAUDE.md`, `docs/phase3/PHASE-3-PLAN.md`, `docs/parallel/LIVE-PROVIDER-PLAN.md` (§9 activation runbook), `docs/parallel/sessions/PHASE2-02-approval-inputs.md`, `docs/ai-intelligence/S-AG4-*.md`, ADR-061, ADR-066.

## Implementation prompt
You own the real model path. Make the Anthropic provider go from "built and sealed" to **LIVE-VERIFIED** the moment the owner records D2, D5, D6, D4, D3 and D9, with no further engineering. Until then, finish everything that does not need them. Never accept an agreement, create a key, enter a credential, call a vendor, or enable `AI_LIVE_PROVIDERS` yourself; the owner (or an authorized administrator) does it in the admin console and records references. Use official API-key authentication only (no consumer-subscription credentials, no unofficial wrappers).
Deliver: (1) the live verification executor: tracks A (connection), B (tool calling), C (code generation) running through the metered gateway, writing the evidence record format already defined (`nuzm.live-evidence`), refusing without approvals, with a hard USD cap printed first and enforced (D9 maxima: A 0.006400, B 0.080720, C 0.030400, suite 0.116720); (2) capability evidence ingestion that flips `supportsTools` only from a `VERIFIED` evidence row (D8); (3) streaming + cancellation mid-stream + structured output + usage reconciliation against the vendor-reported usage (D-31 tolerance), retries and circuit breaker exercised against the real vendor in a controlled error test only if the owner approves extra spend; (4) key rotation/revocation tooling and a kill switch drill (admin console, audited, vault ref only); (5) OpenAI and Gemini: complete adapters **behind D11** (they stay disabled and un-probe-able until their own D1/D2/D4/D5/D6 evidence exists); (6) provider health and approved fallback routing proven with real error codes once live; (7) rate-card and cost reporting verified against the vendor invoice for the verification runs.
## Scope boundaries
In: `packages/adapters/model/**`, the AI module (providers, gateway, runs, budgets, evidence, rate cards), admin provider UI. Out: builder lifecycle (P3-S03), sandbox (P3-S02), benchmarks live stages (P3-S08 runs them; you provide the verified model).
## Acceptance criteria
- A1 Owner approvals recorded -> `pnpm --filter @nuzm/api qualify:a|b|c` run live within the printed cap; evidence files exist; actual cost <= hard maximum; `ai.model_capability_evidence` has `VERIFIED` rows for tool use.
- A2 Tool-call round trip with a real model completes an agent tool loop (read tool -> result -> answer) in a synthetic run; `supportsTools` true only from evidence.
- A3 Streaming, cancel mid-stream, structured output, usage reconciliation each have a LIVE-VERIFIED record or an explicit `NOT VERIFIED` with the reason.
- A4 No key or prompt content in any log, audit event, DB column, response, screenshot or evidence file (existing leak suites stay green; a live-run leak check is added).
- A5 Refusal tests: every live path refuses without each of D2/D3/D4/D5/D6/D9 (unit tests, stay green).
- A6 Regression: all Phase 2 AI suites green; DEFECT-7/8/15 tests green.
## Dependencies
Needs: owner approvals (D2, D5, D6, D4, D3, D9). Provides: verified model gateway to S03–S06, S08. Works unblocked on: harness, evidence ingest, rotation tooling, OpenAI/Gemini behind-gate adapters, admin UX.
## Human gates (stop and record, continue other work)
Agreement acceptance, key creation, spending cap, region/ROPA statement, rate card, gate opening, probe approval, any spend above the printed cap.
## First tasks
Merge `integration/phase3`; run the Phase 2 AI suites single-file; write the live executor for A–C reusing `qualify-*.ts`; add the live leak check; draft the OpenAI/Gemini adapters against recorded-fixture mock servers; write `REPORT-P3-S01.md`.
