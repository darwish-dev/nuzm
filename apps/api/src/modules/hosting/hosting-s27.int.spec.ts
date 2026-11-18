import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostingHarness } from './hosting-harness';
import { MeteringIngestService } from '../metering';
import { HostingMetering, dayFractionNanos, nanosToDecimal } from './internal/hosting-metering';
import { DunningHook } from './internal/dunning-hook';
import { UsageService } from './internal/usage.service';
import { SMTP_ATTEMPT_LIMIT, SUSTAINED_CPU_HOURS, detect } from './internal/abuse.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const hh = new HostingHarness();
let nodeId = '';
let plan = '';
let projA = '';
const orgA = () => hh.orgs.A!;
const run = (org: string, id: string) => hh.jobs().runOne(org, id);
const siteRow = async (id: string) =>
  (await hh.env.sql(`SELECT * FROM hosting.sites WHERE id=$1`, [id]))[0] as any;
let n = 0;
async function newSite(createdAt?: string) {
  const r = await hh.createSite('alice', orgA(), plan, 'php:8.3', `s27-${++n}`, projA);
  expect(r.statusCode).toBe(202);
  await run(orgA(), r.json().operationId);
  const id = r.json().site.id as string;
  if (createdAt)
    await hh.env.sql(`UPDATE hosting.sites SET created_at = $2 WHERE id = $1`, [id, createdAt]);
  const s = await siteRow(id);
  return { id, nodeName: s.node_name as string };
}
const events = async (siteId: string, meter?: string) =>
  (
    (await hh.env.sql(
      `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded'`,
    )) as any[]
  )
    .map((r) => r.payload)
    .filter((p) => p.resourceId === siteId && (!meter || p.meterId === meter))
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart));
const sum = (evs: any[]) => evs.reduce((a, e) => a + BigInt(e.quantity.replace('.', '')), 0n);
const report = (
  siteId: string,
  at: string,
  disk: number,
  bw: number,
  extra: { backup?: number; cpu?: number } = {},
) =>
  hh.env.sql(
    `INSERT INTO hosting.site_usage_reports (site_id, org_id, period_start, disk_bytes, inodes, bandwidth_bytes_month, backup_bytes, cpu_seconds) VALUES ($1,$2,$3,$4,10,$5,$6,$7) ON CONFLICT (site_id, period_start) DO UPDATE SET disk_bytes = EXCLUDED.disk_bytes, bandwidth_bytes_month = EXCLUDED.bandwidth_bytes_month`,
    [siteId, orgA(), at, disk, bw, extra.backup ?? 0, extra.cpu ?? 0],
  );

beforeAll(async () => {
  await hh.init();
  await hh.customers();
  projA = await hh.project(orgA());
  plan = await hh.plan('s27', { cpu: 50, mem: 64, disk: 100 });
  nodeId = await hh.activeNode('s27-node');
});
afterAll(() => hh.close());

