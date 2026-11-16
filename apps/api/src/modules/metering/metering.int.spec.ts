import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { usageEventId } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { LedgerPostingService } from '../billing';
import { MeteringIngestService, ProviderCostService, RatingService } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY_ANY = 'nzm_src_test_any_organization_key_0001';
const KEY_A = 'nzm_src_test_org_a_only_key_000000002';

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const web: Record<string, Record<string, string>> = {};
const adm: Record<string, Record<string, string>> = {};

const item = (meterId: string, over: Row = {}) => ({
  meterId,
  tierModel: 'flat',
  unitPriceMinor: '8',
  includedAllowance: '0',
  rounding: 'half_up',
  ...over,
});

const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const PERIOD = monthStart.toISOString().slice(0, 10);
const at = (hours: number) => new Date(monthStart.getTime() + hours * 3_600_000).toISOString();

const baseEvent = (org: string, over: Row = {}): Row => {
  const windowStart = over.windowStart ?? at(1);
  const e: Row = {
    orgId: org,
    meterId: 'compute.vcpu_hours',
    quantity: '2',
    unit: 'vcpu_hour',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    windowStart,
    windowEnd: new Date(Date.parse(windowStart) + 3_600_000).toISOString(),
    occurredAt: new Date().toISOString(),
    dimensions: { region: 'sa-central' },
    dataRegion: 'sa-pending',
    ...over,
  };
  e.eventId ??= usageEventId({
    orgId: org,
    meterId: e.meterId,
    resourceId: e.resourceId,
    windowStart: e.windowStart,
    sourceSeq: over.seq,
  });
  delete e.seq;
  return e;
};
const post = (key: string | undefined, events: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/internal/metering/events',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
    },
    payload: { events } as object,
  });
const ingest = async (events: Row[], key = KEY_ANY) =>
  (await post(key, events)).json() as { results: Row[]; summary: Row };
const as = (
  jar: Record<string, string>,
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  org?: string,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jar),
      'x-csrf-token': jar.nuzm_csrf ?? jar.nuzm_admin_csrf ?? '',
      ...(org ? { 'x-nuzm-org': org } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
const admin = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
  as(adm[who]!, method, url, body);
const events = async (org: string, where = 'true') =>
  (await h.env.sql(
    `SELECT *, billing_period_start::text AS bp FROM metering.usage_events WHERE org_id = $1 AND ${where} ORDER BY window_start, event_id`,
    [org],
  )) as Row[];
const aggs = async (org: string, meter: string) =>
  (await h.env.sql(
    `SELECT resource_key, granularity, bucket_start, quantity::text q, event_count, billing_period_start::text bp FROM metering.usage_aggregates WHERE org_id=$1 AND meter_id=$2 ORDER BY bucket_start`,
    [org, meter],
  )) as Row[];

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp(
    {
      METERING_SOURCE_KEYS: JSON.stringify([
        { source: 'compute@M05', sha256: sha(KEY_ANY) },
        // org A only: filled after the org exists (see below) — the config is read at module init, so use a placeholder uuid first
      ]),
    },
    undefined,
    [],
    { realAudit: true },
  ));
});
afterAll(() => h.close());

describe('setup', () => {
  it('creates organizations and staff; a key scoped to one org is configured in a second app', async () => {
    for (const n of ['alice', 'bob']) {
      ids[n] = await h.createUser(n);
      web[n] = await h.sessionFor(app, ids[n]!);
    }
    orgA = (await as(web.alice!, 'POST', '/v1/organizations', { name: 'Metering A' })).json().id;
    orgB = (await as(web.bob!, 'POST', '/v1/organizations', { name: 'Metering B' })).json().id;
    for (const [name, roles] of Object.entries({
      fin: ['finance'],
      sup: ['support'],
      root: ['platform_admin'],
      fin2: ['finance'],
    })) {
      const u = await h.platformUser(app, `staff-${name}`, roles);
      ids[name] = u.id;
      adm[name] = u.jar;
    }
    expect(orgA).toBeTruthy();
    expect(orgB).toBeTruthy();
  });
});

