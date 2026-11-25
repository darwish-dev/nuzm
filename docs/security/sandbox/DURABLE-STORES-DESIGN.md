# Durable stores for execution jobs and workspaces: design (NOT ENABLED, no migration exists)

Status (Phase 3, P3-S02): **implemented behind the flag, not wired.** Migrations `2310`–`2312` (`packages/db/migrations/execution/`, a new schema `execution`, nine tables) and `PgExecutionStore` (`apps/api/src/modules/execution/internal/store.ts`) exist, with integration tests on PostgreSQL through the runtime role (RLS enforced). The ownership manifest, range and classification are a Master request: `docs/phase3/sessions/CONTRACT-P3-S02-2-durable-stores.md`. Nothing constructs the store and `ai.agent.exec_tools` stays off; the original design below is kept as the rationale. The reserved ids 2140–2159 of Phase 2 stay unused. Differences from the sketch: `quota_reservations` is unique per (org, job); `kill_switch` is an append-only history (latest row wins); approvals record `decider_kind = 'human'` and the single-use rule is one atomic UPDATE; the transition guards in SQL mirror the domain's tables and a test compares every pair.

## Why durable stores at all
Phase 1 keeps the queue, the job and workspace state machines, approvals and usage in memory so the whole flow is testable. A real runtime needs them to survive a control-plane restart: queued and running jobs, single-use approvals, per-organization concurrency/quota reservations, the node registry, and an auditable history. The control plane is the source of truth for *intent and state*; the node is the source of truth for *what physically exists* (`listWorkspaces`), and the two are reconciled, never assumed equal.

## Mapping from the in-memory components
| Component (code) | Table(s) | Notes |
|---|---|---|
| `ExecutionQueue` (idempotent, bounded, fair, leases, heartbeats, expiry) | `execution.jobs` (state `queued`) + lease columns | claim with `SELECT … FOR UPDATE SKIP LOCKED`, ordered fairly across organizations; a lease is a `lease_token` + `lease_expires_at`; sweep returns expired `running` jobs to `queued` only via the allowed transition `running → queued` (lease expiry) |
| job lifecycle (12 states) | `execution.jobs.state` + `execution.job_transitions` (append-only) | the transition function stays in the domain; the table stores the result; a CHECK allows only known states |
| workspace lifecycle (6 states), `planCleanup` | `execution.workspaces` | one row per run (`workspace_id = ws-<run_id>`), node id, state; reconciled against `listWorkspaces` by `reapOrphans` after a restart |
| `ApprovalWorkflow` (digest-bound, single-use, human-only, expiring, revocable) | `execution.approvals` | single-use enforced by an atomic `UPDATE … WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`; bound to `decision_digest` |
| `QuotaLedger` reservations | `execution.quota_reservations` | integer minor units + currency; **settlement is not written here**: the billing posting service is the only writer of ledger rows (CLAUDE.md §4); this table holds the reservation and the usage record handed to billing |
| `ExecutionKillSwitch` | `execution.kill_switch` (one global row, one row per org) | audited writes; read on every submit and before every run |
| Node registry, attestation records | `execution.runtime_nodes`, `execution.attestations` | public records only (no key material): attestation id, node id, label, issued/expires, report digest, reviewer, revoked_at; the signed JSON is stored as evidence, the verifier still runs on every start and use |
| `RunAccounting` events | `execution.usage_records` | one per run; feeds the metering pipeline (`ai.sandbox_cpu_seconds`); no module bills directly |
| Audit (`ai.execution.*`) | existing `platform` audit sink | not a new table: content-free records through `ExecutionAuditAdapter` |

## Tables (sketch; names follow the schema-per-module rule, snake_case, UUIDv7 ids, UTC)
All tenant tables carry `org_id uuid not null`, `data_region text not null` (residency hook), RLS `USING (org_id = current_setting('app.org_id')::uuid)` with a forced policy, no cross-schema foreign keys, and every column classified in the data-class registry (all are `operational`; **no file content, no output text, no environment values, no secrets** are stored here: output lives in the run's own artifact/log store under D-34 retention).

```
execution.jobs            id, org_id, run_id, idempotency_key, profile, decision_digest, state, origin('MOCK'|'REAL'),
                          requires_approval, approval_id, node_id null, lease_token null, lease_expires_at null,
                          attempts, queued_at, started_at, ended_at, outcome_status null, exit_code null,
                          duration_ms null, truncated bool, artifact_count int, data_region
                          UNIQUE (org_id, idempotency_key); INDEX (state, queued_at); INDEX (org_id, state)
execution.job_transitions id, job_id, org_id, from_state, to_state, cause, at        -- append-only (no UPDATE/DELETE grant)
execution.workspaces      id (= ws-<run_id>), org_id, run_id, job_id, node_id, state, created_at, last_activity_at, destroyed_at null
execution.approvals       id, org_id, job_id, decision_digest, requested_at, expires_at, decided_by (human user id) null,
                          decided_at null, consumed_at null, revoked_at null, revoke_reason null
execution.quota_reservations id, org_id, job_id, currency, reserved_minor bigint, concurrency_slots, state('held'|'released'|'settled'), at
execution.usage_records   id, org_id, run_id, node_id, runtime_class, profile, cpu_seconds, wall_ms, peak_memory_mb, peak_pids, disk_mb,
                          output_bytes, status, estimated_minor bigint, currency, billed bool
execution.runtime_nodes   id, node_id, endpoint_id, environment('staging'|'production'), runtime_class, state('admitted'|'quarantined'|'dropped'|'retired'),
                          quarantine_reason null, admitted_at       -- no org_id: platform-scoped, admin-only RLS
execution.attestations    id, attestation_id, node_id, label, issued_at, expires_at, report_sha256, reviewer, review_ref, revoked_at null, evidence_ref
execution.kill_switch     scope('global'|'org'), org_id null, engaged bool, by_user_id, at, reason_code
```

## Invariants the database enforces (in addition to the domain code)
- `job_transitions` and the audit trail are append-only; corrections are new rows.
- `UNIQUE (org_id, idempotency_key)` makes `submit` idempotent across restarts; a replay returns the stored job.
- Approvals cannot be consumed twice, after expiry or after revocation (single atomic statement); a service account / API key can never be `decided_by` (human-only; see DEFECT-6 for the existing run-approval path).
- No row can point a job at a node that is `quarantined`/`dropped` for a *new* claim (checked in the claim query).
- Retention: terminal jobs and their transitions kept per D-34 (owner decision); workspaces rows deleted after destruction plus a grace; usage records kept per billing retention.

## Restart and reconciliation (no database needed to understand; needed to build)
1. On start: `expire leases` → return `running` jobs with expired leases to `queued` (allowed transition) or mark `terminated` if the approval/kill switch no longer allows them.
2. `RealRuntimeService.reapOrphans()` against every node: workspaces the node holds that no live `running` job owns are destroyed after the grace period; reconcile `execution.workspaces` to what `listWorkspaces` returns (a row without a physical workspace is marked `destroyed`; a physical workspace without a row is an orphan and is reaped).
3. Uncertain results (a timeout talking to a node) **reconcile before retry** (CLAUDE.md §4): ask the node for the workspace and run state, never re-run blindly.

## Rollback note (for the future migration)
Forward-only expand/contract: the schema is additive (a new `execution` schema with new tables only). Reversal = drop the schema after the flag is off and the queue is drained; no existing table changes. A draft of the DDL is deliberately **not** committed as a `.sql` migration; it is created with the next free id in 2140–2159 under a Master-approved `CONTRACT-*` when D-21 is decided.