describe('metering emitters (AC-M06-10): exact fractions, deterministic ids, replay, duplicates', () => {
  it('a day fraction is exact in nanos and the days of a month sum to exactly one site-month (28, 30, 31 days)', () => {
    for (const [y, m, days] of [
      [2026, 0, 31],
      [2026, 1, 28],
      [2026, 3, 30],
      [2028, 1, 29],
    ] as const) {
      let total = 0n;
      for (let d = 1; d <= days; d++) total += dayFractionNanos(new Date(Date.UTC(y, m, d)));
      expect(total, `${y}-${m + 1}`).toBe(1_000_000_000n);
    }
    expect(nanosToDecimal(32_258_080n)).toBe('0.032258080');
  });

  it('fixture 1 (site_months): complete UTC days only, from the day after creation; event_id is deterministic per site and day', async () => {
    const s = await newSite('2026-10-30T12:00:00Z');
    const mt = hh.app.get(HostingMetering);
    expect((await mt.accrue(new Date('2026-11-02T00:00:00Z'))).events).toBe(2); // Oct 31 (last day: the remainder) and Nov 1
    const ev = await events(s.id, 'hosting.site_months');
    expect(ev.map((e) => [e.windowStart.slice(0, 10), e.quantity])).toEqual([
      ['2026-10-31', '0.032258080'],
      ['2026-11-01', '0.033333333'],
    ]);
    expect(
      ev.every(
        (e) =>
          e.source === 'hosting@M06' &&
          e.unit === 'site_month' &&
          e.dataRegion === 'sa-central' &&
          e.dimensions.plan === 's27',
      ),
    ).toBe(true);
    expect(new Set(ev.map((e) => e.eventId)).size).toBe(2);
    // the rest of November: the site-months of the month add up to EXACTLY one
    await mt.accrue(new Date('2026-12-01T00:00:00Z'));
    const nov = (await events(s.id, 'hosting.site_months')).filter((e) =>
      e.windowStart.startsWith('2026-11'),
    );
    expect(nov).toHaveLength(30);
    expect(sum(nov)).toBe(1_000_000_000n);
  });

  it('fixture 2 (disk/backup GiB-months): GiB x day fraction from the latest report, in exact decimals', async () => {
    const s = await newSite('2026-11-01T01:00:00Z');
    await report(s.id, '2026-11-02T03:00:00Z', 2 * 1_073_741_824, 0, { backup: 1_073_741_824 });
    const mt = hh.app.get(HostingMetering);
    await mt.accrue(new Date('2026-11-05T00:00:00Z'));
    const disk = await events(s.id, 'hosting.disk_gb_months');
    // days: Nov 2 (report at 03:00 is AFTER the start of the day but BEFORE its end: used), Nov 3, Nov 4; Nov 1 has no report yet: nothing emitted
    expect(disk.map((e) => e.windowStart.slice(0, 10))).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(
      disk.every(
        (e) =>
          e.quantity ===
            nanosToDecimal(2n * dayFractionNanos(new Date('2026-11-02T00:00:00Z')) * 1n) &&
          e.unit === 'gib_month',
      ),
    ).toBe(true);
    const bk = await events(s.id, 'hosting.backup_gb_months');
    expect(bk).toHaveLength(3);
    expect(bk[0]!.quantity).toBe(
      nanosToDecimal(dayFractionNanos(new Date('2026-11-02T00:00:00Z'))),
    );
  });

  it('fixture 3 (bandwidth): the cumulative monthly counter becomes deltas; a new month restarts; a counter that went down is counted from its new value', async () => {
    const s = await newSite('2026-11-01T01:00:00Z');
    const mt = hh.app.get(HostingMetering);
    await report(s.id, '2026-11-03T10:00:00Z', 0, 1_000_000_000);
    expect(await mt.bandwidth(s.id)).toBe(1);
    expect(await mt.bandwidth(s.id)).toBe(0); // nothing new
    await report(s.id, '2026-11-03T11:00:00Z', 0, 3_000_000_000);
    await mt.bandwidth(s.id);
    await report(s.id, '2026-12-01T00:00:00Z', 0, 500_000_000);
    await mt.bandwidth(s.id);
    await report(s.id, '2026-12-01T01:00:00Z', 0, 100_000_000);
    await mt.bandwidth(s.id);
    const ev = await events(s.id, 'hosting.bandwidth_gb');
    expect(ev.map((e) => e.quantity)).toEqual([
      '1.000000000',
      '2.000000000',
      '0.500000000',
      '0.100000000',
    ]);
    expect(ev.every((e) => e.unit === 'gb')).toBe(true);
  });

  it('REPLAY: wiping the marks and accruing again produces the SAME event ids; through the ingest the aggregates have 0 diff and every duplicate is ignored', async () => {
    const s = await newSite('2026-11-01T00:30:00Z');
    await report(s.id, '2026-11-02T00:10:00Z', 1_073_741_824, 0);
    const mt = hh.app.get(HostingMetering);
    const now = new Date('2026-11-08T00:00:00Z');
    await mt.accrue(now);
    const first = [...(await events(s.id))];
    const ids1 = first.map((e) => e.eventId).sort();
    expect(ids1.length).toBeGreaterThanOrEqual(7);
    const ingest = hh.app.get(MeteringIngestService);
    const producer = { source: 'hosting@M06', orgIds: [orgA()] } as any;
    const r1 = await ingest.ingest(first, producer);
    expect(r1.results.every((r) => r.result === 'accepted')).toBe(true);
    const agg = async () =>
      JSON.stringify(
        await hh.env.sql(
          `SELECT meter_id, granularity, bucket_start, quantity, event_count FROM metering.usage_aggregates WHERE org_id=$1 AND resource_key=$2 ORDER BY meter_id, granularity, bucket_start`,
          [orgA(), s.id],
        ),
      );
    const before = await agg();
    expect(before).toContain('hosting.site_months');
    await hh.env.sql(`DELETE FROM hosting.metering_marks WHERE site_id=$1`, [s.id]);
    await hh.env.sql(
      `DELETE FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'resourceId' = $1`,
      [s.id],
    );
    await mt.accrue(now);
    const second = await events(s.id);
    expect(second.map((e) => e.eventId).sort()).toEqual(ids1); // deterministic: hash(site, day)
    const r2 = await ingest.ingest(second, producer);
    expect(r2.results.every((r) => r.result === 'duplicate')).toBe(true);
    expect(await agg()).toBe(before); // 0 diff
    // a rerun with the marks in place emits nothing at all
    const outboxBefore = (
      await hh.env.sql(`SELECT count(*)::int n FROM platform.outbox WHERE topic='usage.recorded'`)
    )[0] as any;
    await mt.accrue(now);
    expect(
      (
        (
          await hh.env.sql(
            `SELECT count(*)::int n FROM platform.outbox WHERE topic='usage.recorded'`,
          )
        )[0] as any
      ).n,
    ).toBe(outboxBefore.n);
  });
});

