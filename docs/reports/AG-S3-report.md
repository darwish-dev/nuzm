# Agentic Coding Engine — slice S-AG3 report (read-only agent loop)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this slice `c4c9926`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope on the scripted mock provider. The flag `knowledge.agentic_generation` is OFF by default. No real provider call, no execution tool, no production access and no unrestricted filesystem access exists. Model quality is NOT VERIFIED.**
Governing documents: ADR-066, SCR-K-10 (§5, §6, §8, §12), AC-AG-08 and AC-AG-11 (this slice's targets), AC-AG-01, 04–07 (must not break).

## A. Repository findings and assumptions
- **Known S-AG2 race (fixed first, as requested).** The per-run limits (60 calls, 400 000 result bytes) were read, checked and recorded in separate steps, so concurrent batches of one run could each pass the check. Regression tests reproduced it on the old code (they failed) and pass on the fix.
- The `webapp` run kind, `RunContext` (`save`, `emit`, `cancelled`, `succeed`) and `ai.run_steps` already provide everything a loop needs; no new run kind or run table is added. `ai.run_steps.agent` is a CHECK over eight names, so the loop needed migration 1869 (one value).
- **Findings outside this slice, fixed because they sit on the same routes:** the generated cross-tenant suite (`cross-tenant.int.spec.ts`) had no fixture for the S-K6/S-K7 routes (`generation-plans/{id}`, `/context`, `/runs`, and `builder/templates/{id}`) and was failing on its "every path parameter has a fixture" and "positive control" tests. I added an org-A plan fixture (so the plan routes, including the new timeline, are now tested for cross-tenant 404 with a real row and for a 200 for the owner) and marked `GET /v1/builder/templates/{id}` `x-nuzm-global-reference` (a published template is platform-wide data, like the plan catalogue). The `/context` 200 path is excluded from the generic positive control (it needs a template copy; it is covered in `knowledge/review.int.spec.ts`).
- **Assumption:** the loop's own call budget is the run's budget (`ctx.run.budget`: tokens, credits) plus the loop ceilings below; "cost" is enforced by the run budget, whose exhaustion is final.
- Environment: Postgres :54339 (project-local); E2E on ports 3300/3301/4300/4310, database `nuzm_e2e_k2a`. Port 4000 is held by an unrelated process, so the default-port `pnpm test` (which includes the Playwright package) cannot start here (see E).

## B. Plan and changed files
- **Concurrency fix:** `apps/api/src/modules/ai/internal/agent-tools.service.ts` (one transaction per batch, per-run advisory lock, records inserted with `clock_timestamp()`, replay-safe call ids, audit flushed after commit); regression tests in `appbuilder/agent-tools.int.spec.ts` (+3, now 30).
- **Domain (pure):** `packages/domain/src/ai/agent-loop/` (`limits.ts`, `state.ts`, `fallback.ts`, `prompt.ts`, `index.ts`, `agent-loop.spec.ts` — 16 tests), exported from `packages/domain/src/ai/index.ts`.
- **API:** `appbuilder/internal/studio/agent-loop.ts` (`AgentLoopRunner`), `template-adapt.ts` (`proposalProblems` public, new `applyProposal`; S-K6 behaviour unchanged), `run-handlers.ts` and `appbuilder.module.ts` (wiring), `generation.ts` (`start` with `agentic`, `timeline()`), `generation.controller.ts` (timeline route), `knowledge/{index,internal/flag}.ts` (flag), `agent-loop.int.spec.ts` (24 tests).
- **Mock:** `packages/adapters/model/src/mock.ts` — the opt-in tool-capable mock models get a 16 000-token output ceiling and a 64 000-token context so the loop's own request fits (the default two mock models are unchanged).
- **DB:** `packages/db/migrations/ai/1869__ai__agent_run_steps(.down).sql`.
- **Spec/SDK:** `spec/openapi/openapi.yaml` (timeline path, `BuilderAgent*` schemas, `agentic` on the run request, `x-nuzm-global-reference` on `getBuilderTemplate`), `packages/sdk/src/schema.ts` (regenerated).
- **Web:** `lib/agent-timeline.ts` (+ spec, 7), `components/AgentTimeline.tsx` (+ spec, 7), `components/TemplateWorkspace.tsx` (option + timeline; spec +3), the template page (flag prop), `packages/i18n/src/messages.ts` (`agt.*`, ar/en).
- **E2E:** `e2e/tests/18-ai-agent-timeline.spec.ts`; screenshots `docs/reports/screenshots/{ar,en}/ai-agent-{off,option,timeline}.png`.
- **Docs:** this report, SCR-K-10 §8 and §12, ADR-066 progress.
- **Tests outside the slice:** `tenancy/cross-tenant.int.spec.ts` (fixtures, see A).
- Not touched: execution tools, real provider adapters, S-K6 behaviour with the flag off.

## C. Implemented
1. **Concurrency-safe limits:** one transaction per batch holds `pg_advisory_xact_lock(hashtextextended('ai.agent_tools:<run>'))`, counts, executes and records. Eight concurrent batches of sixteen calls record exactly 60 successes and the rest `limit_exceeded`; concurrent large reads never exceed 400 000 bytes; concurrent duplicate call ids are recorded once.
2. **The loop** `plan → explore → propose → validate → apply` over `ModelAdapter` v1.1 through `GatewayService.invoke` (so budget, residency, data terms, secret scan, kill switch and metering are the gateway's). Turn 1 is `plan`, later turns `explore` with the read-only tools of the S-AG2 gateway, the last forced turn has no tools (`propose`). `validate` runs the S-K6 proposal checks (schema, workspace consistency, mode rules, safe-change checks); an invalid proposal is answered with the reasons (at most 2 repairs, each its own `validate` step). `apply` goes through the safe-change pipeline on the AI branch `work/ai`, once.
3. **Structured feedback:** tool results come back as fence-framed untrusted data (random fence; control and bidi characters stripped; bounded); a call that fails its schema, names an undeclared tool or is refused by the gateway is answered with a structured error result; nothing is run for it. A rejected proposal is replaced by a placeholder in the history and the checkpoint (it can carry a secret).
4. **Ceilings:** 12 turns, 10 minutes (kept across a resume), 400 000 loop tokens, 16 000 output tokens per turn, plus the gateway's 60 tool calls and 400 000 result bytes and the run budget. Reaching a loop ceiling stops exploring and falls back; a budget, credit, kill-switch, residency, data-terms, secret or content decision is final (the run fails, no fallback, nothing applied).
5. **Fallback to S-K6** (`agentic_disabled`, `tools_unavailable`, `no_tool_capable_model`, `provider_error`, `invalid_proposal`, `ceiling_turns|time|tokens`) only before apply; recorded as a step, an event and an audit row.
6. **Cancellation, checkpoints, resume:** the checkpoint is saved after every finished turn; the cancel flag is polled during a turn (the model call is aborted) and at every boundary; a crash mid-turn resumes from the checkpoint without repeating finished turns or tool calls, the failed step is retried (attempt 2) under a new call id (a settled reservation is never reused), and a resume after apply reports the result and asks nobody.
7. **Persistence and audit:** each step is an `ai.run_steps` row (agent `agent`), each tool call an append-only `ai.tool_calls` row, events `agent_started|turn|validation|applied|fallback|stopped`, audit rows for start, fallback, apply and stop.
8. **API:** `POST /v1/builder/generation-plans/{id}/runs` accepts `agentic: true` (422 while `knowledge.agentic_generation` is off, nothing starts); `GET /v1/builder/generation-plans/{id}/timeline` (`builder:read`, read-only, 404 while `knowledge.generation` is off).
9. **UI (ar/en):** the template workspace offers "Use the read-only agent (experimental)" only while the flag is on and the person may run AI (unchecked by default) and shows the read-only timeline: plan, steps by phase and status, tool calls (tool, redacted arguments, status, error code, size), limits against ceilings, fallback reason, outcome; loading, empty, single-call, error and forbidden states; refresh is its only control; polls only while the run is moving; never shows file contents.
10. **Flags (default off):** `knowledge.generation` + `knowledge.agentic_generation` + `ai.agent.read_tools`. A run created through the generic run endpoint that bypasses the start check falls back to the single call and says why.

## D. Migrations and rollback
- `1869__ai__agent_run_steps.sql`: drops and re-adds `run_steps_agent_check` with `'agent'` added (expand only).
- `1869__ai__agent_run_steps.down.sql` (DEV/STAGING only; production is forward-fix): re-adds the previous check **NOT VALID**, because run steps are append-only and rows written by the loop must stay.
- **Verified** on a scratch database: migrate (constraint includes `agent`) → down (previous constraint, `convalidated = f`) → up again (constraint includes `agent`); the E2E database also migrated through 1868 and 1869.

## E. Tests run with actual results
| Command / suite | Result |
|---|---|
| `NUZM_TEST_ADMIN_URL=… npx vitest run --config vitest.integration.config.mts src/modules/appbuilder/agent-loop.int.spec.ts` | **24 passed** |
| same, `agent-tools.int.spec.ts` (27 + 3 concurrency regression) | 30 passed (the 3 new ones failed on the pre-fix code) |
| `pnpm test:integration` (whole workspace, before the cross-tenant fixture fix) | db 102 · platform 32 · worker 92 passed; **api 2090 passed, 3 failed, 2 skipped**: two cross-tenant failures (fixed, see A) and `domains-search` registrar probe matrix (pre-existing: a `dnet` registrar from another slice; recorded in K-S1/K-S2a/b/c reports) |
| `cross-tenant.int.spec.ts` alone after the fix | **556 passed** (the full workspace suite was not re-run after this fix) |
| Unit: `npx turbo run test --filter='!@nuzm/e2e'` | 49 of 52 tasks successful; domain 880, db 55, worker 60, adapter-model 47, i18n 9; the one failure was a 30 s timeout of `knowledge-upload.spec.ts` in `apps/admin` under load, **22/22 pass when run alone** (unrelated to this slice) |
| Web unit (`apps/web`, vitest) | 72 files, **861 passed** (7 + 7 new, 3 added to TemplateWorkspace) |
| `pnpm lint` (eslint + prettier) | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm --filter @nuzm/domain build`, `@nuzm/sdk build` | exit 0 |
| `pnpm spec:lint`, `pnpm spec:drift` (502/502 routes), `pnpm sdk:check` | all OK |
| `pnpm compliance:classification-coverage` (3 359 columns), `ropa-coverage`, `residency-hooks`, `claims-guard`; `pnpm db:test-rls` | all OK |
| `pnpm scan:secrets` | **1 finding, pre-existing**: `apps/api/src/modules/domains/internal/registrar-dnet-settings.spec.ts:9` (not touched by this slice) |
| `pnpm zatca:guard` | **fails, pre-existing**: the generator sources differ from the pinned hash since commit `8e314fd`; no ZATCA file is modified by this slice and the pin was NOT updated (a ZATCA re-pin is the owner's decision) |
| Browser E2E (own ports/database): `tests/18-ai-agent-timeline.spec.ts` and `tests/17-ai-generation.spec.ts`, Arabic and English, with axe (WCAG 2.1 A/AA) | **4 passed** |
| `pnpm test` at the default ports | fails here only because port 4000 is held by an unrelated process (Playwright refuses to start); the other packages passed |
| `pnpm verify` / `verify:full` | **NOT RUN** as a whole (see the individual rows) |

The E2E answers the browser's start request with the plan as the API reports it after the run's rows exist, because this stack has no model provider (and S-AG3 never uses a live one); the timeline itself is read for real from rows written with SQL as the loop writes them. The loop is exercised end to end by `agent-loop.int.spec.ts`.

## F. Security, tenant isolation, billing, residency verification
- **Tenant isolation:** a plan or run of another organization is "not found" (loop and timeline), no model is called and nothing is written; the generic cross-tenant suite now covers all four plan routes with a real org-A row (404 for org B's session and API key; 200 for org A's owner).
- **Authorization:** a viewer cannot start the agent (403) but can read the timeline; the run creator's current permissions are re-checked by the tool gateway at every call; malformed run input is refused at creation.
- **Untrusted content:** a prompt injection inside a project file arrives only as a fenced tool result; a model that obeys it by calling an undeclared tool cannot run anything; paths outside the project and secrets in a proposal are refused by the shared checks and the proposal is never echoed back or checkpointed.
- **Append-only history:** the application role cannot update or delete `ai.tool_calls` rows or change a finished step (tested).
- **No new power:** the loop can only call the four S-AG2 read tools; there is no tool that takes a command, no process, filesystem or network access (the S-AG2 static separation test still passes); the only write is the shared safe-change apply on `work/ai`; `ai.agent.exec_tools` remains a name that reads no row.
- **Billing/metering:** every model turn goes through the gateway (reservation, usage, metering); budget exhaustion is final and tested (no fallback, no change). No billing code was touched.
- **Residency:** the loop calls the gateway with data class `customer-content`; residency, data-terms and kill-switch refusals are final. No new data region, vendor or personal-data column was added (classification coverage OK).

## G. Human gates and live checks still needed
Nothing in S-AG3 needed a human gate. Still open for the engine: **HG-09-01** (data terms of any model provider), **D-18** (residency), provider selection and owner-supplied sandbox credentials (S-AG4), owner acceptance of the OpenAPI delta (§7: the timeline route, the `agentic` field, `x-nuzm-global-reference` on `getBuilderTemplate`), **D-21** (execution isolation; blocks S-AG6), **D-42** (production rollout), the benchmark thresholds (AC-AG-10), and **D-38** (Claude Code, tracked separately). Everything below the mock is NOT VERIFIED: no live model has produced a plan, a tool call or a patch.

## H. Acceptance checklist
| Item | Status | Evidence |
|---|---|---|
| Per-run quota race fixed, regression tests | PASS | `agent-tools.int.spec.ts` concurrency block (3 tests; failed before the fix) |
| Plan → explore → propose → validate → apply | PASS (mock) | `agent-loop.int.spec.ts` "runs the whole loop…" |
| Multi-turn via ModelAdapter v1.1; read-only tools via the S-AG2 gateway | PASS (mock) | same + "the first user message…" |
| Structured tool-result and rejected-call feedback | PASS | schema-failure and refused-tool tests; domain `agent-loop.spec.ts` |
| Iteration, token, time, cost and tool-call limits | PASS | ceilings tests (turns, time, tokens, tool budget) and "spend limits are final" |
| Cancellation, checkpoints, safe fallback to S-K6 | PASS | cancel test, crash/resume test, fallback tests |
| Persistent steps and append-only history | PASS | steps/tool-call rows asserted; append-only test |
| Customer read-only timeline (ar/en) | PASS | web unit 7 + E2E ar/en with axe and screenshots |
| Flag `knowledge.agentic_generation`, off by default | PASS | flag tests; E2E "off" screenshots |
| Unit, integration, concurrency, tenant-isolation, security tests | PASS | section E |
| Migration rollback verified | PASS | section D |
| AC-AG-08 (loop) | PASS on the mock; **NOT VERIFIED** with any real provider | |
| AC-AG-11 (UI timeline) | PASS | E2E + screenshots; the diff view is the run result's patch count and branch only |
| AC-AG-01 (flags off = S-K6 unchanged) | PASS | S-K6 suites unchanged and green |
| AC-AG-09, 10, 12 | NOT STARTED / BLOCKED (S-AG4, S-AG5, S-AG6) | |
| Full `pnpm verify` | NOT VERIFIED as one run; two pre-existing failures (`scan:secrets`, `zatca:guard`) and one environmental (port 4000) | section E |

## I. Next-milestone handoff and open decisions
**Readiness for S-AG4 (real provider adapters and verification): the code side is ready** — the contract (1.1), the conformance kit, the tool gateway and the loop are provider-neutral and tested on the mock, and the loop falls back safely when a provider lacks tool use. **S-AG4 cannot start as live work until these are decided or supplied:**
1. HG-09-01 (provider data terms) and D-18 (residency evidence): a provider is not offered for customer content without them.
2. Provider selection (OpenAI, Google, Anthropic 1.1) and owner-supplied sandbox/test credentials, stored in the non-production vault only.
3. Acceptance of the OpenAPI delta and, if wanted, the public `GET /v1/ai/models` extension for the 1.1 capabilities.
4. For S-AG5: the golden task suite thresholds (AC-AG-10) and S-K8 evidence; for S-AG6: D-21 and the escape suite; for any rollout: D-42 and owner sign-off.
Follow-ups noticed here and left for you: re-pin or revert the ZATCA generator sources (`zatca:guard`), the `dnet` registrar test and secret-scan finding in the domains module, and the `docs/reports/evidence/M12-tenant-sweep.json` file that test runs regenerate (left uncommitted).
