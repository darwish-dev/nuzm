# Runbook: metering replay and aggregate verification

Scope: `metering.usage_events` (immutable, partitioned by month) → `metering.usage_aggregates` (derived, rebuildable).
Status: written against the S06 implementation, exercised in `metering.int.spec.ts` (replay and heal tests). **Not run against production data** (none exists).

## When to use
- `verify_aggregates` reports a row where `stored <> recomputed` (drift, manual tampering, a failed consumer).
- A producer re-sent a batch (safe: `eventId` dedupes, nothing changes) or a bug in aggregation was fixed.
- An org's usage looks wrong and you need to prove whether the raw events or the aggregates are at fault.

## Facts to rely on
- Raw events are never updated or deleted (trigger `metering.deny_mutation`). Corrections are *adjustment events* (`adjustsEventId`) that net against the original in the original's window.
- Aggregates are a pure function of the events: `metering.aggregate(org, from, to)` recomputes every bucket in the window and only writes buckets whose content hash changed. **Replay is a no-op when nothing drifted** (returns 0 changed buckets).
- Late events (arriving after month end + 72 h) are billed in the current open month (`late = true`); events with clock skew are flagged `skew_flag`, never silently shifted.
- Rating output (`rated_usage`) is separate; replaying aggregates does not touch it. Re-rating is a new run that writes correction deltas (see `pricebook-release.md`).

## Procedure
1. Identify the organization (`org_id`) and window. Use UTC.
2. Verify (read only; run as the reporting role or a platform-scope session):
   ```sql
   SELECT * FROM metering.verify_aggregates('<org-uuid>') WHERE stored <> recomputed;
   ```
   No rows = aggregates are consistent with events. Stop here.
3. Replay the window (org context set by the service/`withOrg`, never from user input):
   ```sql
   SELECT metering.aggregate('<org-uuid>', '<from-utc>', '<to-utc>');   -- returns number of buckets changed
   ```
   To target specific events only: `SELECT metering.aggregate_events('<org-uuid>', ARRAY['<event-uuid>']::uuid[]);`
4. Re-run step 2; expect zero rows. Record the changed count and the before/after rows in the incident note.
5. If step 2 still reports rows after a replay, the *events* are the problem: do not edit them. Post an adjustment event through the ingest path and replay again. Escalate to the metering owner.

## Dead-lettered `usage.recorded` events
The worker acknowledges permanent rejections (unknown meter, forbidden dimension) and logs `usage_event_rejected` with the reason; only internal errors are retried. To find them: search worker logs for `usage_event_rejected`. Fix the producer, then re-send; dedupe makes re-sending safe.

## Partitions
The worker keeps six months of `usage_events` partitions ahead (`metering.ensure_usage_partitions`). Events outside every partition land in the default partition (never lost). If the default partition is non-empty, run `SELECT metering.ensure_usage_partitions(current_date, 6);` and file a follow-up to move the rows (forward fix, not a delete).
