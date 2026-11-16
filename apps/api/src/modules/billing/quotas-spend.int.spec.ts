import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageEventId } from '@nuzm/platform';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { MeteringIngestService, RatingService } from '../metering';
import { EntitlementService, QuotaService, SpendService } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};

const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const PERIOD = monthStart.toISOString().slice(0, 10);
const at = (hours: number) => new Date(monthStart.getTime() + hours * 3_600_000).toISOString();
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const R2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const uuid = () => crypto.randomUUID();

const call = (
  who: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: object,
  org = orgA,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });

/** Store one usage event through the real ingest service (which also re-evaluates the organization's quotas). */
const ingest = async (
  org: string,
  meterId: string,
  unit: string,
  quantity: string,
  hour: number,
  resourceId = R1,
  dimensions: Record<string, string> = { region: 'sa-central' },
) => {
  const windowStart = at(hour);
  const e = {
    orgId: org,
    meterId,
    quantity,
    unit,
    resourceId,
    windowStart,
    windowEnd: new Date(Date.parse(windowStart) + 3_600_000).toISOString(),
    occurredAt: new Date().toISOString(),
    dimensions,
    dataRegion: 'sa-pending',
  };
  const r = await app
    .get(MeteringIngestService)
    .ingest([{ ...e, eventId: usageEventId({ orgId: org, meterId, resourceId, windowStart }) }], {
      source: 'compute@M05',
      orgIds: null,
    });
  expect(r.summary.accepted).toBe(1);
};
const notes = (org: string, kind: string) =>
  h.env.sql(
    `SELECT user_id FROM platform.notifications WHERE org_id=$1 AND kind=$2 ORDER BY created_at, id`,
    [org, kind],
  ) as Promise<Row[]>;
const audits = (org: string, action: string) =>
  h.env.sql(`SELECT after FROM audit.audit_logs WHERE org_id=$1 AND action=$2 ORDER BY id`, [
    org,
    action,
  ]) as Promise<Row[]>;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  orgA = (await call('alice', 'POST', '/v1/organizations', { name: 'Quota A' }, '')).json().id;
  orgB = (await call('bob', 'POST', '/v1/organizations', { name: 'Quota B' }, '')).json().id;
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
});
afterAll(() => h.close());

