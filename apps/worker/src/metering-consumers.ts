import type { Db } from '@nuzm/platform';

export type IngestLog = (m: string, x?: Record<string, unknown>) => void;

/**
 * Outbox consumer for `usage.recorded` (producers that run inside the platform emit with `emitUsage()`). The organization
 * comes from the OUTBOX ROW (written in the producer's own org context), never from the payload, so a producer cannot
 * claim another tenant's usage. Delivery is at-least-once; `metering.ingest` dedupes. Permanent rejections (bad meter,
 * forbidden dimension...) are logged and acknowledged — retrying cannot fix them; only internal errors are retried.
 */
export function usageIngestor(db: Db, log: IngestLog = () => undefined) {
  return async (payload: unknown, meta: { eventId: string; orgId: string }): Promise<void> => {
    const e = (payload ?? {}) as { source?: string; windowStart?: string; windowEnd?: string };
    if (typeof e.source !== 'string') {
      log('usage_event_rejected', { reason: 'missing_source', eventId: meta.eventId });
      return;
    }
    const event: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
      orgId: meta.orgId,
    };
    const r = await db.withOrg(meta.orgId, async (c) => {
      const row = (
        await c.query<{ result: string; reason: string | null }>(
          'SELECT * FROM metering.ingest($1::jsonb, $2)',
          [JSON.stringify([event]), e.source],
        )
      ).rows[0]!;
      if (row.result === 'accepted')
        await c.query('SELECT metering.aggregate_events($1, $2::uuid[])', [
          meta.orgId,
          [String(event.eventId)],
        ]);
      return row;
    });
    if (r.result === 'rejected') {
      if (r.reason?.startsWith('internal:')) throw new Error(`usage ingest failed: ${r.reason}`); // retry
      log('usage_event_rejected', { reason: r.reason, eventId: meta.eventId, orgId: meta.orgId });
    }
  };
}

/** Keep monthly `usage_events` partitions created ahead (at most once per interval). Returns how many were created. */
export function makePartitionJob(
  db: Pick<Db, 'withoutScope'>,
  opts: { everyMs: number; monthsAhead?: number; now?: () => number; log?: IngestLog },
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    if (now() - last < opts.everyMs) return;
    last = now();
    const n = await db.withoutScope(
      async (c) =>
        (
          await c.query<{ n: number }>(
            'SELECT metering.ensure_usage_partitions(current_date, $1) AS n',
            [opts.monthsAhead ?? 6],
          )
        ).rows[0]!.n,
    );
    if (n) opts.log?.('usage_partitions_created', { created: n });
  };
}
