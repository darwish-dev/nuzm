# S-AG4 decision review report

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this work `c4f5ccf`; nothing merged or pushed) · Status: **DOCUMENTED and PREPARED. No approval is recorded, no live request was made, the probe was not executed, Anthropic's terms are not accepted and no international transfer of customer data is approved.**

## A. Findings and assumptions
- The owner's technical direction is recorded as a **proposal**; legal, contractual and credential items are listed as dependencies and are not assumed (`docs/ai-intelligence/S-AG4-DECISIONS.md` §0).
- **Pricing was read, not invented:** a read-only fetch of the vendor's two public pages on 2026-11-22 gave $4 / $20 per million tokens for `claude-opus-5-5`, equal to the adapter's value cached on 2026-11-03. Neither page shows a date; the figures are not confirmed against any contract. Facts that change the design: always-on adaptive thinking (output includes thinking tokens, all inside `max_tokens`); a tokenizer that yields about 30% more tokens; the tool-use overhead for a forced tool choice is **NOT STATED**; the only inference geographies on the pages are `global` and `us` (1.1x). `S-AG4-PRICING.md`.
- A forced tool choice may be refused by the service while thinking is always on: the adapter's named-tool mapping stays but the loop never uses it, and the probe records it (informational).
- All five existing failures were traced to their causes (`test-failure-remediation-plan.md`); none comes from S-AG3/S-AG4.

## B. Changed files
- **Probe (prepared, not wired):** `packages/adapters/model/src/probe.ts`, `probe.spec.ts` (15 tests), exported from the package.
- **Cost control:** the Claude adapter's pre-flight token estimate now carries the documented 1.3 tokenizer margin (`anthropic.ts`, +1 test).
- **OpenAPI validation tooling:** `packages/sdk/src/compat.ts` (+ spec, 5 tests), `scripts/openapi-compat.ts`, `scripts/scr-k-11-draft.ts`. `spec/openapi/openapi.yaml` and the SDK are **unchanged** in this work.
- **Docs:** `S-AG4-DECISIONS.md` (checklist D1–D12, prerequisites), `S-AG4-PROBE-PLAN.md`, `S-AG4-PRICING.md`, `test-failure-remediation-plan.md`, this report; updates to SCR-K-11 §4, `S-AG4-PREP.md` (pointer), and dated OPEN notes on D-18 and HG-09-01 in `docs/07`.

## C. What was done
1. **Final checklist:** D1–D12 split into TECH, LEGAL, CONTRACT, CRED and COMM, each with approver, evidence required, what it unblocks and whether it can be approved now. Approvable now without enabling anything live: D7, D8 (design), D10, D11 and the plan part of D3 and D9. Not approvable by engineering and not assumed: D1, D2, D4, D5, D6.
2. **Exact prerequisites** for S-AG4 completion (ten items, including the point that OpenAI and Google are part of the S-AG4 definition and need their own cycles or an approved deferral), for S-AG5 and for S-AG6 (`S-AG4-DECISIONS.md` §3).
3. **Bounded probe prepared:** eight fixed requests, no retries, a hard token cap, worst case 11,716 tokens (about USD 0.08 at list price, bound USD 0.24), refuses without an approval record, in production, below the worst case or on a 1.0 adapter, stops at once on any credential, outage, timeout, refusal or rate-limit error, sends no customer data, and verifies nothing on a partial run.
4. **OpenAPI validated:** both variants of the proposal lint clean; the boolean variant is 0 breaking / 0 warnings, the enum variant 0 breaking / 1 warning; the SDK generates from both and `apps/web`, `apps/admin`, `apps/api` typecheck against both.
5. **Pricing requirements** documented without inventing a rate.
6. **Remediation plan** for the five failures, each with evidence, fix, verification and whether an owner decision is needed.
7. **Controls maintained:** tenant isolation, audit, metering and cost controls are unchanged (the probe design runs through the gateway as a dedicated internal organization, data class `public`, with audit events; none of that is implemented yet).

## D. Migrations
None.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `@nuzm/adapter-model` tests | **80 passed** (64 before; +15 probe, +1 tokenizer margin) |
| `@nuzm/sdk` tests | 9 passed (5 new for the compat checker) |
| `anthropic-adapter.int.spec.ts` (real gateway, scripted client) after the margin change | 17 passed |
| `pnpm lint`, `pnpm typecheck` | exit 0 |
| `pnpm spec:lint`, `pnpm spec:drift` (502/502), `pnpm sdk:check`, `pnpm compliance:claims-guard` | OK |
| Draft spec: Spectral, compat check, SDK generation, consumer typecheck | as in section C.4 |
| Full integration and unit suites | not re-run for this delta (only TypeScript in one adapter and docs/tools changed); last full run (previous report): api 2107 passed, 1 failed (R1) |
| Existing failures, still present and unchanged | `scan:secrets` (R2), `zatca:guard` (R3): both reproduced today; R1, R4 and R5 reproduced earlier in this session |

## F. Security, isolation, metering, cost
Nothing live exists. The probe is not reachable from any route, job, console action or environment variable; a test asserts the module contains no network call, no process access and no environment switch. The pre-flight estimate now cannot under-reserve for the documented tokenizer.

## G. Human gates still needed
Every item of the checklist marked "No" or "Partly" (D1, D2, D3 opening, D4, D5, D6, D9 execution) and D12.

## H. Acceptance
| Item | Status |
|---|---|
| D1–D12 final checklist with technical vs legal/contract/credential separation | PASS (document) |
| No assumption of accepted terms or approved transfers | PASS (stated and enforced by defaults) |
| Probe prepared, not executed | PASS; execution **BLOCKED (D2, D3, D4, D9)** |
| OpenAPI changes validated for backward compatibility | PASS on drafts; **not applied** (D7) |
| Pricing requirements documented without invented rates | PASS; confirmation vs contract **NOT VERIFIED** (D2, D6) |
| Prerequisites for S-AG4, S-AG5, S-AG6 | PASS (document) |
| Remediation plan for the five failures | PASS (plan only; nothing fixed) |
| Live-verified anything | **NOT VERIFIED** |

## I. Next
Your answers to the checklist. Engineering can start without any of the blocked items: R1, R2 and R4 (no owner decision), and S-AG4b (evidence table and admin actions) once D7 is accepted.