describe('internal endpoint authentication and org scoping', () => {
  it('refuses missing and wrong keys (401) and never reveals which', async () => {
    expect((await post(undefined, [baseEvent(orgA)])).statusCode).toBe(401);
    expect((await post('nzm_src_wrong', [baseEvent(orgA)])).statusCode).toBe(401);
    expect((await post(KEY_ANY, [baseEvent(orgA)])).statusCode).toBe(200);
    // a user session is not a producer credential
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/metering/events',
      headers: { cookie: cookieHeader(web.alice!), 'x-csrf-token': web.alice!.nuzm_csrf! },
      payload: { events: [baseEvent(orgA)] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('is unavailable (503) when no producer keys are configured, and validates the batch shape', async () => {
    const bare = await h.buildApp({ METERING_SOURCE_KEYS: '' }, undefined, [], { realAudit: true });
    const r = await bare.app.inject({
      method: 'POST',
      url: '/v1/internal/metering/events',
      headers: { authorization: `Bearer ${KEY_ANY}` },
      payload: { events: [baseEvent(orgA)] },
    });
    expect(r.statusCode).toBe(503);
    expect((await post(KEY_ANY, [])).statusCode).toBe(422);
    expect(
      (
        await post(
          KEY_ANY,
          Array.from({ length: 501 }, () => baseEvent(orgA)),
        )
      ).statusCode,
    ).toBe(422);
    expect((await post(KEY_ANY, 'nope')).statusCode).toBe(422);
  });

  it('a key scoped to one organization rejects events for another (spoofed orgId) and the body cannot choose the source', async () => {
    const scoped = await h.buildApp(
      {
        METERING_SOURCE_KEYS: JSON.stringify([
          { source: 'agent@M06', sha256: sha(KEY_A), orgIds: [orgA] },
        ]),
      },
      undefined,
      [],
      { realAudit: true },
    );
    const res = await scoped.app.inject({
      method: 'POST',
      url: '/v1/internal/metering/events',
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: {
        events: [
          baseEvent(orgA, { seq: 'scoped-a' }),
          baseEvent(orgB, { seq: 'scoped-b' }),
          { ...baseEvent(orgA, { seq: 'scoped-c' }), source: 'evil@M99' },
        ],
      },
    });
    const body = res.json();
    expect(body.results.map((r: Row) => [r.result, r.reason])).toEqual([
      ['accepted', null],
      ['rejected', 'org_not_permitted'],
      ['accepted', null],
    ]);
    expect((await events(orgB, `source = 'agent@M06'`)).length).toBe(0); // nothing landed in B
    expect((await events(orgA, `source = 'agent@M06'`)).length).toBe(2); // source is the key's, not the body's
    expect((await events(orgA, `source = 'evil@M99'`)).length).toBe(0);
  });

  it('runtime roles cannot write usage tables directly; events are append-only even for the owner', async () => {
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(
          `INSERT INTO metering.usage_events (org_id, event_id, meter_id, quantity, unit, window_start, window_end, occurred_at, source, data_region, billing_period_start, payload_hash) VALUES ($1, gen_random_uuid(), 'compute.vcpu_hours', 1, 'vcpu_hour', now(), now(), now(), 'x@M01', 'sa', current_date, 'h')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(
          `INSERT INTO metering.usage_aggregates (org_id, meter_id, resource_key, granularity, bucket_start, billing_period_start, quantity, event_count, content_hash, data_region) VALUES ($1,'compute.vcpu_hours','', 'hour', now(), current_date, 1, 1, 'h', 'sa')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(h.env.sql(`UPDATE metering.usage_events SET quantity = 999`)).rejects.toThrow(
      /append-only/,
    );
    await expect(h.env.sql(`DELETE FROM metering.usage_events`)).rejects.toThrow(/append-only/);
    await expect(h.env.sql(`TRUNCATE metering.usage_events`)).rejects.toThrow(/append-only/);
  });
});

describe('ingest fixtures (docs/12 §12)', () => {
  const resource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('duplicate_event_no_effect: the same event twice → one row, second is a duplicate', async () => {
    const e = baseEvent(orgA, { resourceId: resource, quantity: '3' });
    const first = await ingest([e]);
    const second = await ingest([e, e]);
    expect(first.results[0]).toMatchObject({ result: 'accepted' });
    expect(second.results.map((r) => r.result)).toEqual(['duplicate', 'duplicate']);
    expect((await events(orgA, `resource_id = '${resource}'`)).length).toBe(1);
    expect(
      (await aggs(orgA, 'compute.vcpu_hours')).find((a) => a.resource_key === resource),
    ).toMatchObject({ q: '3.00000000', event_count: 1 });
  });

  it('AC-M02-03: 1,000+ replayed duplicates change nothing (events, aggregates, counts)', async () => {
    const res = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const distinct = Array.from({ length: 50 }, (_, i) =>
      baseEvent(orgA, {
        resourceId: res,
        windowStart: at(200 + i),
        quantity: '2',
        seq: `dup-${i}`,
      }),
    );
    const first = await ingest(distinct);
    expect(first.summary).toMatchObject({ accepted: 50, duplicate: 0 });
    const before = (await aggs(orgA, 'compute.vcpu_hours')).filter((a) => a.resource_key === res);
    let duplicates = 0;
    for (let round = 0; round < 2; round++)
      for (let k = 0; k < 10; k++) {
        const batch = Array.from({ length: 50 }, (_, i) => distinct[i]!); // 10 x 50 = 500 per round
        const r = await ingest(batch);
        duplicates += r.summary.duplicate;
        expect(r.summary).toMatchObject({ accepted: 0, rejected: 0 });
      }
    expect(duplicates).toBe(1000);
    expect((await events(orgA, `resource_id = '${res}'`)).length).toBe(50);
    expect((await aggs(orgA, 'compute.vcpu_hours')).filter((a) => a.resource_key === res)).toEqual(
      before,
    );
  });

  it('the same eventId with a DIFFERENT payload is rejected (event_id_conflict), not silently merged', async () => {
    const e = baseEvent(orgA, { resourceId: resource, quantity: '3' });
    const r = await ingest([{ ...e, quantity: '9' }]);
    expect(r.results[0]).toMatchObject({ result: 'rejected', reason: 'event_id_conflict' });
    expect((await events(orgA, `event_id = '${e.eventId}'`))[0]!.quantity).toBe('3.00000000');
  });

  it('out_of_order_events: later windows first, aggregates still correct', async () => {
    const res = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await ingest([baseEvent(orgA, { resourceId: res, windowStart: at(5), quantity: '5' })]);
    await ingest([baseEvent(orgA, { resourceId: res, windowStart: at(3), quantity: '3' })]);
    await ingest([
      baseEvent(orgA, { resourceId: res, windowStart: at(4), quantity: '4' }),
      baseEvent(orgA, { resourceId: res, windowStart: at(3), quantity: '3' }),
    ]);
    const a = (await aggs(orgA, 'compute.vcpu_hours')).filter((x) => x.resource_key === res);
    expect(a.map((x) => x.q)).toEqual(['3.00000000', '4.00000000', '5.00000000']);
  });

  it('rejects unknown meters, unit mismatches, forbidden dimensions, missing residency tag, bad quantities and bad ids', async () => {
    const bad = [
      baseEvent(orgA, { meterId: 'nope.nothing', seq: 'f1' }),
      baseEvent(orgA, { unit: 'gb', seq: 'f2' }),
      baseEvent(orgA, { dimensions: { region: 'sa', secret_label: 'x' }, seq: 'f3' }),
      baseEvent(orgA, { dataRegion: '', seq: 'f4' }),
      baseEvent(orgA, { quantity: 'abc', seq: 'f5' }),
      baseEvent(orgA, { quantity: '1e999', seq: 'f6' }),
      baseEvent(orgA, { eventId: 'not-a-uuid', seq: 'f7' }),
      baseEvent(orgA, { windowEnd: at(0), seq: 'f8' }),
      baseEvent(orgA, { resourceId: 'nope', seq: 'f9' }),
      baseEvent(orgA, { quantity: '-1', seq: 'f10' }),
    ];
    const r = (await ingest(bad)).results.map((x) => x.reason);
    expect(r).toEqual([
      'unknown_meter',
      'unit_mismatch',
      'forbidden_dimension:secret_label',
      'missing_data_region',
      'invalid_quantity',
      'invalid_quantity',
      'invalid_id',
      'invalid_time',
      'invalid_id',
      'negative_without_adjustment',
    ]);
    // a bad event never aborts the batch: the good one next to bad ones is accepted
    const mixed = await ingest([
      baseEvent(orgA, { meterId: 'nope.nothing', seq: 'm1' }),
      baseEvent(orgA, { seq: 'm2', quantity: '1' }),
    ]);
    expect(mixed.results.map((x) => x.result)).toEqual(['rejected', 'accepted']);
  });

  it('zero quantity is accepted; clock skew: >5 min in the future is rejected, >1 min is flagged', async () => {
    expect((await ingest([baseEvent(orgA, { quantity: '0', seq: 'z1' })])).results[0]!.result).toBe(
      'accepted',
    );
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(
      (await ingest([baseEvent(orgA, { occurredAt: future, seq: 's1' })])).results[0],
    ).toMatchObject({ result: 'rejected', reason: 'occurred_in_future' });
    const slightly = new Date(Date.now() + 120_000).toISOString();
    const r = await ingest([baseEvent(orgA, { occurredAt: slightly, seq: 's2' })]);
    expect(r.results[0]!.result).toBe('accepted');
    expect((await events(orgA, `occurred_at = '${slightly}'`))[0]).toMatchObject({
      skew_flag: true,
    });
  });

  it('adjustment events: a negative correction lands in the ADJUSTED event window and nets the bucket down', async () => {
    const res = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const orig = baseEvent(orgA, { resourceId: res, windowStart: at(7), quantity: '10' });
    await ingest([orig]);
    const adj = baseEvent(orgA, {
      resourceId: res,
      windowStart: at(20),
      quantity: '-4',
      adjustsEventId: orig.eventId,
      seq: 'adj-1',
    });
    expect((await ingest([adj])).results[0]!.result).toBe('accepted');
    const row = (await events(orgA, `event_id = '${adj.eventId}'`))[0]!;
    expect(new Date(row.window_start).toISOString()).toBe(orig.windowStart); // forced to the original window
    expect(
      (await aggs(orgA, 'compute.vcpu_hours')).find((a) => a.resource_key === res),
    ).toMatchObject({ q: '6.00000000', event_count: 2 });
    const unknown = await ingest([
      baseEvent(orgA, { quantity: '-1', adjustsEventId: randomUUID(), seq: 'adj-2' }),
    ]);
    expect(unknown.results[0]).toMatchObject({
      result: 'rejected',
      reason: 'adjusts_unknown_event',
    });
    const otherMeter = await ingest([
      baseEvent(orgA, {
        meterId: 'compute.memory_gb_hours',
        unit: 'gib_hour',
        dimensions: {},
        quantity: '-1',
        adjustsEventId: orig.eventId,
        seq: 'adj-3',
      }),
    ]);
    expect(otherMeter.results[0]).toMatchObject({
      result: 'rejected',
      reason: 'adjusts_other_meter',
    });
  });

  it('late_after_close_goes_next_period: past the 72 h grace the event is billed in the current month; inside the grace it stays', async () => {
    const lateWs = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 3, 10),
    ).toISOString();
    const r = await ingest([
      baseEvent(orgA, { windowStart: lateWs, occurredAt: new Date().toISOString(), seq: 'late-1' }),
    ]);
    expect(r.results[0]!.result).toBe('accepted');
    const row = (await events(orgA, `window_start = '${lateWs}'`))[0]!;
    expect(row).toMatchObject({ late: true });
    expect(row.bp.slice(0, 7)).toBe(PERIOD.slice(0, 7));
    // grace boundary, using the explicit clock parameter of the SQL function
    const prev = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 15));
    const prevPeriod = prev.toISOString().slice(0, 7);
    const monthEnd = monthStart.getTime();
    const ev = (seq: string) =>
      JSON.stringify([
        baseEvent(orgA, {
          windowStart: prev.toISOString(),
          occurredAt: new Date(monthEnd + 71 * 3_600_000).toISOString(),
          seq,
        }),
      ]);
    const run = async (seq: string, nowMs: number) =>
      (
        await h.env.app.withOrg(orgA, (c) =>
          c.query(`SELECT * FROM metering.ingest($1::jsonb, 'compute@M05', $2)`, [
            ev(seq),
            new Date(nowMs),
          ]),
        )
      ).rows[0]!;
    expect((await run('grace-in', monthEnd + 71 * 3_600_000)).result).toBe('accepted');
    expect((await run('grace-out', monthEnd + 73 * 3_600_000)).result).toBe('accepted');
    const inRow = (
      await events(
        orgA,
        `event_id = '${usageEventId({ orgId: orgA, meterId: 'compute.vcpu_hours', resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', windowStart: prev.toISOString(), sourceSeq: 'grace-in' })}'`,
      )
    )[0]!;
    const outRow = (
      await events(
        orgA,
        `event_id = '${usageEventId({ orgId: orgA, meterId: 'compute.vcpu_hours', resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', windowStart: prev.toISOString(), sourceSeq: 'grace-out' })}'`,
      )
    )[0]!;
    expect(inRow.late).toBe(false);
    expect(inRow.bp.slice(0, 7)).toBe(prevPeriod);
    expect(outRow.late).toBe(true);
  });

  it('every event carries its residency tag, source and schema version; payload fields are stored faithfully', async () => {
    const e = baseEvent(orgA, {
      seq: 'meta-1',
      projectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      providerEventId: 'prov-123',
      tags: { team: 'blue' },
    });
    await ingest([e]);
    const row = (await events(orgA, `event_id = '${e.eventId}'`))[0]!;
    expect(row).toMatchObject({
      data_region: 'sa-pending',
      source: 'compute@M05',
      schema_version: 1,
      provider_event_id: 'prov-123',
      unit: 'vcpu_hour',
    });
    expect(row.tags).toEqual({ team: 'blue' });
    expect(row.project_id).toBe(e.projectId);
  });
});

