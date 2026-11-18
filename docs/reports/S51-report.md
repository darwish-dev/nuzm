# S51 report — Workflow engine (M11)

Status: **IMPLEMENTED; local evidence only. AI-run and deployment actions are NOT VERIFIED (M09 not on this base).** Branch `claude/m11-automation-2a587e`.

## What was built
- **Definition and versions** (`packages/domain/src/automation/workflow-schema.ts`, `workflows`/`workflow_versions` in migration 1600): JSON DAG validated at publish (schema, cycles, reachability, ≤ 100 steps, bounded loops ≤ 100 iterations, every expression parsed, literal credentials refused, connector references checked against the organization). Versions are immutable (trigger + no UPDATE/DELETE grant).
- **Restricted expression language** (`expression.ts`): tokenizer + parser + interpreter, no eval, fixed pure function table (null-prototype), prototype-path refusal, length/depth/step limits.
- **Triggers** (`trigger.service.ts`, `apps/worker/src/automation-consumers.ts`): schedule (cron, UTC or IANA zone, slot-deduped), inbound webhook (secret URL + HMAC + 5 min window + event-id dedupe), platform events (allow-listed outbox topics, worker consumer, chain depth), manual.
- **Engine** (`engine.ts`) on `platform.operations`: persisted cursor + one row per attempt; per-step idempotency key `sha256(rootExecutionId|stepKey|attemptGroup)`; backoff + jitter (default 5 attempts); durable delay; retry via `defer` (new `OperationsService.defer`/`finishCancelled`); dead letters; cancellation; per-org concurrency cap; kill switch (paused workflow stops at the next step); secrets redacted before persistence.
- **Metering**: `automation.executions` at start (id = execution), `automation.steps` per succeeded billable attempt, in the step's transaction (outbox); quota group `automation` mapped (no limit until HG-02-01).
- **Abuse rules** (`abuse.service.ts`): spike, high 4xx rate, over-deep chain → pause + case + notice + audit.

## Evidence (this session's runs; DB on :54353)
- `@nuzm/domain` unit tests: 46 passed (expression 8, workflow schema 10, SSRF 10, signing/retry/limits/cron 18).
- `automation.int.spec.ts` 11 passed, `automation-faults.int.spec.ts` 16 passed (**AC-M11-01: 210 seeded fault runs, 0 duplicate effects**, ≥ 100 simulated worker kills, steps retried; **AC-M11-02: 31 connector fixtures**), `automation-triggers.int.spec.ts` 15 passed, worker `automation-consumers.int.spec.ts` 4 passed.
- Non-idempotent POST: attempted once; killed inside the call → `uncertain_outcome` dead letter, never retried; with an idempotency-key mapping it is retried and carries the key.

## Not verified / not done
- Real AI runs and deployments (ports unavailable by default); real network egress proxy (in-process SSRF guard only); multi-instance behaviour of in-memory rate limits; load targets (1,000 concurrent executions, 100/s start rate, p95 ≤ 5 s) NOT RUN; DSR erasure and retention purge of execution inputs/outputs (D-34) NOT IMPLEMENTED.