describe('dunning: suspension on non-payment and reinstatement (AC-M06-11; real M03 dunning tables, mock-free)', () => {
  it('a suspended/terminated_pending dunning case suspends the organization sites with reason `dunning`; closing it reinstates them; other suspension reasons are never touched', async () => {
    const a = await newSite();
    const b = await newSite();
    const c = await newSite();
    const hook = hh.app.get(DunningHook);
    await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${c.id}`, {
      status: 'suspended',
      reason: 'staff decision',
    });
    expect(await hook.reconcile()).toEqual({ suspended: 0, reinstated: 0 }); // no dunning case yet
    const caseId = crypto.randomUUID();
    await hh.env.sql(
      `SET session_replication_role = replica; INSERT INTO billing.dunning_cases (id, org_id, subscription_id, invoice_id, stage, policy_version, opened_at, stage_changed_at) VALUES ('${caseId}', '${orgA()}', gen_random_uuid(), gen_random_uuid(), 'reminder_2', 1, now(), now())`,
    );
    expect(await hook.reconcile()).toEqual({ suspended: 0, reinstated: 0 }); // reminders do not suspend
    await hh.env.sql(
      `SET session_replication_role = replica; UPDATE billing.dunning_cases SET stage = 'suspended', stage_changed_at = now() WHERE id = '${caseId}'`,
    );
    const r = await hook.reconcile();
    expect(r.suspended).toBeGreaterThanOrEqual(2);
    for (const s of [a, b]) {
      const row = await siteRow(s.id);
      expect([row.status, row.suspended_by]).toEqual(['suspended', 'dunning']);
      expect(hh.stack.nodes.get(row.node_id)!.sites.get(s.nodeName)!.suspended).toBe(true);
    }
    expect((await siteRow(c.id)).suspended_by).toBe('admin'); // already suspended by staff: untouched
    expect((await hook.reconcile()).suspended).toBe(0); // idempotent
    // a customer cannot lift it: the PATCH is staff-only and a site that is suspended cannot be changed
    expect(
      (
        await hh.call('alice', 'PATCH', `/v1/hosting/sites/${a.id}`, { name: 'nope' }, orgA(), {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(409);
    // hold: a case on hold does not block
    await hh.env.sql(
      `SET session_replication_role = replica; UPDATE billing.dunning_cases SET hold = true, hold_reason = 'payment arrangement' WHERE id = '${caseId}'`,
    );
    expect((await hook.reconcile()).reinstated).toBeGreaterThanOrEqual(2);
    await hh.env.sql(
      `SET session_replication_role = replica; UPDATE billing.dunning_cases SET hold = false, hold_reason = NULL WHERE id = '${caseId}'`,
    );
    await hook.reconcile();
    // paid: closed -> reinstated
    await hh.env.sql(
      `SET session_replication_role = replica; UPDATE billing.dunning_cases SET closed_at = now(), closed_reason = 'paid' WHERE id = '${caseId}'`,
    );
    expect((await hook.reconcile()).reinstated).toBeGreaterThanOrEqual(2);
    for (const s of [a, b]) expect((await siteRow(s.id)).status).toBe('active');
    expect((await siteRow(c.id)).status).toBe('suspended');
    await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${c.id}`, {
      status: 'active',
      reason: 'staff lifted it',
    });
  });
});

