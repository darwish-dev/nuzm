# AI Intelligence Center — S-K2c hardening report (isolated parser thread sandbox)

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K1, S-K2a `a37c2a0`, S-K2b `c59d148`, S-K2c `5c31f1e` preserved; nothing merged or pushed) · Governing documents: ADR-065 addendum D, SCR-K-05 (`docs/spec-change-requests/SCR-K-05-parser-sandbox.md`), `docs/ai-intelligence/D-42-D-45-status.md`.
Status: **IMPLEMENTED and VERIFIED** for its defined scope. The COMPONENTS stage is still OFF by default (`KNOWLEDGE_COMPONENTS_ENABLED`); **production stays BLOCKED on D-42**.

## A. Repository findings and assumptions
- S-K2c parsed in the ingestion worker's own thread under per-file limits; the `worker_threads` sandbox was an open item. This slice closes it. Nothing else of S-K2c changed: same analyzers, facts, tables, endpoints, permissions and UI.
- **Correction of my own earlier reports.** S-K2c's report, SCR-K-04, ADR addendum C and my closing message said D-45 (Dart parser) was undecided. `docs/07-open-decisions-and-blockers.md` records it as DECIDED on 2026-11-20 (bundled tree-sitter parsers, no SDK execution). What is open is the concrete grammar: selection, licence, pin, WASM provenance and dependency review. Those statements are corrected in place and in `D-42-D-45-status.md`.
- Node 22.15 has no per-thread CPU accounting (`Worker.cpuUsage` arrived in a later release). The CPU limit is therefore the wall-clock limit per file: a parse is a single synchronous run, so wall time is a strict upper bound of its CPU use. Stated, not hidden.
- A worker thread is a fault and resource boundary, **not a privilege boundary** (it is not technically prevented from asking Node for a file or socket). The protection is that nothing from a package is executed, the thread holds no secrets or handles, and a thread that misbehaves is terminated.
- The machine was under extreme load during verification (load average about 285 from other sessions), which is why the browser E2E used a temporary config with longer server-start timeouts (deleted afterwards).

## B. Plan and changed files
- New, `apps/worker/src/knowledge/ast/`: `sandbox-protocol.ts` (limits, wire types), `parser-thread.ts` (thread entry and pure `handle()`), `parser-sandbox.ts` (pool, `ThreadParserSandbox`, `SandboxAborted/Closed/Unavailable`), `parser-sandbox.spec.ts` (32 tests), `testing/hostile-thread.cjs` (test-only misbehaving thread).
- Changed: `ast/ts-file.ts` (node budget is now a per-call option, can only be lowered), `components-stage.ts` (parsing through the sandbox, concurrency, watch/abort, budget and failure breaker, not-cached rules, log codes), `ingest-service.ts` and `main.ts` (options and three env variables), `components-stage.int.spec.ts` (shared real sandbox plus 7 new tests), `.env.example`.
- Domain/i18n: `SkipReason` gains `timeout | memory | crashed | deadline`; 8 message keys (ar/en) so the architecture panel names them.
- Docs: ADR-065 addendum D, SCR-K-05, `D-42-D-45-status.md`, corrections to the S-K2c documents, `S-K4-PREP.md`, this report.
- No migration, no OpenAPI change, no table or permission change.

## C. Implemented
1. **Pool of isolated threads** (default 2, at most 4 and at most the CPU count), one file at a time per thread, a replacement after any failure and after 300 files, never reused after a failure; a thread that dies while idle is detected and replaced.
2. **Limits**, all enforced and tested: 10 s wall clock per file (the thread is terminated, which also interrupts regular-expression backtracking); V8 heap 384 MiB old / 48 MiB young and 4 MiB stack per thread (exceeding it ends the thread, never the process); file size 512 KiB (before dispatch and again in the thread); AST node budget 400 000 (only lowerable); result size 190 000 bytes; startup 20 s; stage parsing budget 10 min and a breaker after 25 failures.
3. **Isolation**: empty environment, no handles, stdout/stderr captured and discarded, request bytes transferred (not shared), replies structurally validated, replies that do not belong to the request ignored.
4. **Failure handling**: typed per-file outcomes become skip reasons, reported and never guessed. Limit-hit results (`timeout`, `memory`, `crashed`, `deadline`) are not cached (a later run may succeed; proved by a test where the second run re-parses exactly those two files and succeeds); deterministic outcomes are cached. A sandbox that cannot start fails the job as transient (retry with back-off, then dead letter) and writes nothing.
5. **Cancellation and shutdown**: a cancel request or a lost lease aborts every in-flight parse (threads terminated) within the 200 ms watch interval; the stage writes nothing; a sandbox the stage created is closed on success, failure and cancel.
6. **Operations**: `KNOWLEDGE_PARSER_THREADS`, `KNOWLEDGE_PARSER_TIMEOUT_MS`, `KNOWLEDGE_PARSER_HEAP_MB`; a `components.parser` or `components.parser_limits` log entry per job with counts, threads and timing.
7. Works from source (`tsx`, used by the dev worker and the E2E) and from the compiled `dist` (smoke-tested: a compiled sandbox parsed a TSX component in about 1.1 s including thread start).