describe('aggregation: aggregate = sum(distinct events); replays are no-ops', () => {
  it('matches an independent sum over random events with duplicates and out-of-order delivery', async () => {
    const res = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const distinct = Array.from({ length: 60 }, (_, i) =>
      baseEvent(orgA, {
        meterId: 'storage.object_gb_months',
        unit: 'gib_month',
        dimensions: { class: 'standard' },
        resourceId: res,
        windowStart: at(30 + rnd(48)),
        quantity: String(rnd(500) / 10),
        seq: `rnd-${i}`,
      }),
    );
    const delivered = [...distinct, ...distinct.filter(() => Math.random() < 0.5)].sort(
      () => Math.random() - 0.5,
    );
    for (let i = 0; i < delivered.length; i += 25) await ingest(delivered.slice(i, i + 25));
    const expected = new Map<string, bigint>();
    for (const e of distinct) {
      const bucket = new Date(Date.parse(e.windowStart)).toISOString();
      expected.set(
        bucket,
        (expected.get(bucket) ?? 0n) + BigInt(Math.round(Number(e.quantity) * 1e8)),
      );
    }
    const got = (await aggs(orgA, 'storage.object_gb_months')).filter(
      (a) => a.resource_key === res,
    );
    expect(got.length).toBe(expected.size);
    for (const g of got)
      expect(BigInt(g.q.replace('.', ''))).toBe(
        expected.get(new Date(g.bucket_start).toISOString())!,
      );
    expect(got.reduce((s, g) => s + g.event_count, 0)).toBe(distinct.length);
  });

  it('replay_is_noop: re-aggregating changes nothing; verify_aggregates reports nothing until an aggregate is tampered with', async () => {
    const changed = (
      await h.env.app.withOrg(orgA, (c) =>
        c.query(`SELECT metering.aggregate($1, $2, $3) n`, [orgA, at(0), at(500)]),
      )
    ).rows[0]!.n;
    expect(changed).toBe(0);
    const clean = await h.env.app.withOrg(orgA, (c) =>
      c.query(`SELECT * FROM metering.verify_aggregates($1) WHERE stored <> recomputed`, [orgA]),
    );
    expect(clean.rowCount).toBe(0);
    await h.env.sql(
      `UPDATE metering.usage_aggregates SET quantity = quantity + 1 WHERE org_id = $1 AND meter_id = 'storage.object_gb_months' AND bucket_start = (SELECT min(bucket_start) FROM metering.usage_aggregates WHERE org_id = $1 AND meter_id = 'storage.object_gb_months')`,
      [orgA],
    );
    const bad = await h.env.app.withOrg(orgA, (c) =>
      c.query(`SELECT * FROM metering.verify_aggregates($1) WHERE stored <> recomputed`, [orgA]),
    );
    expect(bad.rowCount).toBe(1);
    await h.env.app.withOrg(orgA, (c) =>
      c.query(`SELECT metering.aggregate($1, $2, $3)`, [orgA, at(0), at(500)]),
    ); // the rebuild heals it
    expect(
      (
        await h.env.app.withOrg(orgA, (c) =>
          c.query(`SELECT * FROM metering.verify_aggregates($1) WHERE stored <> recomputed`, [
            orgA,
          ]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it('100 parallel ingests of one event produce exactly one row and one aggregate contribution', async () => {
    const svc = app.get(MeteringIngestService);
    const e = baseEvent(orgA, {
      meterId: 'network.egress_gb',
      unit: 'gb',
      dimensions: { region: 'sa-central' },
      quantity: '7',
      seq: 'race-1',
      windowStart: at(60),
    });
    const results = await Promise.all(
      Array.from({ length: 100 }, () => svc.ingest([e], { source: 'compute@M05', orgIds: null })),
    );
    const accepted = results.filter((r) => r.results[0]!.result === 'accepted').length;
    expect(accepted).toBe(1);
    expect((await events(orgA, `event_id = '${e.eventId}'`)).length).toBe(1);
    expect((await aggs(orgA, 'network.egress_gb')).find((a) => a.q === '7.00000000')).toBeTruthy();
  });
});

describe('tenant isolation and partitions', () => {
  it('an organization never sees another organization’s events, aggregates or rated usage', async () => {
    await ingest([baseEvent(orgB, { seq: 'b-1', quantity: '123' })]);
    const a = await h.env.app.withOrg(orgA, (c) =>
      c.query(`SELECT DISTINCT org_id FROM metering.usage_events`),
    );
    expect(a.rows.map((r) => r.org_id)).toEqual([orgA]);
    const agg = await h.env.app.withOrg(orgB, (c) =>
      c.query(`SELECT DISTINCT org_id FROM metering.usage_aggregates`),
    );
    expect(agg.rows.map((r) => r.org_id)).toEqual([orgB]);
    expect(
      (await h.env.app.withoutScope((c) => c.query(`SELECT 1 FROM metering.usage_events`)))
        .rowCount,
    ).toBe(0);
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(`SELECT * FROM metering.ingest($1::jsonb, 'compute@M05')`, [
          JSON.stringify([baseEvent(orgB, { seq: 'spoof-db' })]),
        ]),
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ result: 'rejected', reason: 'org_mismatch' })],
    });
    await expect(
      h.env.app.withoutScope((c) =>
        c.query(`SELECT * FROM metering.aggregate($1, now(), now())`, [orgA]),
      ),
    ).rejects.toThrow(/organization context does not match/);
  });

  it('events are routed to monthly partitions; far-future windows use the default partition; partitions can be created ahead', async () => {
    const part = await h.env.sql(
      `SELECT tableoid::regclass::text AS t FROM metering.usage_events WHERE org_id = $1 AND window_start = $2 LIMIT 1`,
      [orgA, at(1)],
    );
    expect(part[0]!.t).toBe(`metering.usage_events_${PERIOD.slice(0, 7).replace('-', '')}`);
    await ingest([
      baseEvent(orgA, {
        windowStart: '2040-03-01T00:00:00Z',
        occurredAt: new Date().toISOString(),
        seq: 'far',
      }),
    ]);
    expect(
      (
        await h.env.sql(
          `SELECT tableoid::regclass::text AS t FROM metering.usage_events WHERE window_start = '2040-03-01T00:00:00Z'`,
        )
      )[0]!.t,
    ).toBe('metering.usage_events_default');
    const created = (
      await h.env.app.withoutScope((c) =>
        c.query(`SELECT metering.ensure_usage_partitions('2041-01-01', 3) n`),
      )
    ).rows[0]!.n;
    expect(created).toBe(3);
    expect(
      (
        await h.env.app.withoutScope((c) =>
          c.query(`SELECT metering.ensure_usage_partitions('2041-01-01', 3) n`),
        )
      ).rows[0]!.n,
    ).toBe(0); // idempotent
  });
});

describe('meter catalogue admin', () => {
  it('lists the seeded catalogue (31 meters) with units and dimension allow-lists', async () => {
    const r = await admin('fin', 'GET', '/v1/admin/meters');
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items.length).toBe(31);
    expect(items.find((m) => m.id === 'compute.vcpu_hours')).toMatchObject({
      unit: 'vcpu_hour',
      aggregationWindow: 'hour',
      basis: 'usage',
      hasEvents: true,
    });
    expect(items.find((m) => m.id === 'compute.vcpu_hours')!.dimensionsAllowed).toEqual([
      'provider',
      'region',
      'plan',
    ]);
  });

  it('finance and platform_admin can extend it; support cannot; duplicates and bad input are refused; the unit freezes with the first event', async () => {
    const m = {
      id: 'custom.widgets',
      unit: 'widget',
      aggregationWindow: 'day',
      basis: 'usage',
      dimensionsAllowed: ['color'],
    };
    expect((await admin('sup', 'POST', '/v1/admin/meters', m)).statusCode).toBe(403);
    expect((await admin('fin', 'POST', '/v1/admin/meters', m)).statusCode).toBe(201);
    expect((await admin('root', 'POST', '/v1/admin/meters', m)).statusCode).toBe(409);
    for (const bad of [
      { ...m, id: 'NoDots' },
      { ...m, id: 'a.b', unit: '' },
      { ...m, id: 'a.b', aggregationWindow: 'week' },
      { ...m, id: 'a.b', basis: 'free' },
      { ...m, id: 'a.b', dimensionsAllowed: ['Bad Key'] },
    ])
      expect(
        (await admin('fin', 'POST', '/v1/admin/meters', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    await h.env.sql(`UPDATE metering.meters SET unit = 'gadget' WHERE id = 'custom.widgets'`); // no events yet: allowed
    const r = await ingest([
      baseEvent(orgA, {
        meterId: 'custom.widgets',
        unit: 'gadget',
        dimensions: { color: 'red' },
        seq: 'cw-1',
        quantity: '2',
      }),
    ]);
    expect(r.results[0]!.result).toBe('accepted');
    await expect(
      h.env.sql(`UPDATE metering.meters SET unit = 'thing' WHERE id = 'custom.widgets'`),
    ).rejects.toThrow(/unit is immutable/);
    expect((await as(web.alice!, 'GET', '/v1/admin/meters')).statusCode).toBe(401);
  });
});

describe('price books (four-eyes publishing)', () => {
  let bookId = '';
  let draftId = '';

  it('lists the DRAFT-NOT-APPROVED seed book', async () => {
    const books = (await admin('fin', 'GET', '/v1/admin/billing/price-books')).json()
      .items as Row[];
    const seed = books.find((b) => b.name === 'default')!;
    expect(seed).toMatchObject({ currency: 'SAR', placeholder: true });
    expect(seed.versions[0]).toMatchObject({ version: 1, status: 'published' });
    expect(seed.versions[0].items.map((i: Row) => i.tierModel).sort()).toEqual(
      expect.arrayContaining(['flat', 'graduated', 'volume']),
    );
  });

  it('finance creates a book with a draft v1; invalid items are refused', async () => {
    const ok = await admin('fin', 'POST', '/v1/admin/billing/price-books', {
      name: 'standard',
      currency: 'SAR',
      effectiveFrom: monthStart.toISOString(),
      items: [
        item('compute.vcpu_hours', { includedAllowance: '100' }),
        item('network.egress_gb', {
          tierModel: 'graduated',
          unitPriceMinor: undefined,
          tiers: [
            { upTo: '100', unitPriceMinor: '0' },
            { upTo: null, unitPriceMinor: '3' },
          ],
        }),
      ],
    });
    expect(ok.statusCode).toBe(201);
    bookId = ok.json().id;
    draftId = ok.json().versions[0].id;
    expect(ok.json().versions[0]).toMatchObject({ status: 'draft', version: 1 });
    expect(ok.json().placeholder).toBe(false);
    for (const bad of [
      { items: [item('no.such_meter')] },
      { items: [item('compute.vcpu_hours', { unitPriceMinor: '-1' })] },
      { items: [item('compute.vcpu_hours', { unitPriceMinor: '1.123456789' })] },
      { items: [item('compute.vcpu_hours', { tiers: [{ upTo: null, unitPriceMinor: '1' }] })] }, // flat with tiers
      {
        items: [
          item('network.egress_gb', {
            tierModel: 'graduated',
            unitPriceMinor: undefined,
            tiers: [{ upTo: '5', unitPriceMinor: '1' }],
          }),
        ],
      }, // last tier bounded
      { items: [item('compute.vcpu_hours'), item('compute.vcpu_hours')] },
      { items: [] },
      { items: [item('compute.vcpu_hours', { rounding: 'banker' })] },
    ])
      expect(
        (
          await admin('fin', 'POST', '/v1/admin/billing/price-books', {
            name: `bad-${Math.random()}`,
            effectiveFrom: monthStart.toISOString(),
            ...bad,
          })
        ).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    expect(
      (
        await admin('fin', 'POST', '/v1/admin/billing/price-books', {
          name: 'standard',
          currency: 'SAR',
          effectiveFrom: monthStart.toISOString(),
          items: [item('compute.vcpu_hours')],
        })
      ).statusCode,
    ).toBe(409);
  });

  it('the creator cannot publish (four-eyes); finance lacks the publish permission; platform_admin publishes', async () => {
    const same = await admin('fin', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
      publishVersionId: draftId,
    });
    expect(same.statusCode).toBe(403);
    const second = await admin('fin2', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
      publishVersionId: draftId,
    });
    expect(second.statusCode).toBe(403); // a different finance user still has no admin:billing:publish
    const pub = await admin('root', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
      publishVersionId: draftId,
    });
    expect(pub.statusCode).toBe(201);
    expect(pub.json().versions[0]).toMatchObject({ status: 'published' });
    expect(pub.json().versions[0].publishedBy).toBe(ids.root);
    expect(
      (
        await admin('root', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
          publishVersionId: draftId,
        })
      ).statusCode,
    ).toBe(409); // already published
  });

  it('published versions are immutable (API and database); a new draft needs a LATER effective date to publish', async () => {
    await expect(
      h.env.sql(`UPDATE billing.price_book_versions SET note = 'x' WHERE id = $1`, [draftId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM billing.price_items WHERE version_id = $1`, [draftId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`UPDATE billing.price_items SET unit_price_minor = 1 WHERE version_id = $1`, [
        draftId,
      ]),
    ).rejects.toThrow(/immutable/);
    const sameDay = await admin('fin', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
      effectiveFrom: monthStart.toISOString(),
      items: [item('compute.vcpu_hours', { unitPriceMinor: '9' })],
    });
    expect(sameDay.statusCode).toBe(201);
    const v2 = sameDay.json().versions.find((v: Row) => v.version === 2).id;
    expect(
      (
        await admin('root', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
          publishVersionId: v2,
        })
      ).statusCode,
    ).toBe(409); // overlapping effective dates
    expect(
      (
        await admin('fin', 'POST', `/v1/admin/billing/price-books/${bookId}/versions`, {
          effectiveFrom: at(200),
          items: [item('compute.vcpu_hours')],
        })
      ).statusCode,
    ).toBe(409); // one draft at a time
    // restore the seed book as the one used for rating in the next describe (the real 'standard' book would win)
    await h.env.sql(`UPDATE billing.price_books SET status = 'archived' WHERE name = 'standard'`);
    expect(
      (
        await admin(
          'fin',
          'POST',
          `/v1/admin/billing/price-books/00000000-0000-7000-8000-0000000000ff/versions`,
          { effectiveFrom: at(200), items: [item('compute.vcpu_hours')] },
        )
      ).statusCode,
    ).toBe(404);
    expect((await admin('sup', 'GET', '/v1/admin/billing/price-books')).statusCode).toBe(403);
  });
});

describe('rating', () => {
  const rating = () => app.get(RatingService);
  const rated = (org: string, run?: string) =>
    h.env.sql(
      `SELECT meter_id, resource_key, quantity::text q, allowance_applied::text allow, billable_quantity::text bill, amount_minor::text amt, previous_amount_minor::text prev, delta_minor::text delta, tier_model, price_book_version_id FROM metering.rated_usage WHERE org_id=$1 ${run ? 'AND rating_run_id = $2' : ''} ORDER BY meter_id, resource_key, segment_start`,
      run ? [org, run] : [org],
    );
  const resA = '11111111-1111-4111-8111-111111111111';
  const resB = '22222222-2222-4222-8222-222222222222';

  it('rates a period with the seed (placeholder) book: flat, graduated, volume and allowance+overage', async () => {
    // a dedicated organization so earlier fixtures do not interfere
    const owner = await h.createUser('rater');
    const jar = await h.sessionFor(app, owner);
    const org = (await as(jar, 'POST', '/v1/organizations', { name: 'Rated Org' })).json()
      .id as string;
    ids.ratedOrg = org;
    const ev = (
      meterId: string,
      unit: string,
      qty: string,
      hours: number,
      seq: string,
      dims: Row = {},
    ) =>
      baseEvent(org, {
        meterId,
        unit,
        quantity: qty,
        windowStart: at(hours),
        resourceId: resA,
        dimensions: dims,
        seq,
      });
    await ingest([
      ev('compute.vcpu_hours', 'vcpu_hour', '10', 1, 'r1', { region: 'x' }), // flat 5 → 50
      ev('compute.vcpu_hours', 'vcpu_hour', '2.5', 2, 'r2', { region: 'x' }), // total 12.5 → 62.5 → 63 half-up
      ev('network.egress_gb', 'gb', '1100', 3, 'r3', { region: 'x' }), // graduated: 0*100 + 900*2 + 100*1.5 = 1950
      ev('storage.object_gb_months', 'gib_month', '1001', 4, 'r4', { class: 'c' }), // volume at 15 → 15015
      ev('email.transactional_messages', 'message', '1500', 5, 'r5', { stream: 's' }), // allowance 1000, 500 × 0.1 = 50 (up)
      ev('hosting.disk_gb_months', 'gib_month', '40', 6, 'r6', { plan: 'p' }), // no price item → unpriced
    ]);
    const run = await rating().rate(org, PERIOD);
    expect(run.placeholderBook).toBe(true);
    const by = (m: string) => run.rows.find((r) => r.meterId === m)!;
    expect(by('compute.vcpu_hours')).toMatchObject({
      quantity: '12.5',
      amountMinor: '63',
      tierModel: 'flat',
    });
    expect(by('network.egress_gb')).toMatchObject({ amountMinor: '1950', tierModel: 'graduated' });
    expect(by('storage.object_gb_months')).toMatchObject({
      amountMinor: '15015',
      tierModel: 'volume',
    });
    expect(by('email.transactional_messages')).toMatchObject({
      allowanceApplied: '1000',
      billableQuantity: '500',
      amountMinor: '50',
    });
    expect(run.unpriced).toEqual([
      { meterId: 'hosting.disk_gb_months', resourceKey: resA, quantity: '40' },
    ]);
    expect(BigInt(run.totalMinor)).toBe(63n + 1950n + 15015n + 50n);
    const stored = await rated(org, run.runId);
    expect(stored.length).toBe(run.rows.length);
    expect(stored.every((r) => r.prev === null && r.delta === null)).toBe(true); // first run: no previous
    // rated usage posts NOTHING to the ledger by itself
    expect(
      (await h.env.sql(`SELECT 1 FROM billing.ledger_transactions WHERE org_id = $1`, [org]))
        .length,
    ).toBe(0);
  });

  it('re-rating is a new run with deltas against the previous run (never an edit); corrections lower the next run', async () => {
    const org = ids.ratedOrg!;
    const again = await rating().rate(org, PERIOD);
    const before = await rated(org, again.runId);
    expect(before.every((r) => r.delta === '0')).toBe(true); // unchanged data → zero delta
    // a correction of 5 vcpu hours in the same window → total 7.5 → 37.5 → 38; delta −25
    const orig = (
      await h.env.sql(
        `SELECT event_id FROM metering.usage_events WHERE org_id = $1 AND quantity = 10 AND meter_id = 'compute.vcpu_hours'`,
        [org],
      )
    )[0]!.event_id as string;
    await ingest([
      baseEvent(org, {
        quantity: '-5',
        adjustsEventId: orig,
        resourceId: resA,
        seq: 'corr-1',
        windowStart: at(50),
        dimensions: { region: 'x' },
      }),
    ]);
    const third = await rating().rate(org, PERIOD);
    const row = (await rated(org, third.runId)).find((r) => r.meter_id === 'compute.vcpu_hours')!;
    expect(row).toMatchObject({ q: '7.50000000', amt: '38', prev: '63', delta: '-25' });
    expect(
      (
        await h.env.sql(
          `SELECT DISTINCT rating_run_id FROM metering.rated_usage WHERE org_id = $1`,
          [org],
        )
      ).length,
    ).toBe(3); // history is kept
    await expect(h.env.sql(`UPDATE metering.rated_usage SET amount_minor = 0`)).rejects.toThrow(
      /append-only/,
    );
    await expect(h.env.sql(`DELETE FROM metering.rated_usage`)).rejects.toThrow(/append-only/);
    await expect(
      h.env.app.withOrg(org, (c) =>
        c.query(`SELECT metering.record_rated($1, gen_random_uuid(), '[]'::jsonb)`, [orgB]),
      ),
    ).rejects.toThrow(/organization context does not match/);
  });

  it('a negative net total never produces a negative charge; zero usage rates to nothing', async () => {
    const org = (
      await as(await h.sessionFor(app, await h.createUser('neg')), 'POST', '/v1/organizations', {
        name: 'Neg Org',
      })
    ).json().id as string;
    const e = baseEvent(org, { quantity: '1', seq: 'n1', resourceId: resB });
    await ingest([
      e,
      baseEvent(org, { quantity: '-1', adjustsEventId: e.eventId, seq: 'n2', resourceId: resB }),
    ]);
    const run = await rating().rate(org, PERIOD);
    expect(run.rows[0]).toMatchObject({ quantity: '0', amountMinor: '0' });
    expect((await rating().rate(orgB, '2020-01-01')).rows).toEqual([]);
  });

  it('price_version_change_mid_period: each segment is rated at ITS version; the allowance is pooled, not granted twice', async () => {
    // book "tiered" (real, non-placeholder): v1 from the 1st (flat 5, allowance 100), v2 from the 3rd (flat 8, allowance 100)
    const mk = async (name: string, from: string, price: string) =>
      (
        await admin('fin', 'POST', '/v1/admin/billing/price-books', {
          name,
          currency: 'SAR',
          effectiveFrom: from,
          items: [item('compute.vcpu_hours', { unitPriceMinor: price, includedAllowance: '100' })],
        })
      ).json();
    const book = await mk('mid-period', at(0), '5');
    await admin('root', 'POST', `/v1/admin/billing/price-books/${book.id}/versions`, {
      publishVersionId: book.versions[0].id,
    });
    const v2 = (
      await admin('fin', 'POST', `/v1/admin/billing/price-books/${book.id}/versions`, {
        effectiveFrom: at(48),
        items: [item('compute.vcpu_hours', { unitPriceMinor: '8', includedAllowance: '100' })],
      })
    ).json().versions[1].id;
    await admin('root', 'POST', `/v1/admin/billing/price-books/${book.id}/versions`, {
      publishVersionId: v2,
    });
    const org = (
      await as(await h.sessionFor(app, await h.createUser('mid')), 'POST', '/v1/organizations', {
        name: 'Mid Org',
      })
    ).json().id as string;
    await ingest([
      baseEvent(org, { quantity: '150', windowStart: at(10), seq: 'm1', resourceId: resA }), // segment 1 (v1): 100 free, 50 × 5 = 250
      baseEvent(org, { quantity: '60', windowStart: at(60), seq: 'm2', resourceId: resA }), // segment 2 (v2): allowance already used → 60 × 8 = 480
    ]);
    const run = await rating().rate(org, PERIOD);
    expect(run.placeholderBook).toBe(false); // the real book wins over the seed placeholder
    expect(
      run.rows.map((r) => [r.quantity, r.allowanceApplied, r.billableQuantity, r.amountMinor]),
    ).toEqual([
      ['150', '100', '50', '250'],
      ['60', '0', '60', '480'],
    ]);
    expect(new Set(run.rows.map((r) => r.priceBookVersionId)).size).toBe(2);
    expect(run.totalMinor).toBe('730');
  });

  it('refuses the placeholder book in a production profile (HG-02-01) and unknown periods', async () => {
    const owner = await h.createUser('prod');
    const org = (
      await as(await h.sessionFor(app, owner), 'POST', '/v1/organizations', { name: 'Prod Org' })
    ).json().id as string;
    // use a currency that only the placeholder seed covers? the seed is SAR; so restrict by archiving the real books for this check
    await h.env.sql(`UPDATE billing.price_books SET status = 'archived' WHERE placeholder = false`);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(rating().rate(org, PERIOD)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      process.env.NODE_ENV = env;
      await h.env.sql(`UPDATE billing.price_books SET status = 'active'`);
    }
    await expect(rating().rate(org, '2026-11-15')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('provider cost capture and margin', () => {
  const cost = (over: Row = {}) => ({
    providerAccountId: 'alibaba-main',
    providerLineRef: 'inv-2026-11-line-1',
    periodStart: PERIOD,
    periodEnd: PERIOD,
    meterOrSku: 'ecs.g7.large',
    quantity: '720',
    costMinor: 12_345,
    currency: 'SAR',
    source: 'api' as const,
    ...over,
  });

  it('records a cost once, accrues it in the ledger on the provider sub-ledger, and treats a repeat as a duplicate', async () => {
    const svc = app.get(ProviderCostService);
    const first = await svc.record([cost({ orgId: ids.ratedOrg })], ids.fin);
    expect(first[0]!.inserted).toBe(true);
    const again = await svc.record([cost({ orgId: ids.ratedOrg })], ids.fin);
    expect(again[0]).toMatchObject({ inserted: false, id: first[0]!.id });
    expect(
      (
        await h.env.sql(
          `SELECT 1 FROM metering.provider_cost_records WHERE provider_line_ref = 'inv-2026-11-line-1'`,
        )
      ).length,
    ).toBe(1);
    const postings = await h.env.sql(
      `SELECT a.code, a.subledger_key, p.direction, p.amount_minor::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.idempotency_key = 'cost:alibaba-main:inv-2026-11-line-1' ORDER BY a.code`,
    );
    expect(postings).toEqual([
      { code: '2400', subledger_key: 'alibaba-main', direction: 'credit', amt: '12345' },
      { code: '5100', subledger_key: 'alibaba-main', direction: 'debit', amt: '12345' },
    ]);
    expect(
      (
        await h.env.sql(
          `SELECT 1 FROM billing.ledger_transactions WHERE idempotency_key = 'cost:alibaba-main:inv-2026-11-line-1'`,
        )
      ).length,
    ).toBe(1); // one accrual, not two
  });

  it('validates imports: a bill import needs evidence; periods, quantities and amounts are checked; records are append-only', async () => {
    const svc = app.get(ProviderCostService);
    await expect(
      svc.record([cost({ source: 'bill_import', providerLineRef: 'imp-1' })], ids.fin),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      svc.record(
        [
          cost({
            source: 'bill_import',
            evidenceRef: 'file://bill.pdf',
            providerLineRef: 'imp-2',
            costMinor: 1.5 as never,
          }),
        ],
        ids.fin,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      svc.record([cost({ providerLineRef: 'imp-3', periodEnd: '2020-01-01' })], ids.fin),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(
      (
        await svc.record(
          [
            cost({
              source: 'bill_import',
              evidenceRef: 'file://bill.pdf',
              providerLineRef: 'imp-4',
              orgId: undefined,
            }),
          ],
          ids.fin,
        )
      )[0]!.inserted,
    ).toBe(true);
    await expect(
      h.env.sql(`UPDATE metering.provider_cost_records SET cost_minor = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it('customers can never read provider cost; finance sees margin = latest rated revenue − attributed cost', async () => {
    const asCustomer = await h.env.app.withOrg(ids.ratedOrg!, (c) =>
      c.query(`SELECT 1 FROM metering.provider_cost_records`),
    );
    expect(asCustomer.rowCount).toBe(0);
    await expect(
      h.env.app.withOrg(orgA, (c) => c.query(`SELECT metering.record_provider_cost('[]'::jsonb)`)),
    ).rejects.toThrow(/platform scope required/);
    const custView = await h.env.app.withOrg(ids.ratedOrg!, (c) =>
      c.query(`SELECT cost_minor::text FROM metering.v_margin WHERE org_id = $1`, [ids.ratedOrg]),
    );
    for (const r of custView.rows) expect(r.cost_minor).toBe('0'); // the view never exposes cost to a tenant
    const m = (await app.get(ProviderCostService).margin({ orgId: ids.ratedOrg })).find(
      (r) => r.period_start === PERIOD,
    )!;
    const revenue = BigInt(m.revenue_minor);
    expect(m.cost_minor).toBe('12345');
    expect(BigInt(m.margin_minor)).toBe(revenue - 12_345n);
    expect(revenue).toBeGreaterThan(0n);
  });
});

describe('everything above is audited and the ledger stays consistent', () => {
  it('records audit events for meters, price books, rating and provider cost', async () => {
    const actions = (
      await h.env.sql(
        `SELECT DISTINCT action FROM audit.audit_logs WHERE action LIKE 'metering.%' OR action LIKE 'billing.price_book%'`,
      )
    ).map((r) => r.action as string);
    for (const a of [
      'metering.meter.created',
      'metering.rating.completed',
      'metering.provider_cost.recorded',
      'billing.price_book.created',
      'billing.price_book_version.published',
    ])
      expect(actions).toContain(a);
  });
  it('the ledger posted by this sprint is balanced', async () => {
    const bad = await h.env.sql(
      `SELECT t.id FROM billing.ledger_transactions t JOIN billing.ledger_postings p ON p.transaction_id = t.id GROUP BY t.id, p.currency HAVING sum(CASE p.direction WHEN 'debit' THEN p.amount_minor ELSE -p.amount_minor END) <> 0`,
    );
    expect(bad).toEqual([]);
    expect(app.get(LedgerPostingService)).toBeDefined();
  });
});