describe('abuse controls (detectors, cases, actions with reason codes, appeals)', () => {
  it('detector rules on fixtures: sustained CPU, SMTP egress attempts, suspicious process signatures; normal load triggers nothing', () => {
    expect(detect({}, [0, 100, 200, 300])).toEqual([]);
    const busy = [0, 3300, 6600, 9900, 13200];
    expect(detect({}, busy)).toMatchObject([
      {
        detector: 'sustained_cpu',
        severity: 'medium',
        action: 'throttle',
        reasonCode: 'sustained_cpu',
      },
    ]);
    expect(detect({}, busy.slice(0, SUSTAINED_CPU_HOURS))).toEqual([]); // not enough history
    expect(detect({ smtpEgressAttempts: SMTP_ATTEMPT_LIMIT - 1 }, [])).toEqual([]);
    expect(detect({ smtpEgressAttempts: SMTP_ATTEMPT_LIMIT }, [])).toMatchObject([
      { detector: 'smtp_egress', severity: 'high', action: 'suspend' },
    ]);
    expect(detect({ processNames: ['php-fpm', 'XMRig'] }, [])).toMatchObject([
      {
        detector: 'suspicious_process',
        severity: 'critical',
        action: 'suspend',
        evidence: ['process:XMRig'],
      },
    ]);
  });

  it('a detector firing on a usage report opens ONE case and suspends the site with reason `abuse`; repeated reports do not flood the queue', async () => {
    const s = await newSite();
    const site = hh.stack.nodes.get(nodeId)!.sites.get(s.nodeName)!;
    site.processNames = ['php-fpm', 'xmrig'];
    const usage = hh.app.get(UsageService);
    await usage.collect(s.id);
    await usage.collect(s.id);
    await usage.collect(s.id);
    const cases = (
      await hh.admin('support', 'GET', `/v1/admin/hosting/abuse-cases?siteId=${s.id}`)
    ).json().items;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      source: 'detector',
      detector: 'suspicious_process',
      severity: 'critical',
      state: 'actioned',
      reasonCode: 'suspicious_process_signature',
    });
    expect(cases[0].actions[0]).toMatchObject({ action: 'suspend' });
    expect(cases[0].evidenceRefs).toEqual(['process:xmrig']);
    const row = await siteRow(s.id);
    expect([row.status, row.suspended_by, row.suspension_reason]).toEqual([
      'suspended',
      'abuse',
      'suspicious_process_signature',
    ]);
    expect(site.suspended).toBe(true);
  });

  it('sustained CPU throttles (halves process/memory limits on the node) and the customer sees the case without evidence', async () => {
    const s = await newSite();
    const site = hh.stack.nodes.get(nodeId)!.sites.get(s.nodeName)!;
    const before = { ...site.limits };
    for (let h = 4; h >= 1; h--)
      await report(
        s.id,
        new Date(Date.now() - h * 3_600_000 - 3_600_000).toISOString().slice(0, 13) + ':00:00Z',
        0,
        0,
        { cpu: (4 - h) * 3300 },
      );
    site.cpuSeconds = 4 * 3300; // the report of this hour continues the pattern
    await hh.app.get(UsageService).collect(s.id);
    const cases = (
      await hh.admin('host', 'GET', `/v1/admin/hosting/abuse-cases?siteId=${s.id}`)
    ).json().items;
    expect(cases[0]).toMatchObject({ detector: 'sustained_cpu', severity: 'medium' });
    expect(site.limits.maxProcesses).toBe(Math.floor(before.maxProcesses / 2));
    expect(site.limits.memoryMb).toBe(Math.max(64, Math.floor(before.memoryMb / 2)));
    expect((await siteRow(s.id)).status).toBe('active'); // throttled, not suspended
    const mine = (await hh.call('alice', 'GET', `/v1/hosting/sites/${s.id}/abuse-cases`)).json()
      .items[0];
    expect(mine).toMatchObject({ reasonCode: 'sustained_cpu', state: 'actioned' });
    expect(mine).not.toHaveProperty('evidenceRefs');
    expect(mine).not.toHaveProperty('orgId');
    expect(
      (await hh.call('bob', 'GET', `/v1/hosting/sites/${s.id}/abuse-cases`, undefined, hh.orgs.B))
        .statusCode,
    ).toBe(404);
  });

  it('staff open a case (idempotent), action it with a reason code, the customer appeals, a DIFFERENT person decides; overturned lifts the suspension', async () => {
    const s = await newSite();
    const body = {
      siteId: s.id,
      source: 'report',
      severity: 'high',
      reasonCode: 'phishing_report',
      evidenceRefs: ['ticket:SUP-1042', 'url:https://reports.example/abc'],
    };
    expect(
      (await hh.admin('finance', 'POST', '/v1/admin/hosting/abuse-cases', body)).statusCode,
    ).toBe(403);
    expect(
      (
        await hh.admin('support', 'POST', '/v1/admin/hosting/abuse-cases', {
          ...body,
          severity: 'urgent',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await hh.admin('support', 'POST', '/v1/admin/hosting/abuse-cases', body, {}, null))
        .statusCode,
    ).toBe(400);
    const o = await hh.admin(
      'support',
      'POST',
      '/v1/admin/hosting/abuse-cases',
      body,
      {},
      'abuse-key-1',
    );
    expect(o.statusCode).toBe(201);
    const again = await hh.admin(
      'support',
      'POST',
      '/v1/admin/hosting/abuse-cases',
      body,
      {},
      'abuse-key-1',
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(o.json().id);
    const id = o.json().id;
    expect(
      (
        await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/abuse-cases/${id}/appeals`, {
          text: 'this is a mistake, please check',
        })
      ).statusCode,
    ).toBe(409); // not actioned yet
    const act = await hh.admin('support', 'PATCH', `/v1/admin/hosting/abuse-cases/${id}`, {
      action: 'suspend',
      note: 'phishing page confirmed',
    });
    expect(act.statusCode).toBe(200);
    expect((await siteRow(s.id)).suspended_by).toBe('abuse');
    expect(
      (
        await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/abuse-cases/${id}/appeals`, {
          text: 'short',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          `/v1/hosting/sites/${s.id}/abuse-cases/${id}/appeals`,
          { text: 'this is not my site at all' },
          hh.orgs.B,
        )
      ).statusCode,
    ).toBe(404);
    const ap = await hh.call(
      'alice',
      'POST',
      `/v1/hosting/sites/${s.id}/abuse-cases/${id}/appeals`,
      { text: 'The page was hacked and we cleaned it up.' },
    );
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({ state: 'appealed', appeal: { decision: null } });
    expect(
      (
        await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/abuse-cases/${id}/appeals`, {
          text: 'The page was hacked and we cleaned it up.',
        })
      ).statusCode,
    ).toBe(409);
    // the person who actioned the case cannot decide the appeal
    expect(
      (
        await hh.admin('support', 'PATCH', `/v1/admin/hosting/abuse-cases/${id}`, {
          decision: 'overturned',
        })
      ).statusCode,
    ).toBe(403);
    const dec = await hh.admin('host', 'PATCH', `/v1/admin/hosting/abuse-cases/${id}`, {
      decision: 'overturned',
      note: 'cleanup verified',
    });
    expect(dec.statusCode).toBe(200);
    expect(dec.json()).toMatchObject({ state: 'closed', appeal: { decision: 'overturned' } });
    expect((await siteRow(s.id)).status).toBe('active');
    const audit = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action LIKE 'hosting.abuse.case.%' ORDER BY chain_seq`,
    );
    expect(audit.map((x: any) => x.action)).toEqual(
      expect.arrayContaining([
        'hosting.abuse.case.opened',
        'hosting.abuse.case.actioned',
        'hosting.abuse.case.appealed',
        'hosting.abuse.case.appeal_decided',
      ]),
    );
    // the database also refuses the same person for action and decision
    await expect(
      hh.env.sql(
        `UPDATE hosting.abuse_cases SET actioned_by = appeal_decided_by WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/abuse_cases_check/);
  });

  it('closing a case lifts its suspension; a closed case cannot be actioned; reads need admin:hosting:read', async () => {
    const s = await newSite();
    const o = await hh.admin('support', 'POST', '/v1/admin/hosting/abuse-cases', {
      siteId: s.id,
      source: 'staff',
      severity: 'low',
      reasonCode: 'spam_report',
      action: 'suspend',
    });
    expect(o.statusCode).toBe(201);
    expect((await siteRow(s.id)).status).toBe('suspended');
    const closed = await hh.admin('host', 'PATCH', `/v1/admin/hosting/abuse-cases/${o.json().id}`, {
      action: 'close',
      note: 'false positive',
    });
    expect(closed.json().state).toBe('closed');
    expect((await siteRow(s.id)).status).toBe('active');
    expect(
      (
        await hh.admin('host', 'PATCH', `/v1/admin/hosting/abuse-cases/${o.json().id}`, {
          action: 'notify',
        })
      ).statusCode,
    ).toBe(409);
    expect((await hh.admin('finance', 'GET', '/v1/admin/hosting/abuse-cases')).statusCode).toBe(
      403,
    );
    expect(
      (await hh.admin('host', 'GET', `/v1/admin/hosting/abuse-cases/${o.json().id}`)).statusCode,
    ).toBe(200);
  });
});
