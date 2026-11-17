import 'reflect-metadata';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
const staff: Record<string, { id: string; jar: Record<string, string> }> = {};
let seq = 0;

const call = async (
  who: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: object,
  key?: string | null,
) => {
  const r = await app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!.jar),
      'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
      ...(key === null || method !== 'POST'
        ? {}
        : { 'idempotency-key': key ?? `k-${++seq}-${Math.random()}` }),
    },
    ...(body ? { payload: body } : {}),
  });
  if (r.statusCode >= 500) throw new Error(`HTTP ${r.statusCode} ${url}: ${r.body.slice(0, 400)}`);
  return r;
};
const hold = (who: string, body: object, key?: string) =>
  call(who, 'POST', '/v1/admin/compliance/legal-holds', body, key);
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);
let orgA = '';
let orgB = '';

/** Run statements as the break-glass role on one connection (the role is NOLOGIN in real life; the test borrows it from the owner). */
async function asBreakGlass<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: h.env.adminUrl });
  await c.connect();
  try {
    await c.query('SET ROLE nuzm_admin_breakglass');
    return await fn(c);
  } finally {
    await c.end();
  }
}
const detach = (
  c: Client,
  partition: string,
  a = staff.officer!.id,
  b = staff.root!.id,
  reason = 'Retention run 2026-11, approved by two people',
) =>
  c.query(`SELECT * FROM audit.detach_partition('metering.usage_events', $1, $2, $3, $4)`, [
    partition,
    a,
    b,
    reason,
  ]);

const insertEvent = (org: string, at: string) =>
  h.env.sql(
    `INSERT INTO metering.usage_events (id, org_id, event_id, meter_id, quantity, unit, window_start, window_end, occurred_at, received_at, source, dimensions, data_region, schema_version, tags, billing_period_start, late, skew_flag, payload_hash)
     VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'compute.vcpu_hours', 1, 'vcpu_hour', $2::timestamptz, $2::timestamptz + interval '1 hour', $2::timestamptz, $2::timestamptz, 'test', '{}', 'sa-pending', 1, '{}', date_trunc('month', $2::timestamptz)::date, false, false, 'h')`,
    [org, at],
  );

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  staff.officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  staff.root = await h.platformUser(app, 'root', ['platform_admin']);
  staff.sec = await h.platformUser(app, 'sec', ['security']);
  staff.support = await h.platformUser(app, 'support', ['support']);
  const a = await h.createUser('owner-a');
  const b = await h.createUser('owner-b');
  const mk = async (u: string, name: string) => {
    const jar = await h.sessionFor(app, u);
    return (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  };
  orgA = await mk(a, 'Hold A');
  orgB = await mk(b, 'Hold B');
});
afterAll(() => h.close());