## D. Migrations and rollback
None. Rollback: revert the commit, or leave `KNOWLEDGE_COMPONENTS_ENABLED` false (default).

## E. Tests run, with actual results (this worktree, isolated Postgres on :54339)
| Check | Result |
|---|---|
| Sandbox unit tests `parser-sandbox.spec.ts` | **32 passed** (handler without a thread; direct-analyzer equivalence; real-thread hostile sources: 20 000-deep parentheses, 480 KB arrays, minified lines, NUL, invalid UTF-8, `__proto__` names, unterminated strings, 5 000-deep JSX; size, node, result, time limits; spin, regex backtracking, heap bomb, throw, exit, bad shape, wrong id, death while idle; empty environment; recycling; start failures; abort in flight, queued and pre-aborted; close; concurrency over 3 threads and isolation between neighbours; 40-file crash burst) |
| Worker unit, all | 51 passed (5 files) |
| Worker integration (real PostgreSQL, role `nuzm_worker`), all | **73 passed** (6 files): 17 in `components-stage.int.spec.ts`, of which 7 new: own-sandbox lifecycle, files stopped at limits (reported, not cached, re-parsed later), breaker, stage budget, sandbox unavailable (retry then success), cancellation in flight, close on failure |
| API integration, knowledge | 57 passed (2 files) |
| Domain unit | 747 passed · i18n 9 · admin 329 · adapter `knowledge-store` 26 (includes the production guards of D-42) |
| `pnpm lint` (eslint + prettier), `pnpm typecheck` (52/52), `pnpm build` (28/28), `pnpm spec:lint`, `pnpm spec:drift` (481 routes), `pnpm sdk:check`, `pnpm compliance:claims-guard` | PASS |
| `db:test-rls`, `compliance:classification-coverage` (3336 columns in 265 tables) | PASS when pointed at this worktree's database (`DATABASE_ADMIN_URL=…:54339/nuzm_dev`); with the default URL the classification check hits another workspace's unmigrated cluster and fails, which is not related to this change |
| `pnpm scan:secrets` | one hit, in another session's `registrar-dnet-settings.spec.ts:9` (untouched); my files are clean |
| Browser E2E `15-ai-ingestion.spec.ts` (Arabic + English, real worker process, detect + components on, threads started from source) | **8/8 passed** (ar and en, axe clean), 6.7 min under heavy machine load; the worker ran as a real child process and parsed through real threads started from source; components, relationships and both manifests were verified in the database |
Not run: `pnpm verify:full`; the full API integration suite (the API code is unchanged; the knowledge subset above was run).

## F. Security, tenant isolation, billing, residency
- Containment is proved by tests that use deliberately hostile threads and hostile inputs: the test process stayed alive and the pool kept serving after every failure mode. A thread has no secrets: an environment test sets a variable in the parent and shows the thread sees none.
- Tenant isolation, quarantine, two-person approval, audit and the append-only evidence rules are untouched (no change to tables, policies or grants). The worker still writes everything in one transaction and only for a version in `ANALYZING`.
- Billing, metering, residency: not touched (no vendor call).
- Known gaps: no OS-level boundary (seccomp or a container; a deployment concern); wall time stands in for CPU time; the worker still does not write to the hash-chained audit log.

## G. Human gates and live checks still needed
- **D-42 (BLOCKS production)**: provider, region, retention, bucket policy, vault credentials, `selfTest()` against the real bucket, attestation `HG-…`. None can be done by an agent, none was bypassed, and the guards of `resolveKnowledgeStore` are unchanged and still tested. Production uploads, ingestion, detection and component analysis stay off.
- **D-45**: approach decided; the grammar's selection, licence, pin and build provenance, and the dependency review, need the owner's go-ahead (see `D-42-D-45-status.md`). The grammar will run inside this sandbox.
- D-43 (counsel review for commercial themes), D-44 (no malware-scanning claim), D-21 (no browser/build sandbox: blocks rendering and screenshots) unchanged.

## H. Acceptance checklist
| Criterion | Status |
|---|---|
| Parsing in isolated threads with CPU/time, memory, file-size and AST-node limits | PASS (CPU = wall clock per file, stated) |
| Cancellation, thread termination, safe failure handling | PASS |
| Hostile-input, timeout and concurrency tests | PASS (32 unit, 7 integration) |
| S-K1, S-K2a, S-K2b, S-K2c behaviour preserved | PASS (worker 73, API knowledge 57, domain 747, admin 329, adapter 26) |
| Browser E2E of the ingestion flow | PASS (8/8) |
| D-42 and D-45 documented without bypassing production gates | PASS (documents) / D-42 BLOCKED (human gate), D-45 grammar NOT BUILT (owner go-ahead needed) |
| Unrelated work of other sessions untouched | PASS (`M12-tenant-sweep.json` and other sessions' files not staged) |

## I. Handoff
S-K4 (Design DNA and theme intelligence) is prepared in `docs/ai-intelligence/S-K4-PREP.md`: scope, inputs from S-K2c, proposals, acceptance criteria and dependencies. It can start without the Dart grammar and without D-42. Open decisions for the owner: go-ahead for S-K4; dependency review for the tree-sitter grammar (D-45); D-42 items.
