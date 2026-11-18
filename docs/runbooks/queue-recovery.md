# Runbook — queue, outbox and operation recovery (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED. Facts below come from `packages/platform/src/outbox.ts`, `operations.ts` and `apps/worker/src/main.ts` on this branch. Endpoints marked *(planned)* are not yet in `spec/openapi/openapi.yaml`.

## Purpose
Recover when events or long-running work stop moving: a stalled outbox relay, a growing backlog, operations stuck in `running`, `waiting_provider` or `needs_reconcile`, or loss of a cache/queue service.

## What the queues are today (read first)
- **Durable queues are PostgreSQL tables.** `platform.outbox` (transactional outbox) is delivered by the worker's `OutboxRelay` (batch 50, lock 60 s); delivery is **at-least-once**, handlers must dedupe on the event id. `platform.operations` holds durable operations with leases (default 60 s), backoff, cancellation and the `needs_reconcile` hand-off.
- A Redis/BullMQ queue is part of the proposed stack, but no BullMQ or Redis client dependency was found in the repository's package manifests on this branch, and Redis is "once installed" in `CLAUDE.md`. Treat any Redis loss as: nothing authoritative lives there; to be confirmed when it is introduced.
- Outbox rows for a topic with no subscriber are acknowledged after a `no_subscriber` log line (so the table does not grow unbounded). A failed handler leaves the row locked until the lock expires, then it is redelivered.
- An operation whose lease expired while `waiting_provider` becomes `needs_reconcile`: the provider-side effect is unknown and **must be reconciled, never retried blindly**.

## Trigger / alert
Backlog or lag on the health view (`GET /v1/admin/operations/health`, *planned*: queue lag, reconciler last run); worker log lines `worker tick failed` or repeating `outbox_batch` with `failed > 0`; no `outbox_batch` or `started` line after a deploy; wallet projection drift (RC-06); customers reporting operations that never finish; stale `ledger.posted` or `usage.recorded` consumers.

## Severity guidance (proposal)
SEV2: relay or operation processing down and growing; SEV1 if ledger, metering or money consumers are behind long enough to affect billing integrity or if events appear lost. SEV3: a single consumer lagging with a workaround.

## Preconditions / access
Operator access to the worker process supervisor and logs (environment specific: to be confirmed; locally `pnpm services:status`). Admin realm with MFA for any admin API action. Database access is by runtime roles only; break-glass follows `break-glass-draft.md` and is BLOCKED (D-12).

## Steps
1. **Is the worker alive?** The worker needs `WORKER_DATABASE_URL` (role `nuzm_worker`) and exits with code 2 without it. Check for `{"worker":"started"}` and recent `outbox_batch` or `no_subscriber` lines. Restart the process under the supervisor; the relay and the claim loop are crash-safe by design (locks and leases expire).
2. **Is the database healthy?** `db-failover.md`; a worker cannot claim when the primary is down.
3. **Read the backlog through supported views only:** per organization `GET /v1/operations` (customer, `operation:read`); cross-organization queue lag via the health view *(planned)*. Do not UPDATE or DELETE `platform.outbox` or `platform.operations` rows by hand.
4. **Failing handler.** A topic with `failed > 0` on every batch means a poison event or a bug. Capture the topic and event id (no payload in tickets), fix the handler, deploy; the row is redelivered after its lock expires. Handlers are idempotent (`eventId`), so redelivery is safe.
5. **Stuck operations.**
   - `running` with an expired lease: the next claim reclaims it; nothing to do except keeping a worker running.
   - `needs_reconcile`: run the reconciler (`CLOUD_RECONCILE_INTERVAL_SECONDS` on) or `POST /v1/admin/resources/{id}/reconciliations` (202; poll `GET /v1/admin/provider-jobs/{id}`). Domains: `POST /v1/admin/domains/{id}/reconciliations`. Hosting: `site-recovery.md`. Never retry by hand.
   - Cancellation: `POST /v1/operations/{id}/cancellation` (customer permission `operation:cancel`); a create cancelled before it ran is compensated.
6. **Redis or cache lost (when present).** Restart it; confirm the outbox and operations continue; any derived state is rebuilt from Postgres: `rebuild-projections.md` (wallet balance, `billing.refresh_wallet`) and `metering-replay.md` (usage aggregates).
7. **Replay safety check.** After a long outage expect a burst of redeliveries; verify duplicates were deduped (`metering-replay.md`, RC-06, RC-02).

## Verification
Backlog trending to zero; `outbox_batch` lines with `failed: 0`; no operation older than the stuck threshold in `needs_reconcile`; wallet projection equals the ledger (drift query in `ledger-inspection.md`); `verify_aggregates` reports no drift; RC-06 clean. M12 chaos target: 0 lost events, duplicates deduped.

## Escalation
L2 on-call engineer immediately for SEV1/2; L3 platform owner if the cause is a handler bug or a schema issue; finance lead if billing consumers were behind; security officer if events were tampered with.

## Communication draft
EN: "Some actions in your account are taking longer than usual to complete. No data was lost. Pending actions will complete automatically; please do not repeat them. We will update you by [time] UTC. Reference: [incident id]."
AR: "تستغرق بعض الإجراءات في حسابكم وقتًا أطول من المعتاد. لم تُفقد أي بيانات. ستكتمل الإجراءات المعلّقة تلقائيًا، فنرجو عدم تكرارها. سنوافيكم بالمستجدات قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."

## Records to keep
Incident timeline with the backlog size at start, at mitigation and at drain; handler fix reference; reconciliation results; the RC-06 / drift query output; audit events of any admin action.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Planned drill: queue/Redis-loss and worker-crash chaos cases (M12 §11): 0 lost outbox events, duplicates deduped.
