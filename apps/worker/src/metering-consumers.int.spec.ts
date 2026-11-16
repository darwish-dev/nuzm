import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, emitUsage, eventId, usageEventId, type UsageEvent } from '@nuzm/platform';
import { ORG_A, ORG_B, createEnv, type TestEnv } from '@nuzm/platform/testing';
import { makePartitionJob, usageIngestor } from './metering-consumers';

let env: TestEnv;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const at = (hours: number) => new Date(monthStart.getTime() + hours * 3_600_000).toISOString();
const RES = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const event = (org: string, over: Partial<UsageEvent> = {}): UsageEvent => {
  const windowStart = over.windowStart ?? at(1);
  const base = {
    orgId: org,
    meterId: 'compute.vcpu_hours',
    quantity: '2',
    unit: 'vcpu_hour',
    resourceId: RES,
    windowStart,
    windowEnd: new Date(Date.parse(windowStart) + 3_600_000).toISOString(),
    occurredAt: new Date().toISOString(),
    dimensions: { region: 'sa-central' },
    dataRegion: 'sa-pending',
    source: 'compute@M05',
    ...over,
  };
  return { eventId: usageEventId(base), ...base };
};
const emit = (org: string, e: UsageEvent) => env.app.withOrg(org, (c) => emitUsage(c, e));
const drain = (log: unknown[] = []) =>
  new OutboxRelay(env.worker, { batch: 50, lockSeconds: 30 }).runOnce((row) =>
    usageIngestor(env.worker, (m, x) => log.push({ m, ...x }))(row.payload, {
      eventId: eventId(row),
      orgId: row.org_id,
    }),
  );
const count = async (org: string) =>
  Number(
    (await env.sql(`SELECT count(*)::int n FROM metering.usage_events WHERE org_id=$1`, [org]))[0]!
      .n,
  );
const agg = async (org: string) =>
  (await env.sql(
    `SELECT quantity::text q, event_count FROM metering.usage_aggregates WHERE org_id=$1 AND meter_id='compute.vcpu_hours'`,
    [org],
  )) as { q: string; event_count: number }[];

describe('usage.recorded consumer (outbox → nuzm_worker → metering.ingest + aggregate)', () => {
  it('stores the event, aggregates it, and redelivery is a no-op', async () => {
    const e = event(ORG_A);
    await emit(ORG_A, e);
    expect(await drain()).toEqual({ delivered: 1, failed: 0 });
    expect(await count(ORG_A)).toBe(1);
    expect(await agg(ORG_A)).toEqual([{ q: '2.00000000', event_count: 1 }]);
    // at-least-once: the same fact again dedupes and does not double-count
    await emit(ORG_A, e);
    expect(await drain()).toEqual({ delivered: 1, failed: 0 });
    expect(await count(ORG_A)).toBe(1);
    expect((await agg(ORG_A))[0]!.q).toBe('2.00000000');
  });

  it('takes the organization from the outbox row, never from the payload', async () => {
    // a producer in org B's context cannot even enqueue an event for org A (RLS on the outbox)
    await expect(emit(ORG_B, event(ORG_A, { windowStart: at(5) }))).rejects.toThrow(
      /row-level security/,
    );
    // and if a payload ever disagrees with the row, the row's organization wins
    const hostile = event(ORG_A, { windowStart: at(6) });
    await usageIngestor(env.worker)(hostile, { eventId: 'x', orgId: ORG_B });
    const where = `window_start=$2 AND event_id=$3`;
    const n = async (org: string) =>
      (
        await env.sql(
          `SELECT count(*)::int n FROM metering.usage_events WHERE org_id=$1 AND ${where}`,
          [org, at(6), hostile.eventId],
        )
      )[0]!.n;
    expect(await n(ORG_A)).toBe(0);
    expect(await n(ORG_B)).toBe(1);
  });

  it('acknowledges permanent rejections (logged) instead of retrying forever', async () => {
    const log: unknown[] = [];
    await emit(ORG_A, event(ORG_A, { meterId: 'no.such_meter', windowStart: at(7) }));
    expect(await drain(log)).toEqual({ delivered: 1, failed: 0 });
    expect(log.some((l) => (l as { m: string }).m === 'usage_event_rejected')).toBe(true);
    expect(
      (
        await env.sql(
          `SELECT count(*)::int n FROM metering.usage_events WHERE org_id=$1 AND window_start=$2`,
          [ORG_A, at(7)],
        )
      )[0]!.n,
    ).toBe(0);
  });

  it('the worker role cannot write usage events directly', async () => {
    await expect(
      env.worker.withOrg(ORG_A, (c) =>
        c.query(`DELETE FROM metering.usage_events WHERE org_id = $1`, [ORG_A]),
      ),
    ).rejects.toThrow();
  });
});

describe('partition job', () => {
  it('creates partitions ahead, at most once per interval, and is idempotent', async () => {
    let t = 1_000_000;
    const log: string[] = [];
    const job = makePartitionJob(env.worker, {
      everyMs: 60_000,
      monthsAhead: 14,
      now: () => t,
      log: (m) => log.push(m),
    });
    await job();
    const parts = async () =>
      Number(
        (
          await env.sql(
            `SELECT count(*)::int n FROM pg_inherits WHERE inhparent='metering.usage_events'::regclass`,
          )
        )[0]!.n,
      );
    const after = await parts();
    await job(); // within the interval: skipped
    t += 61_000;
    await job(); // due again: nothing left to create
    expect(await parts()).toBe(after);
    expect(log.filter((m) => m === 'usage_partitions_created').length).toBeLessThanOrEqual(1);
  });
});
