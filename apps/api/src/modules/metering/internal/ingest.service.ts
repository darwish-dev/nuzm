import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { Producer } from './producer-auth';

export interface IngestResult {
  index: number;
  eventId: string | null;
  result: 'accepted' | 'duplicate' | 'rejected';
  reason: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validation, dedupe and the late/skew policy live in `metering.ingest()` (SQL), so the API endpoint and the outbox
 * consumer in the worker share exactly one implementation. This service adds what only the caller knows: which
 * organizations a producer may report for (trusted context, never the request body), batching per organization, and
 * the aggregation of the buckets that the accepted events touch.
 */
export class MeteringIngestService {
  constructor(
    private readonly db: Db,
    /** Runs after an organization's events were stored and aggregated (best effort; must not throw). */
    private readonly afterAggregate: (orgId: string) => Promise<void> = async () => undefined,
  ) {}

  async ingest(
    events: unknown,
    producer: Producer,
  ): Promise<{ results: IngestResult[]; summary: Record<string, number> }> {
    if (!Array.isArray(events) || events.length < 1 || events.length > 500)
      throw new ProblemException('validation_failed', 'events must be an array of 1..500 events');
    const results: IngestResult[] = events.map((e, i) => ({
      index: i,
      eventId:
        typeof (e as { eventId?: unknown })?.eventId === 'string'
          ? (e as { eventId: string }).eventId
          : null,
      result: 'rejected',
      reason: null,
    }));
    const byOrg = new Map<string, number[]>();
    events.forEach((e, i) => {
      const org = (e as { orgId?: unknown } | null)?.orgId;
      if (typeof e !== 'object' || e === null || typeof org !== 'string' || !UUID.test(org)) {
        results[i]!.reason = 'invalid_id';
        return;
      }
      const o = org.toLowerCase();
      if (producer.orgIds && !producer.orgIds.includes(o)) {
        results[i]!.reason = 'org_not_permitted'; // spoofed orgId: the key is not scoped to this organization
        return;
      }
      (byOrg.get(o) ?? byOrg.set(o, []).get(o)!).push(i);
    });
    for (const [org, idxs] of byOrg) {
      const batch = idxs.map((i) => events[i]);
      const rows = await this.db.withOrg(org, async (c) => {
        const r = (
          await c.query<{
            idx: number;
            event_id: string | null;
            result: IngestResult['result'];
            reason: string | null;
          }>('SELECT * FROM metering.ingest($1::jsonb, $2)', [
            JSON.stringify(batch),
            producer.source,
          ])
        ).rows;
        const accepted = r
          .filter((x) => x.result === 'accepted')
          .map((x) => (batch[x.idx] as { eventId: string }).eventId);
        // recompute exactly the buckets these events were STORED in (an adjustment lives in the corrected event's window)
        if (accepted.length)
          await c.query('SELECT metering.aggregate_events($1, $2::uuid[])', [org, accepted]);
        return r;
      });
      if (rows.some((r) => r.result === 'accepted')) await this.afterAggregate(org);
      for (const r of rows) {
        const slot = results[idxs[r.idx]!]!;
        slot.result = r.result;
        slot.reason = r.reason;
      }
    }
    const summary = { accepted: 0, duplicate: 0, rejected: 0 };
    for (const r of results) summary[r.result]++;
    return { results, summary };
  }
}
