# ADR-017: Billing scheduler runs inside the API process under an advisory lock

- Status: **Proposed - OPEN** (not binding until accepted by the owner). Related: ADR-001 (modular monolith plus worker processes), ADR-007 (durable operations), M03 S10c.
- Source: S10b/S10c reports (the scheduler question left open by S10a).

## Context
Subscription renewal, dunning, the PSP event sweeper and the pending-refund sweeper must run periodically. ADR-001 places background work in worker processes, but `apps/worker` depends only on `@nuzm/platform`: the billing, invoicing and payments services live in `apps/api` and cannot be imported by the worker without restructuring the repository.

## Decision (proposed default)
A `BillingScheduler` in the API process runs one tick every `BILLING_SCHEDULER_INTERVAL_SECONDS` (0 = off, the default; minimum 5). A tick takes `pg_try_advisory_xact_lock(7300002)` so only one API instance does the work; the other skips. Every job is idempotent (period advance is a compare-and-set, invoices are keyed by their source, payments and refunds are reconcile-before-retry, dunning stages move forward atomically with their outbox request), so a missed tick, a repeated tick or two ticks at once never double-charge or double-notify.

## Alternatives considered
1. **Move the billing services into a shared package** (`packages/billing`) used by both API and worker: the clean long-term shape, a large refactor with no functional gain today.
2. **Worker calls an internal API endpoint** (service key) that runs a tick: needs a new operation in docs/04 and an extra network hop.
3. **BullMQ/Temporal** (ADR-007): requires Redis (not installed in dev) and the D-03 decision.

## Consequences
- The API process carries background work; run the scheduler on one designated instance, or all (the lock serializes them).
- When `packages/billing` exists (alternative 1) the scheduler moves to the worker unchanged: it already depends on ports, not on Nest.
- Production start-up must set the interval; a deployment without it silently stops renewals and dunning (a health/alert item for M12).

## Owner / date
OWNER-PLACEHOLDER / —
