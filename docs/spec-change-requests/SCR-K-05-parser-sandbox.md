# SCR-K-05 — Parser sandbox for component analysis (AI Intelligence Center, hardening of S-K2c)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (addendum D), SCR-K-04.
No change to any endpoint, table, permission, error code or feature flag. The stage stays behind `KNOWLEDGE_COMPONENTS_ENABLED` (default off).

## 1. What changes
Parsing in the COMPONENTS stage moves from the ingestion worker's thread into a pool of isolated `worker_threads` with hard limits. The analyzers, facts, components, relationships and manifests are unchanged (a test proves the thread returns exactly what the analyzers return when called directly).

## 2. Limits (defaults; env names for the three operators may tune)
| Limit | Default | Enforced by |
|---|---|---|
| Wall clock per file | 10 000 ms (`KNOWLEDGE_PARSER_TIMEOUT_MS`) | parent timer, then `Worker.terminate()` (interrupts a synchronous run; Node 22 has no per-thread CPU accounting) |
| Heap per thread | 384 MiB old / 48 MiB young, stack 4 MiB (`KNOWLEDGE_PARSER_HEAP_MB`) | V8 `resourceLimits` (thread ends with `ERR_WORKER_OUT_OF_MEMORY`) |
| File size | 512 KiB | parent before dispatch, thread again |
| AST nodes | 400 000 (callers can only lower it) | the analyzer's budget |
| Result size | 190 000 bytes | thread; parent checks structure |
| Threads | 2, max 4 (`KNOWLEDGE_PARSER_THREADS`) | pool |
| Thread lifetime | 300 files, and after any failure | pool |
| Parsing phase | 10 min wall clock, 25 failures | stage (remaining files skipped as `deadline`) |

## 3. Isolation
Empty environment (`env: {}`), no `workerData` beyond limits, no handles, captured stdio, no file path is ever opened by a thread. Not a privilege boundary: nothing is executed.

## 4. Failure semantics
Per-file typed outcomes become skip reasons (`timeout`, `memory`, `crashed`, `deadline`; plus the existing `too_large`, `budget`, `parse_error`), reported in the architecture panel, never guessed, never cached unless deterministic. A sandbox that cannot start fails the job as transient (retry with back-off, then dead letter) and writes nothing. Cancellation and lease loss abort in-flight parses and write nothing.

## 5. Tests
Unit (32): request handler, equivalence with direct analyzers, hostile sources through a real thread, time/heap/size/node/result limits, misbehaving threads (spin, regex backtracking, heap bomb, throw, exit, wrong shape, wrong id, death while idle), empty environment, recycling, startup failures, abort in flight/queued/pre-aborted, close, concurrency and isolation between neighbours. Integration (7 new, real PostgreSQL): owned sandbox lifecycle, files stopped at limits, failure breaker, stage budget, unavailable sandbox, cancellation in flight, close on failure.

## 6. Not in this change
The tree-sitter Dart grammar (D-45), production activation (D-42), a seccomp/container boundary (deployment concern), CPU accounting beyond wall time.

## 7. Rollback
Revert the commit, or set `KNOWLEDGE_COMPONENTS_ENABLED=false` (default). No migration.