describe('retention policies', () => {
  it('lists the seeded proposals (6 classes + 2 dataset overrides), all PROPOSAL', async () => {
    const r = await call('officer', 'GET', '/v1/admin/compliance/retention-policies?limit=200');
    expect(r.statusCode).toBe(200);
    const items: Row[] = r.json().items;
    expect(items).toHaveLength(8);
    expect(r.json().preview).toBeNull();
    for (const p of items)
      expect(p).toMatchObject({
        version: 1,
        status: 'proposal',
        createdBy: null,
        approvedBy: null,
      });
    expect(
      items
        .filter((p) => p.dataset)
        .map((p) => p.dataset)
        .sort(),
    ).toEqual(['audit.audit_logs', 'metering.usage_events']);
    expect(
      (
        await call('officer', 'GET', '/v1/admin/compliance/retention-policies?dataClass=financial')
      ).json().items[0],
    ).toMatchObject({ retainDays: 2190 });
  });
  it('is readable by compliance officers, platform admins and security, and by nobody else', async () => {
    for (const w of ['officer', 'root', 'sec'])
      expect((await call(w, 'GET', '/v1/admin/compliance/retention-policies')).statusCode, w).toBe(
        200,
      );
    expect(
      (await call('support', 'GET', '/v1/admin/compliance/retention-policies')).statusCode,
    ).toBe(403);
  });
  it('sets a new version with baseVersion; stale, missing and premature base versions are 409; the same content changes nothing', async () => {
    const body = {
      dataClass: 'personal',
      retainDays: 365,
      archiveAfterDays: 90,
      basis: 'Counsel memo draft',
      baseVersion: 1,
      changeNote: 'shorter',
    };
    const ok = await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', body);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      version: 2,
      retainDays: 365,
      status: 'proposal',
      createdBy: staff.officer!.id,
    });
    expect(
      (await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', body)).statusCode,
    ).toBe(200); // same content, same base: nothing written
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          ...body,
          retainDays: 300,
        })
      ).statusCode,
    ).toBe(409); // stale base (current is 2)
    const { baseVersion: _b, ...noBase } = body;
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          ...noBase,
          retainDays: 300,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          dataClass: 'public',
          dataset: 'metering.meters',
          retainDays: 30,
          archiveAfterDays: 30,
          basis: 'x1y',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(409);
    const hist = (
      await call(
        'officer',
        'GET',
        '/v1/admin/compliance/retention-policies?dataClass=personal&history=true&limit=50',
      )
    )
      .json()
      .items.filter((x: Row) => !x.dataset);
    expect(hist.map((x: Row) => x.version).sort()).toEqual([1, 2]);
  });
  it('an approved policy needs its document and records the human approver; invalid input is 422', async () => {
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          dataClass: 'internal',
          retainDays: 400,
          archiveAfterDays: 90,
          basis: 'counsel',
          baseVersion: 1,
          status: 'approved',
        })
      ).statusCode,
    ).toBe(422);
    const ok = await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
      dataClass: 'internal',
      retainDays: 400,
      archiveAfterDays: 90,
      basis: 'counsel memo',
      baseVersion: 1,
      status: 'approved',
      documentRef: 'memo-2026-11-A',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      status: 'approved',
      documentRef: 'memo-2026-11-A',
      approvedBy: staff.officer!.id,
    });
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          dataClass: 'nonsense',
          retainDays: 10,
          archiveAfterDays: 5,
          basis: 'abc',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('officer', 'PUT', '/v1/admin/compliance/retention-policies', {
          dataClass: 'personal',
          retainDays: 10,
          archiveAfterDays: 50,
          basis: 'abc',
          baseVersion: 2,
        })
      ).statusCode,
    ).toBe(422);
  });
  it('only a manager can write; the rows cannot be updated or deleted', async () => {
    expect(
      (
        await call('sec', 'PUT', '/v1/admin/compliance/retention-policies', {
          dataClass: 'public',
          retainDays: 10,
          archiveAfterDays: 5,
          basis: 'abc',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
    await expect(h.env.sql(`UPDATE audit.retention_policies SET retain_days = 1`)).rejects.toThrow(
      /versioned/,
    );
    await expect(h.env.sql(`DELETE FROM audit.retention_policies`)).rejects.toThrow(/versioned/);
    await expect(h.env.sql(`TRUNCATE audit.retention_policies`)).rejects.toThrow(/append-only/);
  });
  it('execute is refused: archival is not an API action', async () => {
    const r = await call('officer', 'GET', '/v1/admin/compliance/retention-policies?execute=true');
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('break-glass');
  });
});

describe('legal holds (dual approval)', () => {
  let id = '';
  it('a create names two different people, one of them the caller; it is pending and has no effect yet', async () => {
    const body = {
      scope: { orgId: orgA },
      reason: 'Litigation hold, matter 2026/44',
      approvers: [staff.officer!.id, staff.root!.id],
    };
    expect(
      (await hold('officer', { ...body, approvers: [staff.root!.id, staff.sec!.id] })).statusCode,
    ).toBe(403); // the caller is not one of them
    expect(
      (await hold('officer', { ...body, approvers: [staff.officer!.id, staff.support!.id] }))
        .statusCode,
    ).toBe(422); // support cannot approve
    expect((await hold('officer', body, 'hold-1')).statusCode).toBe(201);
    const first = await hold('officer', body, 'hold-1'); // replay
    expect(first.statusCode).toBe(200);
    id = first.json().id;
    expect(first.json()).toMatchObject({
      status: 'pending_approval',
      orgId: orgA,
      requestedBy: staff.officer!.id,
      approverId: staff.root!.id,
      decidedAt: null,
    });
    expect((await hold('officer', body, 'hold-2')).statusCode).toBe(409); // an open hold already covers this scope
  });
  it('only the named second approver can decide; the requester cannot approve their own hold', async () => {
    expect((await hold('officer', { holdId: id, decision: 'approve' })).statusCode).toBe(403);
    expect((await hold('sec', { holdId: id, decision: 'approve' })).statusCode).toBe(403);
    const ok = await hold('root', {
      holdId: id,
      decision: 'approve',
      note: 'Confirmed with counsel',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active', decisionNote: 'Confirmed with counsel' });
    expect((await hold('root', { holdId: id, decision: 'approve' })).statusCode).toBe(200); // the same decision again: nothing changes
    expect((await hold('root', { holdId: id, decision: 'reject' })).statusCode).toBe(409); // it is active now
  });
  it('scope and people are immutable and nothing is deleted', async () => {
    await expect(
      h.env.sql(
        `UPDATE audit.legal_holds SET org_id = NULL, dataset = 'audit.audit_logs' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`UPDATE audit.legal_holds SET status = 'pending_approval' WHERE id = $1`, [id]),
    ).rejects.toThrow(/illegal legal hold transition/);
    await expect(h.env.sql(`DELETE FROM audit.legal_holds WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(h.env.sql(`TRUNCATE audit.legal_holds`)).rejects.toThrow(/append-only/);
  });
  it('a rejected hold never becomes active, and the scope can be requested again', async () => {
    const r = await hold('root', {
      scope: { orgId: orgB },
      reason: 'Possible dispute, to be confirmed',
      approvers: [staff.root!.id, staff.officer!.id],
    });
    expect(r.statusCode).toBe(201);
    expect(
      (await hold('officer', { holdId: r.json().id, decision: 'reject', note: 'No basis' })).json()
        .status,
    ).toBe('rejected');
    expect(
      (
        await hold('root', {
          scope: { orgId: orgB },
          reason: 'New request after rejection',
          approvers: [staff.root!.id, staff.officer!.id],
        })
      ).statusCode,
    ).toBe(201);
  });
  it('release needs a different person than the requester and a reason; releasing again changes nothing', async () => {
    expect(
      (
        await hold('officer', {
          holdId: id,
          action: 'release',
          reason: 'Matter closed, counsel confirmed',
        })
      ).statusCode,
    ).toBe(403);
    const r = await hold('root', {
      holdId: id,
      action: 'release',
      reason: 'Matter closed, counsel confirmed',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'released',
      releasedBy: staff.root!.id,
      releaseReason: 'Matter closed, counsel confirmed',
    });
    expect(
      (
        await hold('root', {
          holdId: id,
          action: 'release',
          reason: 'Matter closed, counsel confirmed',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await hold('root', { holdId: '00000000-0000-4000-8000-000000000000', decision: 'approve' }))
        .statusCode,
    ).toBe(404);
  });
  it('needs a manager, an Idempotency-Key and a valid scope; is audited', async () => {
    expect(
      (
        await hold('sec', {
          scope: { orgId: orgA },
          reason: 'Read-only role tries',
          approvers: [staff.sec!.id, staff.root!.id],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'officer',
          'POST',
          '/v1/admin/compliance/legal-holds',
          {
            scope: { orgId: orgA },
            reason: 'No idempotency key here',
            approvers: [staff.officer!.id, staff.root!.id],
          },
          null,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hold('officer', {
          scope: { orgId: '00000000-0000-4000-8000-0000000000aa' },
          reason: 'An organization that does not exist',
          approvers: [staff.officer!.id, staff.root!.id],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await hold('officer', {
          scope: { dataset: 'no.such_table' },
          reason: 'A dataset that does not exist',
          approvers: [staff.officer!.id, staff.root!.id],
        })
      ).statusCode,
    ).toBe(422);
    for (const a of ['requested', 'created', 'rejected', 'released'])
      expect(
        await count(`SELECT count(*) n FROM audit.audit_logs WHERE action = $1`, [
          `compliance.legalhold.${a}`,
        ]),
        a,
      ).toBeGreaterThanOrEqual(1);
  });
});

describe('retention dry run', () => {
  it('counts what the policy would archive, minus what a legal hold covers, and changes nothing', async () => {
    const future = new Date(Date.now() + 4 * 365 * 86_400_000).toISOString();
    const quiet = () =>
      count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action <> 'compliance.retention.job_run'`,
      );
    const quietBefore = await quiet();
    const plain = (
      await call(
        'officer',
        'GET',
        `/v1/admin/compliance/retention-policies?evaluate=true&asOf=${encodeURIComponent(future)}`,
      )
    ).json().preview;
    expect(await quiet()).toBe(quietBefore); // a dry run writes only its own job_run event and changes nothing else
    expect(plain).toMatchObject({ dryRun: true, proposalPolicies: true });
    const audit = plain.targets.find((t: Row) => t.dataset === 'audit.audit_logs');
    expect(audit.execution).toBe('not-built');
    expect(audit.archiveCandidates).toBeGreaterThan(0);
    expect(audit.heldCandidates).toBe(0);
    expect(audit.eligibleToArchive).toBe(audit.archiveCandidates);
    // an active hold on org A keeps org A's audit rows out of the eligible count
    const h2 = await hold('officer', {
      scope: { orgId: orgA },
      reason: 'Hold to test the dry run',
      approvers: [staff.officer!.id, staff.root!.id],
    });
    await hold('root', { holdId: h2.json().id, decision: 'approve' });
    // the hold's own audit events carry the organization too: count AFTER they were written
    const orgRows = await count(`SELECT count(*) n FROM audit.audit_logs WHERE org_id = $1`, [
      orgA,
    ]);
    const held = (
      await call(
        'officer',
        'GET',
        `/v1/admin/compliance/retention-policies?evaluate=true&asOf=${encodeURIComponent(future)}`,
      )
    )
      .json()
      .preview.targets.find((t: Row) => t.dataset === 'audit.audit_logs');
    expect(held.heldCandidates).toBe(orgRows);
    expect(held.eligibleToArchive).toBe(held.archiveCandidates - orgRows);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.retention.job_run'`,
      ),
    ).toBeGreaterThanOrEqual(2); // both dry runs are audited
    await hold('root', {
      holdId: h2.json().id,
      action: 'release',
      reason: 'Dry run test finished, hold lifted',
    });
  });
  it('with the real clock nothing is old enough yet', async () => {
    const rr = await call(
      'officer',
      'GET',
      '/v1/admin/compliance/retention-policies?evaluate=true',
    );
    if (rr.statusCode !== 200) throw new Error(`DBG ${rr.statusCode} ${rr.body.slice(0, 500)}`);
    const p = rr.json().preview;
    for (const t of p.targets) expect(t.archiveCandidates).toBe(0);
  });
});

describe('archival by partition detach (break-glass)', () => {
  const P1 = 'metering.usage_events_202401';
  const P2 = 'metering.usage_events_202402';
  beforeAll(async () => {
    await h.env.sql(`SELECT metering.ensure_usage_partitions('2024-01-01', 3)`);
    for (const [org, at] of [
      [orgA, '2024-01-10T10:00:00Z'],
      [orgA, '2024-01-11T10:00:00Z'],
      [orgB, '2024-02-05T10:00:00Z'],
      [orgB, '2024-03-05T10:00:00Z'],
    ] as const)
      await insertEvent(org, at);
  });
  it('the dry run lists old partitions with their rows and whether a hold blocks them', async () => {
    const p = (
      await call('officer', 'GET', '/v1/admin/compliance/retention-policies?evaluate=true')
    )
      .json()
      .preview.targets.find((t: Row) => t.dataset === 'metering.usage_events');
    const by = Object.fromEntries(p.partitions.map((x: Row) => [x.partition, x]));
    expect(by[P1]).toMatchObject({ rows: 2, eligible: true, blockedBy: null });
    expect(by[P2]).toMatchObject({ rows: 1, eligible: true });
    expect(p.execution).toBe('partition-detach');
  });
  it('the application roles cannot run the archival function at all', async () => {
    await expect(
      h.env.app.withoutScope((c) =>
        c.query(
          `SELECT * FROM audit.detach_partition('metering.usage_events', $1, $2, $3, 'trying it from the app role')`,
          [P1, staff.officer!.id, staff.root!.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.env.worker.withoutScope((c) =>
        c.query(
          `SELECT * FROM audit.detach_partition('metering.usage_events', $1, $2, $3, 'trying it from the worker')`,
          [P1, staff.officer!.id, staff.root!.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it('refuses one person, ineligible people, a table that is not registered, a partition of another table, the default partition and a recent partition', async () => {
    await asBreakGlass(async (c) => {
      await expect(detach(c, P1, staff.officer!.id, staff.officer!.id)).rejects.toThrow(
        /two different people/,
      );
      await expect(detach(c, P1, staff.officer!.id, staff.sec!.id)).rejects.toThrow(
        /compliance officers or platform admins/,
      );
      await expect(detach(c, P1, staff.officer!.id, staff.root!.id, 'short')).rejects.toThrow(
        /reason/,
      );
      await expect(
        c.query(
          `SELECT * FROM audit.detach_partition('metering.rated_usage', 'metering.rated_usage_202401', $1, $2, 'not a registered table, refused')`,
          [staff.officer!.id, staff.root!.id],
        ),
      ).rejects.toThrow(/not registered/);
      await expect(detach(c, 'metering.usage_events_default')).rejects.toThrow(/default partition/);
      await expect(detach(c, 'metering.nothing_here')).rejects.toThrow(/not a partition/);
      const recent = (
        await c.query(
          `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'metering.usage_events'::regclass AND c.relname ~ '[0-9]{6}$' ORDER BY 1 DESC LIMIT 1`,
        )
      ).rows[0].relname;
      await expect(detach(c, `metering.${recent}`)).rejects.toThrow(
        /newer than the archive cutoff/,
      );
    });
    expect(
      await count(`SELECT count(*) n FROM metering.usage_events WHERE window_start < '2024-04-01'`),
    ).toBe(4); // nothing moved
  });
  it('a legal hold on an organization that has rows in the partition blocks it; a hold on another organization does not', async () => {
    const hid = (
      await hold('officer', {
        scope: { orgId: orgA },
        reason: 'Hold on org A usage records',
        approvers: [staff.officer!.id, staff.root!.id],
      })
    ).json().id;
    await hold('root', { holdId: hid, decision: 'approve' });
    const preview = (
      await call('officer', 'GET', '/v1/admin/compliance/retention-policies?evaluate=true')
    )
      .json()
      .preview.targets.find((t: Row) => t.dataset === 'metering.usage_events');
    const by = Object.fromEntries(preview.partitions.map((x: Row) => [x.partition, x]));
    expect(by[P1]).toMatchObject({ eligible: false, blockedBy: 'legal_hold', heldRows: 2 });
    expect(by[P2]).toMatchObject({ eligible: true });
    await asBreakGlass(async (c) => {
      await expect(detach(c, P1)).rejects.toThrow(/legal_hold_active/);
      expect((await detach(c, P2)).rows[0]).toMatchObject({
        archived_table: 'metering.archived_usage_events_202402',
        rows_archived: '1',
      });
    });
    await hold('root', {
      holdId: hid,
      action: 'release',
      reason: 'Hold lifted so the archive test can continue',
    });
  });
  it('after release the partition detaches: the data is archived (not deleted), locked away from the runtime roles, the parent still works, and the audit event is written', async () => {
    await asBreakGlass(async (c) => {
      expect((await detach(c, P1)).rows[0]).toMatchObject({
        archived_table: 'metering.archived_usage_events_202401',
        rows_archived: '2',
      });
    });
    // the rows still exist (archived), and no longer belong to the parent
    expect(await count(`SELECT count(*) n FROM metering.archived_usage_events_202401`)).toBe(2);
    expect(
      await count(`SELECT count(*) n FROM metering.usage_events WHERE window_start < '2024-02-01'`),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) n FROM pg_inherits WHERE inhrelid = 'metering.archived_usage_events_202401'::regclass`,
      ),
    ).toBe(0);
    // locked away: the runtime roles have no access, forced RLS admits nothing
    await expect(
      h.env.app.withPlatformScope((c) =>
        c.query(`SELECT count(*) FROM metering.archived_usage_events_202401`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.env.worker.withoutScope((c) =>
        c.query(`SELECT count(*) FROM metering.archived_usage_events_202401`),
      ),
    ).rejects.toThrow(/permission denied/);
    const sec = await asBreakGlass((c) =>
      c.query(`SELECT count(*)::int n FROM metering.archived_usage_events_202401`),
    );
    expect(sec.rows[0].n).toBe(0); // even the break-glass role sees nothing through forced RLS: reading an archive is a separate, logged procedure
    // the parent keeps working for new data and the remaining partition is untouched
    await insertEvent(orgB, '2024-03-06T10:00:00Z');
    expect(
      await count(
        `SELECT count(*) n FROM metering.usage_events WHERE window_start >= '2024-03-01' AND window_start < '2024-04-01'`,
      ),
    ).toBe(2);
    // audited, with both people and the policy version
    const ev = await h.env.sql(
      `SELECT detail, actor_user_id FROM audit.audit_logs WHERE action = 'compliance.retention.partition_detached' ORDER BY chain_seq`,
    );
    expect(ev).toHaveLength(2);
    expect(ev[1]!.detail).toMatchObject({
      parent: 'metering.usage_events',
      archivedAs: 'metering.archived_usage_events_202401',
      rows: 2,
      requestedBy: staff.officer!.id,
      approvedBy: staff.root!.id,
      policyStatus: 'proposal',
    });
    // append-only discipline holds: the archive itself cannot be altered row by row either
    await expect(h.env.sql(`DELETE FROM metering.archived_usage_events_202401`)).rejects.toThrow(
      /append-only|immutable|not allowed|never/i,
    );
  });
  it('the audit chain still verifies after archival events were written', async () => {
    const r = await h.env.app.withPlatformScope((c) =>
      c.query(`SELECT * FROM audit.verify_chain('00000000-0000-0000-0000-000000000000')`),
    );
    expect(r.rows[0]).toMatchObject({ ok: true });
  });
});
