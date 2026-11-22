# Agentic Coding Engine — slice S-AG2 report (read-only tool gateway)

Date: 2026-11-22 · Branch `claude/run-it-dc3d6a` (latest before this slice `1b64253`; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope. The flag `ai.agent.read_tools` is OFF by default; no real provider call, no execution tool, no agent loop and no UI exists; production stays BLOCKED on D-42; execution tools on D-21.**
Governing documents: ADR-066, SCR-K-10 (§3, §4, §6, §8, §11), AC-AG-04..07 (this slice's targets), AC-AG-01 (must not break).

## A. Repository findings and assumptions
- The tool allow-list of the run engine (`checkToolCall`) covers only the website kinds; `ai.tool_calls` required a run step and had no column for the model's call id or the size handed back, so per-run limits and replay-safety needed three additive columns (migration 1868).
- `ai.runs` already holds the project, the kind, the state and the creator, so the gateway derives everything from the run: a caller or a model cannot name a project.
- **Decision for your attention (ownership manifest):** a migration of the AI Intelligence module (range `K`) may not touch the `ai` schema unless the manifest lists it as an extender. I added `K` to `ai.extended_by` in `spec/db/ownership.yaml` (one line). The alternative was to keep the data in existing JSON columns without a constraint; I chose the migration.
- **Finding:** my first glob matcher compiled to a regular expression and backtracked catastrophically on a hostile glob; the test I wrote for exactly that case hung. It is replaced by a memoised matcher with bounded cost (see C.3). Worth knowing because it was a real defect of the first design, found by the security test, not by review.
- `ai.run_steps.agent` is a CHECK over eight agent names; the S-AG3 loop will need its own agent value (a migration), noted in I.
- Environment: Postgres :54339; no browser E2E (no UI or route changed).

## B. Plan and changed files
- Domain (pure) `packages/domain/src/ai/agent-tools/`: `limits.ts`, `paths.ts` (path and glob rules, sensitive names), `workspace.ts` (read-only snapshot with file origins), `tools.ts` (the four tools, schemas, executor, renderer), `index.ts`; specs `agent-tools.spec.ts` (33) and `separation.spec.ts` (4); `eslint.config.mjs` (executor boundary rule).
- API (AI module): `internal/agent-tools.service.ts` (`AgentToolGateway`, `redactArgs`) + spec, `internal/agent-workspace.ts` (registry), `internal/flags.ts` (`ai.agent.read_tools`, reserved `ai.agent.exec_tools`), `ai.module.ts`, `index.ts`.
- API (app builder): `internal/studio/agent-workspace.ts` (provider), `generation.ts` (`workspaceView`), `appbuilder.module.ts` (registration for `webapp`), `agent-tools.int.spec.ts` (27 integration tests).
- DB: `1868__ai__agent_tool_calls(.down).sql`; `spec/db/ownership.yaml` (three columns classified; `K` extends `ai`).
- Docs: this report, SCR-K-10 §11, ADR-066 progress, plan table.
- Not touched: OpenAPI, the S-K6 adaptation code paths, S-AG1 contract code, consoles.

## C. Implemented
1. **Four read-only tools** with strict schemas (`additionalProperties: false`, bounded strings and integers): `list_files` (sorted paths with size, origin and whether content is readable; directory, glob, limit), `read_file` (text or a line range, at most 16 000 characters per call with a `nextStartLine` to continue), `search_code` (literal, case-insensitive by default, path glob, limit, shortened lines, work-bounded), `inspect_project` (counts, manifests, entry points, frameworks, dependencies, script NAMES only). No tool takes a command, a URL, a pattern language or a destination.
2. **Secure reading and search:** paths are normalised or refused (traversal, absolute, home, drive letters, encodings, backslashes, controls, bidi and zero-width characters, non-NFC, bad shape); sensitive file names are invisible to every tool; a result never quotes an argument or a file in an error.
3. **Glob matcher** with cost bounded by path length times token count (no backtracking), a small safe alphabet and at most 8 wildcards.
4. **Isolation and permissions:** the workspace is the run's own project (row-level security); another organization's run or project is "not found"; the run creator must hold `ai:write` and `builder:read` in an active organization at call time; a step must belong to the run; a finished run is refused.
5. **Template AI-processing gate (rule 5):** unchanged template files are listed but not readable, searchable or summarised unless the template permits AI processing; a withdrawn template counts as not allowed; the customer's own work, including an edited template file, is always readable.
6. **Limits:** per run 60 calls and 400 000 result bytes (beyond them calls are denied with `limit_exceeded` / `budget_exhausted` and the batch reports `limitReached`); per call 40 000 bytes; 16 calls per batch; read, list, search and inspect bounds.
7. **Audit and safety:** every call is an append-only row in `ai.tool_calls` (model call id, size, fixed error code, redacted arguments: a search query is never stored, only its length and a short hash); denied tools raise `ai.tool_call.denied`; a result containing a secret pattern or a platform canary is withheld and audited (`ai.secret_scan.blocked`, where `tool_result`).
8. **Integration:** `AgentToolGateway.specs()` returns the specs for the model gateway (none unless the flag is on, the kill switch is off and the kind may use tools); the integration test drives a three-turn exchange through the real `GatewayService` and the scripted mock provider (specs out, validated calls back, results fed in as blocks, final answer).
9. **Flags:** `ai.agent.read_tools` default OFF, organization row beats global; `ai.agent.exec_tools` is reserved and `execTools()` returns false without reading any row.

## D. Migrations and rollback
`1868__ai__agent_tool_calls.sql`: `call_id`, `result_bytes`, `error_code` (nullable, constrained) and a partial unique index on `ai.tool_calls`. Reversal in `.down.sql` (dev/staging; production forward-fix); tested down and up on a scratch database. Behaviour rollback: the flag (default off); nothing calls the gateway yet.

## E. Tests run, with actual results (this worktree)
| Check | Result |
|---|---|
| Domain `agent-tools.spec.ts` + `separation.spec.ts` | **37 passed**: path and directory rules incl. a 20 000-case property test, sensitive names, glob compilation and matching, the hostile-glob timing test, tool schemas (no command, URL, pattern or destination argument), `list_files`, `read_file` (ranges, cut and continue, one enormous line, bad paths and ranges, sensitive files, template gate, refusals that never quote the argument), `search_code` (literal, no pattern syntax, withheld files, limits, work bound), `inspect_project` (script names only), rendering, totality fuzz (no tool ever throws), the workspace's own copy; static separation (imports, forbidden capabilities, tool names) |
| Domain total | **864 passed** (827 before) |
| API unit | **1074 passed** (4 new: `redactArgs`) |
| Adapter package 47 · web 844 · admin 348 · i18n 9 · ui 24 · db 55 · worker 60 · adapters | all passed (unchanged) |
| API integration `agent-tools.int.spec.ts` | **27 passed** (real schema, real model gateway, scripted mock provider): flag default off, organization row beats global, execution flag cannot be on, kill switch and `ai.enabled`; the four tools over the run's own project; file text as data; per-batch snapshot; traversal and absolute paths; missing vs sensitive names (no existence oracle); unknown, write, fetch and wrongly cased tools denied and audited; extra arguments and wrong types; batch bounds; secret and canary in a result withheld and audited; records (call id, size, fixed code, redacted arguments, query never stored, replay recorded once, append-only for the application role); per-run call limit, per-run size limit, per-call cut; finished run, unknown run, foreign step; creator permissions (viewer, developer, other-organization member, no creator); run without a project; tenant isolation (both directions, provider returns nothing across organizations, records invisible, forged record refused); template permission denied and granted, withdrawn template, edited template file; a three-turn exchange through the real model gateway and the mock |
| API integration, AI + knowledge + app builder + builder: 16 files | **385 passed** (358 before): S-K6 single-call tests and all S-AG1 gateway tests unchanged |
| DB integration | **5 files, 102 passed** |
| Migration reversal (1868 down, then up again) | PASS on a scratch database: columns 3 → 0 → 3 |
| `pnpm lint` (eslint + prettier) | PASS; the new boundary rule was shown to reject a deliberately bad file (node builtin and `process`) |
| `pnpm typecheck` (52/52), `pnpm build` (28/28) | PASS |
| `db:test-rls`, classification coverage (3359 columns), ropa coverage, residency hooks, `spec:lint`, `spec:drift` (501 routes), `sdk:check`, `compliance:claims-guard` | PASS (no OpenAPI change) |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched); my test builds its fake credential at run time |
Not run: browser E2E (no UI or route changed), `pnpm verify:full`, the full API integration suite (AI, knowledge, app-builder and builder modules were run), any real provider.

## F. Security, tenant isolation, billing, residency
- **No capability to leave the process:** the executors import only their own files and the pure schema validator; a lint rule rejects any node builtin, `process`, `require`, network global or dynamic code in that directory (demonstrated against a deliberately bad file), and a test reads the source and fails on the same. There is no tool that takes a command line, and the execution flag is a constant false.
- **Hostile input:** a 20 000-case path property test, a fuzz that every tool returns a result for any argument shape and never throws, and the hostile-glob timing test.
- **Isolation:** another organization cannot execute against a run, read a project through the provider, see the records, or write a forged record (row-level security); within an organization the project is always the run's own.
- **Billing and metering:** tool calls are free data operations counted in `ai.tool_calls`; the model's tokens (including tool results fed back) are metered through the model gateway as in S-AG1. Residency: nothing leaves the project snapshot.
- Known gaps: the per-run limits read and then write without a lock, so two concurrent batches on the SAME run could overshoot slightly (the loop calls the gateway sequentially; the unique call-id index prevents double recording); the gateway scans the results it returns but the secret scan of a file's content at WRITE time remains the project pipeline's; no UI shows the tool calls yet; token cost of tool specs is estimated.

## G. Human gates and live checks still needed
Unchanged from S-AG1: real providers and their capabilities (S-AG4, HG-09-01, D-18, credentials), D-21 for execution tools, D-42 for production. No tool here can be called by a real model until S-AG3 wires a loop and an owner enables the flags.

## H. Acceptance checklist
| Criterion | Status |
|---|---|
| AC-AG-01 flags off: system unchanged; S-K6 single-call behaviour preserved | PASS (S-K6 knowledge and app-builder suites re-run unchanged) |
| AC-AG-04 only registered, allow-listed tools run; unknown names denied and audited; arguments schema-validated first | PASS |
| AC-AG-05 tenant and project isolation, path/size/count/time limits, template AI-processing gate, hostile content treated as data | PASS |
| AC-AG-06 every call audited (redacted) and counted; ceilings stop the loop; kill switch | PASS for the gateway (the loop that honours `limitReached` is S-AG3) |
| AC-AG-07 static proof that executors cannot reach process, filesystem, network or sandbox; no tool takes a command line | PASS |
| AC-AG-08 loop, AC-AG-09 providers, AC-AG-10 benchmarks, AC-AG-11 UI | NOT STARTED |
| AC-AG-12 execution tools | NOT STARTED, BLOCKED (D-21) |

## I. Readiness and dependencies for S-AG3 (agent loop)
**Ready now (done in S-AG1 and S-AG2):** contract 1.1 and the gateway's tool and streaming support; `AgentToolGateway.specs()` and `.execute()` returning `tool_result` blocks, `outcomes` and `limitReached`; the template-aware read-only workspace; flags `ai.agent.read_tools`; the S-K6 single call, `ADAPT_SCHEMA`, `checkProposal` and the `ChangeService` apply path as the fallback and the apply target.
**S-AG3 must build:**
1. A run step per model turn. `ai.run_steps.agent` is a CHECK over eight names: a migration to add the loop's agent value(s) is needed (and the unique `(run_id, node)` index means one node name per turn, e.g. `turn-1`).
2. The state machine plan, explore, propose, validate, apply with ceilings (turns, tool calls, tokens or credits, minutes), honouring `limitReached`, cancellation and checkpoints of the messages (blocks) so a resumed run never repeats an applied change.
3. Conversion of `rejectedToolCalls` from the model gateway into `tool_result` blocks with `isError` (a small helper), so the model can correct itself.
4. Wrapping tool results in the run engine's untrusted-content handling in the prompt (the gateway already scans them as outbound text; the loop owns the framing).
5. A new run mode or input on the `webapp` kind (like `templatePlanId`) and the flag `knowledge.agentic_generation` (requires `knowledge.generation` and `ai.agent.read_tools`), with automatic fallback to the single call when the provider lacks verified tool-use.
6. The customer view of a run's tool calls (a read-only, redacted endpoint: an OpenAPI delta needing your approval) and the timeline UI (Arabic and English, e2e, axe, screenshots).
7. A provider that declares `tool-use` for tests (the S-AG1 mock suffices); real use still needs S-AG4.
**From you before real use:** S-AG4 decisions (provider selection, data-terms attestation, residency, sandbox credentials), approval of the OpenAPI delta for the tool-call view and for the 1.1 capabilities in the model list, and the benchmark thresholds (AC-AG-10).