describe('usage API', () => {
  beforeAll(async () => {
    await ingest(orgA, 'network.egress_gb', 'gb', '3', 2, R1); // day meter
    await ingest(orgA, 'network.egress_gb', 'gb', '4', 5, R1);
    await ingest(orgA, 'network.egress_gb', 'gb', '10', 30, R1); // next day (hour 30)
    await ingest(orgA, 'network.egress_gb', 'gb', '7', 3, R2);
    await ingest(orgB, 'network.egress_gb', 'gb', '999', 2, R1);
  });

  it('permissions: viewers read aggregates and quotas but not raw events; billing admins and owners read events', async () => {
    expect((await call('carol', 'GET', '/v1/usage')).statusCode).toBe(200);
    expect((await call('carol', 'GET', '/v1/quotas')).statusCode).toBe(200);
    expect((await call('carol', 'GET', '/v1/usage/events')).statusCode).toBe(403);
    expect((await call('erin', 'GET', '/v1/usage/events')).statusCode).toBe(403);
    expect((await call('dave', 'GET', '/v1/usage/events')).statusCode).toBe(200);
    expect((await call('alice', 'GET', '/v1/usage/events')).statusCode).toBe(200);
  });

  it('rolls stored buckets up by day and month, filters by meter and resource, and shows the data region', async () => {
    const day = (
      await call('carol', 'GET', '/v1/usage?meter=network.egress_gb&granularity=day')
    ).json();
    const r1 = day.items.filter((p: Row) => p.resourceId === R1);
    expect(r1.map((p: Row) => p.quantity).sort()).toEqual(['10.00000000', '7.00000000']); // 3+4 on day 1, 10 on day 2
    for (const p of day.items) {
      expect(p).toMatchObject({
        meterId: 'network.egress_gb',
        unit: 'gb',
        dataRegion: 'sa-pending',
      });
      expect(p.billingPeriodStart).toBe(PERIOD);
    }
    const month = (
      await call('carol', 'GET', '/v1/usage?granularity=month&meter=network.egress_gb')
    ).json();
    expect(month.items.find((p: Row) => p.resourceId === R1).quantity).toBe('17.00000000');
    expect(month.items.find((p: Row) => p.resourceId === R2).quantity).toBe('7.00000000');
    const one = (await call('carol', 'GET', `/v1/usage?granularity=month&resource=${R2}`)).json();
    expect(one.items).toHaveLength(1);
    expect((await call('carol', 'GET', '/v1/usage?meter=compute.vcpu_hours')).json().items).toEqual(
      [],
    );
  });

  it('keyset pagination walks every point exactly once', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const p = (await call('carol', 'GET', `/v1/usage?granularity=day&limit=1${cursor}`)).json();
      p.items.forEach((x: Row) => seen.push(`${x.bucketStart}|${x.resourceId}`));
      if (!p.nextCursor) break;
      cursor = `&cursor=${p.nextCursor}`;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('rejects bad filters (injection attempts are bound parameters or fail validation)', async () => {
    for (const bad of [
      'granularity=week',
      "meter=x'; DROP TABLE metering.usage_events;--",
      'resource=not-a-uuid',
      'from=yesterday',
      'cursor=@@@',
      `from=2020-01-01T00:00:00Z&to=2024-01-01T00:00:00Z`,
      `from=${at(10)}&to=${at(1)}`,
    ])
      expect((await call('carol', 'GET', `/v1/usage?${encodeURI(bad)}`)).statusCode, bad).toBe(422);
  });

  it('is tenant isolated: org B sees only its own usage and events', async () => {
    const b = (await call('bob', 'GET', '/v1/usage?granularity=month', undefined, orgB)).json();
    expect(b.items.map((p: Row) => p.quantity)).toEqual(['999.00000000']);
    const ev = (await call('bob', 'GET', '/v1/usage/events', undefined, orgB)).json();
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0].quantity).toBe('999.00000000');
    // a member of A cannot read B by naming it
    expect((await call('carol', 'GET', '/v1/usage', undefined, orgB)).statusCode).toBe(404);
  });

  it('raw events list newest first with a cursor and expose no provider-side fields', async () => {
    const first = (await call('dave', 'GET', '/v1/usage/events?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (
      await call('dave', 'GET', `/v1/usage/events?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items.length).toBe(2);
    const all = [...first.items, ...second.items].map((e: Row) => e.eventId);
    expect(new Set(all).size).toBe(4);
    expect(first.items[0].windowStart >= first.items[1].windowStart).toBe(true);
    for (const e of first.items) {
      expect(e).not.toHaveProperty('tags');
      expect(e).not.toHaveProperty('providerEventId');
      expect(e).not.toHaveProperty('orgId');
    }
  });

  it('summary: unrated usage shows no amount; once rated it shows the amount and allowance (never a float)', async () => {
    const before = (await call('carol', 'GET', '/v1/usage/summary')).json();
    const egress = before.items.find((i: Row) => i.meterId === 'network.egress_gb');
    expect(egress).toMatchObject({ quantity: '24.00000000', rated: false, amountMinor: null });
    expect(before.totalMinor).toBeNull();
    await app.get(RatingService).rate(orgA, PERIOD);
    const after = (await call('carol', 'GET', '/v1/usage/summary')).json();
    const rated = after.items.find((i: Row) => i.meterId === 'network.egress_gb');
    expect(rated.rated).toBe(true);
    expect(rated.amountMinor).toMatch(/^\d+$/);
    expect(after.currency).toBe('SAR');
    expect(after.totalMinor).toBe(rated.amountMinor);
    expect((await call('carol', 'GET', '/v1/usage/summary?period=2020-13')).statusCode).toBe(422);
    expect((await call('carol', 'GET', '/v1/usage/summary?period=2020-01')).json().items).toEqual(
      [],
    );
  });
});

describe('quotas', () => {
  const quotas = async (who = 'carol') => (await call(who, 'GET', '/v1/quotas')).json();
  const group = (q: Row, g: string) => q.items.find((i: Row) => i.meterGroup === g);

  it('shows the free plan limits with nothing used, and marks unmeasured groups instead of reporting them ok', async () => {
    const q = await quotas();
    expect(group(q, 'compute')).toMatchObject({
      limit: '0',
      mode: 'hard',
      state: 'ok',
      measured: true,
      unit: 'vcpu_hour',
    });
    expect(group(q, 'storage')).toMatchObject({
      limit: '5',
      mode: 'soft',
      state: 'ok',
      measured: true,
    });
    expect(q.restricted).toBe(false);
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'hosting', limit: '5', mode: 'hard' });
    const g = group(await quotas(), 'hosting');
    expect(g).toMatchObject({ measured: false, meterId: null, state: 'ok', percent: null });
  });

  it('effective limits in SQL equal EntitlementService.resolve (plan + newest override)', async () => {
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'network', limit: '100', mode: 'soft' });
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'network', limit: '200', mode: 'hard' });
    const sql = (
      await h.env.app.withOrg(orgA, (c) =>
        c.query(`SELECT * FROM billing.effective_limits($1) ORDER BY 1`, [orgA]),
      )
    ).rows;
    const ts = (await app.get(EntitlementService).resolve(orgA)).limits;
    expect(
      sql.map((r) => [
        r.meter_group,
        r.limit_value === null ? null : String(r.limit_value),
        r.mode,
        r.source,
      ]),
    ).toEqual(ts.map((l) => [l.meterGroup, l.limit, l.mode, l.source]));
    expect(ts.find((l) => l.meterGroup === 'network')).toMatchObject({
      limit: '200',
      mode: 'hard',
      source: 'override',
    });
  });

  it('a soft quota notifies at 80 and at 100 percent, once each; a hard quota is restricted and denies only NEW consumption', async () => {
    await ingest(orgA, 'storage.object_gb_months', 'gib_month', '4', 1); // 80 %
    expect(group(await quotas(), 'storage')).toMatchObject({
      state: 'soft',
      used: '4.00000000',
      percent: 80,
    });
    await ingest(orgA, 'storage.object_gb_months', 'gib_month', '1', 2); // 100 %, mode soft
    expect(group(await quotas(), 'storage')).toMatchObject({ state: 'soft', percent: 100 });
    await quotas();
    await quotas(); // idempotent: no more announcements
    const owners = new Set([ids.alice, ids.dave]);
    const storage = (await audits(orgA, 'billing.quota.threshold_crossed')).filter(
      (a) => a.after.threshold !== undefined && a.after.limit === '5',
    );
    expect(storage.map((a) => a.after.threshold)).toEqual([80, 100]);
    const sent = await notes(orgA, 'billing.quota_threshold');
    expect(sent.length).toBe(storage.length * owners.size);
    expect(new Set(sent.map((n) => n.user_id))).toEqual(owners); // billing managers only, never viewers or developers

    await ingest(orgA, 'compute.vcpu_hours', 'vcpu_hour', '2', 1); // free plan compute limit is 0 (hard)
    const q = await quotas();
    expect(group(q, 'compute')).toMatchObject({ state: 'hard', percent: 100 });
    expect(q.restricted).toBe(true);
    const quota = app.get(QuotaService);
    expect(await quota.check(orgA, 'compute', '1')).toMatchObject({
      allowed: false,
      state: 'hard',
    });
    await expect(quota.assertAllowed(orgA, 'compute', '1')).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(await quota.check(orgA, 'compute', '0')).toMatchObject({ allowed: true }); // nothing new requested
    expect(await quota.check(orgA, 'storage', '100')).toMatchObject({
      allowed: true,
      state: 'soft',
    }); // soft never blocks
    // existing usage is untouched and still reported
    expect(
      (await call('carol', 'GET', '/v1/usage?meter=compute.vcpu_hours&granularity=month')).json()
        .items,
    ).toHaveLength(1);
  });

  it('a hard quota below its limit allows what still fits and denies what would exceed it', async () => {
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'compute', limit: '10', mode: 'hard' });
    const quota = app.get(QuotaService);
    expect(await quota.check(orgA, 'compute', '8')).toMatchObject({
      allowed: true,
      projectedUsed: '10.00000000',
    });
    expect(await quota.check(orgA, 'compute', '8.00000001')).toMatchObject({ allowed: false });
    await expect(quota.check(orgA, 'compute', '-1')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(quota.check(orgA, 'compute; drop', '1')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await quota.check(orgA, 'nogroup', '5')).toMatchObject({
      allowed: true,
      measured: false,
    });
  });

  it('quotas are isolated per organization and an organization context mismatch is refused by the database', async () => {
    const b = (await call('bob', 'GET', '/v1/quotas', undefined, orgB)).json();
    expect(group(b, 'compute')).toMatchObject({ used: '0', state: 'ok' });
    await expect(
      h.env.app.withOrg(orgB, (c) => c.query(`SELECT * FROM billing.evaluate_quotas($1)`, [orgA])),
    ).rejects.toThrow(/organization context mismatch/);
    // runtime roles cannot delete the projection; recomputation from usage restores any state
    await expect(
      h.env.app.withOrg(orgA, (c) => c.query(`DELETE FROM billing.quotas`)),
    ).rejects.toThrow();
    await h.env.sql(`DELETE FROM billing.quotas WHERE org_id = $1`, [orgA]);
    expect(group(await quotas(), 'storage')).toMatchObject({ state: 'soft' });
  });
});

describe('spending limits', () => {
  const put = (who: string, body: object, ifMatch?: string, org = orgA) =>
    call(
      who,
      'PUT',
      '/v1/billing/spending-limits',
      body,
      org,
      ifMatch ? { 'if-match': ifMatch } : {},
    );
  const monthSpent = async () => {
    const r = (await call('carol', 'GET', '/v1/usage/summary')).json();
    return BigInt(r.totalMinor ?? '0');
  };
  let ratedNow = 0n;

  it('only billing managers write limits; billing readers read them; viewers and developers are refused', async () => {
    await app.get(RatingService).rate(orgA, PERIOD); // compute usage from the quota tests is priced flat (5 per vcpu-hour)
    ratedNow = await monthSpent();
    expect(ratedNow > 0n).toBe(true);
    const body = { scope: 'org', monthlyCapMinor: (ratedNow + 1000n).toString(), currency: 'SAR' };
    expect((await put('erin', body)).statusCode).toBe(403);
    expect((await put('carol', body)).statusCode).toBe(403);
    expect((await call('erin', 'GET', '/v1/billing/spending-limits')).statusCode).toBe(403);
    const created = await put('dave', body);
    expect(created.statusCode).toBe(200);
    expect(created.headers.etag).toBe('"1"');
    expect(created.json()).toMatchObject({
      scope: 'org',
      projectId: null,
      alertThresholds: [80, 100],
      fourEyesAboveMinor: null,
      version: 1,
    });
    const list = (await call('dave', 'GET', '/v1/billing/spending-limits')).json();
    expect(list.items).toHaveLength(1);
    expect((await audits(orgA, 'billing.spending_limit.created')).length).toBe(1);
  });

  it('replacing needs the current ETag: 428 without, 412 when stale, version increments when fresh', async () => {
    const body = {
      scope: 'org',
      monthlyCapMinor: (ratedNow + 2000n).toString(),
      currency: 'SAR',
      alertThresholds: [50, 90],
    };
    expect((await put('dave', body)).statusCode).toBe(428);
    expect((await put('dave', body, '"7"')).statusCode).toBe(412);
    expect((await put('dave', body, 'garbage')).statusCode).toBe(422);
    const ok = await put('dave', body, '"1"');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json().alertThresholds).toEqual([50, 90]);
    expect((await put('dave', body, '"1"')).statusCode).toBe(412); // the first writer's ETag is now stale
    expect((await audits(orgA, 'billing.spending_limit.updated')).length).toBe(1);
  });

  it('validates input: positive integer minor units as strings, ISO currency, bounded thresholds, project must exist', async () => {
    const base = { scope: 'org', monthlyCapMinor: '5000', currency: 'SAR' };
    for (const bad of [
      { ...base, monthlyCapMinor: '0' },
      { ...base, monthlyCapMinor: '1.5' },
      { ...base, monthlyCapMinor: '-5' },
      { ...base, monthlyCapMinor: 5000 },
      { ...base, monthlyCapMinor: '1e3' },
      { ...base, currency: 'sar' },
      { ...base, alertThresholds: [80, 80] },
      { ...base, alertThresholds: [0] },
      { ...base, alertThresholds: [101] },
      { ...base, scope: 'team' },
      { ...base, projectId: uuid() }, // org scope takes no project
      { ...base, scope: 'project' }, // project scope needs one
      { ...base, fourEyesAboveMinor: '-1' },
    ])
      expect((await put('dave', bad, '"2"')).statusCode, JSON.stringify(bad)).toBe(422);
    expect((await put('dave', { ...base, scope: 'project', projectId: uuid() })).statusCode).toBe(
      404,
    );
  });

  it("refuses a cap below this month's spend (422 spend_approval_required)", async () => {
    const r = await put(
      'dave',
      { scope: 'org', monthlyCapMinor: (ratedNow - 1n).toString(), currency: 'SAR' },
      '"2"',
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('spend_approval_required');
  });

  it('is tenant isolated', async () => {
    expect(
      (await call('bob', 'GET', '/v1/billing/spending-limits', undefined, orgB)).json().items,
    ).toEqual([]);
    const b = await put(
      'bob',
      { scope: 'org', monthlyCapMinor: '100', currency: 'SAR' },
      undefined,
      orgB,
    );
    expect(b.statusCode).toBe(200);
    expect((await call('dave', 'GET', '/v1/billing/spending-limits')).json().items).toHaveLength(1);
  });
});

describe('spend enforcement (SpendService.evaluate)', () => {
  const spend = () => app.get(SpendService);
  const subject = { kind: 'quote' as const, id: uuid() };
  let capRoom = 0n;

  it('allows what fits under the cap and requires approval for what does not', async () => {
    const limit = (await call('dave', 'GET', '/v1/billing/spending-limits')).json().items[0];
    const ratedNow = BigInt((await call('carol', 'GET', '/v1/usage/summary')).json().totalMinor);
    capRoom = BigInt(limit.monthlyCapMinor) - ratedNow; // 2000 above spend after the previous test
    expect(capRoom).toBe(2000n);
    expect(await spend().evaluate(orgA, { amountMinor: '500', currency: 'SAR' })).toMatchObject({
      allowed: true,
      requiresApproval: false,
    });
    const over = await spend().evaluate(orgA, { amountMinor: '2500', currency: 'SAR', subject });
    expect(over).toMatchObject({ allowed: false, requiresApproval: true, approvalId: null });
    expect(over.exceeded[0]).toMatchObject({ scope: 'org', capMinor: limit.monthlyCapMinor });
    await expect(
      spend().assertAllowed(orgA, { amountMinor: '2500', currency: 'SAR' }),
    ).rejects.toMatchObject({ code: 'spend_approval_required' });
    // another currency has no cap here
    expect(await spend().evaluate(orgA, { amountMinor: '999999', currency: 'USD' })).toMatchObject({
      allowed: true,
    });
    await expect(
      spend().evaluate(orgA, { amountMinor: '1.5', currency: 'SAR' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('an approved approval for exactly this subject and a covering amount lets it through; others do not', async () => {
    const res = await call('erin', 'POST', '/v1/billing/spend-approvals', {
      quoteId: subject.id,
      amount: '2500',
      currency: 'SAR',
      reason: 'launch',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(
      (await spend().evaluate(orgA, { amountMinor: '2500', currency: 'SAR', subject })).allowed,
    ).toBe(false); // still pending
    expect(
      (
        await call('dave', 'POST', `/v1/billing/spend-approvals/${id}/decision`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await spend().evaluate(orgA, { amountMinor: '2500', currency: 'SAR', subject }),
    ).toMatchObject({ allowed: true, approvalId: id });
    expect(
      (await spend().evaluate(orgA, { amountMinor: '2501', currency: 'SAR', subject })).allowed,
    ).toBe(false); // more than approved
    expect(
      (
        await spend().evaluate(orgA, {
          amountMinor: '2500',
          currency: 'SAR',
          subject: { kind: 'quote', id: uuid() },
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await spend().evaluate(orgA, {
          amountMinor: '2500',
          currency: 'SAR',
          subject: { kind: 'operation', id: subject.id },
        })
      ).allowed,
    ).toBe(false);
  });
});

describe('spend approvals', () => {
  const request = (who: string, over: object = {}, org = orgA) =>
    call(
      who,
      'POST',
      '/v1/billing/spend-approvals',
      { quoteId: uuid(), amount: '9000', currency: 'SAR', reason: 'need it', ...over },
      org,
    );
  const decide = (who: string, id: string, body: object = { decision: 'approve' }, org = orgA) =>
    call(who, 'POST', `/v1/billing/spend-approvals/${id}/decision`, body, org);

  it('developers request; viewers cannot; requests need Idempotency-Key, one open request per subject', async () => {
    expect((await request('carol')).statusCode).toBe(403);
    const quoteId = uuid();
    const key = { 'idempotency-key': 'same-key-1' };
    const body = { quoteId, amount: '9000', currency: 'SAR', reason: 'need it' };
    const a = await call('erin', 'POST', '/v1/billing/spend-approvals', body, orgA, key);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      status: 'pending',
      fourEyes: true,
      amountMinor: '9000',
      requesterUserId: ids.erin,
      subjectKind: 'quote',
    });
    const replay = await call('erin', 'POST', '/v1/billing/spend-approvals', body, orgA, key);
    expect(replay.json().id).toBe(a.json().id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      (
        await call('erin', 'POST', '/v1/billing/spend-approvals', body, orgA, {
          'idempotency-key': 'another',
        })
      ).statusCode,
    ).toBe(409);
    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/billing/spend-approvals',
      headers: {
        cookie: cookieHeader(jars.erin!),
        'x-csrf-token': jars.erin!.nuzm_csrf!,
        'x-nuzm-org': orgA,
      },
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
    expect((await audits(orgA, 'billing.spend_approval.requested')).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('validates the request', async () => {
    for (const bad of [
      { quoteId: undefined, amount: '9000' },
      { operationId: uuid(), amount: '9000' }, // both subjects
      { amount: '0' },
      { amount: '12.5' },
      { amount: 9000 },
      { currency: 'sar' },
      { reason: '' },
      { reason: 'x'.repeat(501) },
      { quoteId: 'nope' },
    ])
      expect((await request('erin', bad)).statusCode, JSON.stringify(bad)).toBe(422);
    expect((await request('erin', { quoteId: undefined, operationId: uuid() })).statusCode).toBe(
      404,
    ); // unknown operation
  });

  it('approvers see every request, others only their own; nothing leaks across organizations', async () => {
    const mine = (await call('erin', 'GET', '/v1/billing/spend-approvals?limit=200')).json();
    expect(mine.items.every((a: Row) => a.requesterUserId === ids.erin)).toBe(true);
    const aliceReq = await request('alice', { amount: '700' });
    const all = (await call('dave', 'GET', '/v1/billing/spend-approvals?limit=200')).json()
      .items as Row[];
    expect(all.some((a) => a.requesterUserId === ids.erin)).toBe(true);
    expect(all.some((a) => a.id === aliceReq.json().id)).toBe(true);
    expect(mine.items.some((a: Row) => a.id === aliceReq.json().id)).toBe(false);
    expect(
      (await call('erin', 'GET', '/v1/billing/spend-approvals?status=nonsense')).statusCode,
    ).toBe(422);
    expect(
      (await call('bob', 'GET', '/v1/billing/spend-approvals', undefined, orgB)).json().items,
    ).toEqual([]);
    expect(
      (await decide('bob', aliceReq.json().id, { decision: 'approve' }, orgB)).statusCode,
    ).toBe(404); // cross-tenant id
  });

  it('four-eyes: the requester can never decide their own request; a second approver can; a decision is final', async () => {
    const r = (await request('alice')).json();
    expect(r.fourEyes).toBe(true);
    const self = await decide('alice', r.id);
    expect(self.statusCode).toBe(403);
    expect(
      (await h.env.sql(`SELECT status FROM billing.spend_approvals WHERE id=$1`, [r.id]))[0]!
        .status,
    ).toBe('pending');
    const ok = await decide('dave', r.id, { decision: 'approve', note: 'ok' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: 'approved',
      decidedBy: ids.dave,
      decisionNote: 'ok',
    });
    expect((await decide('dave', r.id, { decision: 'deny' })).statusCode).toBe(409);
    expect((await decide('alice', r.id)).statusCode).toBe(409);
    expect(
      (await audits(orgA, 'billing.spend_approval.decided')).some(
        (a) => a.after.decision === 'approved',
      ),
    ).toBe(true);
  });

  it('only billing managers decide (not developers or viewers), with a valid decision and a recent MFA', async () => {
    const r = (await request('erin')).json();
    expect((await decide('erin', r.id)).statusCode).toBe(403);
    expect((await decide('carol', r.id)).statusCode).toBe(403);
    expect((await decide('dave', r.id, { decision: 'maybe' })).statusCode).toBe(422);
    expect((await decide('dave', 'not-a-uuid')).statusCode).toBe(404);
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '2 days' WHERE user_id = $1`,
      [ids.dave],
    );
    const stale = await decide('dave', r.id);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().code).toBe('step_up_required');
    await h.env.sql(`UPDATE identity.sessions SET mfa_verified_at = now() WHERE user_id = $1`, [
      ids.dave,
    ]);
    const denied = await decide('dave', r.id, { decision: 'deny', note: 'too much' });
    expect(denied.json()).toMatchObject({ status: 'denied' });
    const mine = (await call('erin', 'GET', '/v1/billing/spend-approvals?status=denied')).json();
    expect(mine.items.map((a: Row) => a.id)).toContain(r.id);
  });

  it('below the org four-eyes threshold the requester may decide their own request', async () => {
    const limit = (await call('dave', 'GET', '/v1/billing/spending-limits')).json().items[0];
    const set = await call(
      'dave',
      'PUT',
      '/v1/billing/spending-limits',
      {
        scope: 'org',
        monthlyCapMinor: limit.monthlyCapMinor,
        currency: 'SAR',
        fourEyesAboveMinor: '1000',
      },
      orgA,
      { 'if-match': `"${limit.version}"` },
    );
    expect(set.statusCode).toBe(200);
    const small = (await request('alice', { amount: '1000' })).json();
    expect(small.fourEyes).toBe(false);
    expect((await decide('alice', small.id)).json().status).toBe('approved');
    const big = (await request('alice', { amount: '1001' })).json();
    expect(big.fourEyes).toBe(true);
    expect((await decide('alice', big.id)).statusCode).toBe(403);
  });

  it('an expired request cannot be decided, shows as expired, and a new request for the subject is allowed', async () => {
    const quoteId = uuid();
    const r = (await request('erin', { quoteId })).json();
    await h.env.sql(
      `ALTER TABLE billing.spend_approvals DISABLE TRIGGER spend_approval_guard; UPDATE billing.spend_approvals SET expires_at = now() - interval '1 minute' WHERE id = '${r.id}'; ALTER TABLE billing.spend_approvals ENABLE TRIGGER spend_approval_guard`,
    );
    const d = await decide('dave', r.id);
    expect(d.statusCode).toBe(409);
    expect(d.json().detail).toMatch(/expired/);
    expect(
      (await call('erin', 'GET', '/v1/billing/spend-approvals?status=expired'))
        .json()
        .items.map((a: Row) => a.id),
    ).toContain(r.id);
    const again = await request('erin', { quoteId });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(r.id);
  });

  it('notifies approvers of a request and the requester of the decision', async () => {
    const before = (await notes(orgA, 'billing.spend_approval_requested')).length;
    const r = (await request('erin')).json();
    const sent = (await notes(orgA, 'billing.spend_approval_requested'))
      .slice(before)
      .map((n) => n.user_id);
    expect(new Set(sent)).toEqual(new Set([ids.alice, ids.dave]));
    const decidedBefore = (await notes(orgA, 'billing.spend_approval_decided')).length;
    await decide('alice', r.id);
    const decided = (await notes(orgA, 'billing.spend_approval_decided')).slice(decidedBefore);
    expect(decided.map((n) => n.user_id)).toEqual([ids.erin]);
  });

  it('approval records are final and permanent at the database level', async () => {
    const r = (await request('erin')).json();
    await decide('dave', r.id);
    const attempts = [
      `UPDATE billing.spend_approvals SET amount_minor = 1 WHERE id = '${r.id}'`,
      `UPDATE billing.spend_approvals SET status = 'denied' WHERE id = '${r.id}'`,
      `DELETE FROM billing.spend_approvals WHERE id = '${r.id}'`,
      `TRUNCATE billing.spend_approvals`,
    ];
    for (const sql of attempts) await expect(h.env.sql(sql), sql).rejects.toThrow();
    // four-eyes is also a table constraint, not only service logic
    const p = (await request('erin', { amount: '4242' })).json();
    await expect(
      h.env.sql(
        `UPDATE billing.spend_approvals SET status='approved', decided_by=requester_user_id, decided_at=now() WHERE id=$1`,
        [p.id],
      ),
    ).rejects.toThrow(/check/i);
    // runtime roles cannot delete or truncate either
    await expect(
      h.env.app.withOrg(orgA, (c) => c.query(`DELETE FROM billing.spend_approvals`)),
    ).rejects.toThrow();
  });
});
