import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from 'yaml';
import type { Db } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSink } from '../../common/audit';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { MockRegionRegistry } from './internal/residency/regions';
import { ResidencyService } from './internal/residency/residency.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, { id: string; jar: Record<string, string> }> = {};
let seq = 0;
const ids: Record<string, string> = {};

const call = (
  who: string,
  method: 'GET' | 'PUT',
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
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });
const admin = (who: string, method: 'GET' | 'POST', url: string, body?: object, key?: string) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!.jar),
      'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
      ...(method === 'POST' ? { 'idempotency-key': key ?? `k-${++seq}-${Math.random()}` } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
const mk = async (who: string, name: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
      payload: { name },
    })
  ).json().id as string;
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const svc = () => app.get(ResidencyService);
const ask = (over: Row = {}) =>
  svc().evaluate({
    orgId: orgA,
    dataClass: 'personal',
    targetRegion: 'ae-dubai',
    purpose: 'provisioning',
    operation: 'write',
    ...over,
  } as any);
const newAsm = (who: string, over: Row = {}) =>
  admin(who, 'POST', '/v1/admin/compliance/transfer-assessments', {
    dataClass: 'personal',
    region: 'AE',
    risk: 'medium',
    mitigations: 'Contract clauses and encryption in transit',
    expiresAt: soon(180),
    orgId: orgA,
    ...over,
  });
const approve = (who: string, id: string) =>
  admin(who, 'POST', '/v1/admin/compliance/transfer-assessments', {
    assessmentId: id,
    decision: 'approve',
    note: 'reviewed',
  });

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  orgA = await mk('alice', 'Residency A');
  orgB = await mk('bob', 'Residency B');
  await h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
    [orgA, ids.carol],
  );
  staff.officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  staff.root = await h.platformUser(app, 'root', ['platform_admin']);
  staff.sec = await h.platformUser(app, 'sec', ['security']);
});
afterAll(() => h.close());

describe('the seeded platform floor', () => {
  it('equals the proposal in spec/compliance/defaults.yaml', async () => {
    const d = parse(
      readFileSync(join(__dirname, '../../../../../spec/compliance/defaults.yaml'), 'utf8'),
    ) as any;
    const r = (
      await h.env.sql(
        `SELECT version, allowed FROM compliance.residency_policies WHERE org_id IS NULL`,
      )
    )[0]!;
    expect(r.version).toBe(1);
    expect((r.allowed as any).floorByClass).toEqual(d.residency.floor);
  });
});

describe('the organization policy API', () => {
  it('shows the default (version 0, in-Kingdom only) with the floor to every member, even a viewer', async () => {
    const r = await call('carol', 'GET', '/v1/compliance/residency-policy');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      version: 0,
      isDefault: true,
      mode: 'in_kingdom_only',
      allowedCountriesByClass: {},
      exceptions: [],
      updatedAt: null,
    });
    expect(r.json().floor.byClass.credentials).toBe('in_kingdom_only');
    expect(r.headers.etag).toBeTruthy();
  });
  it('only owners and admins change it', async () => {
    expect(
      (await call('carol', 'PUT', '/v1/compliance/residency-policy', { mode: 'in_kingdom_only' }))
        .statusCode,
    ).toBe(403);
  });
  it('creates version 1 without a precondition, then needs If-Match: 428 without, 412 when stale', async () => {
    const one = await call('alice', 'PUT', '/v1/compliance/residency-policy', {
      mode: 'allow_listed',
      allowedCountriesByClass: { personal: ['AE'] },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ version: 1, isDefault: false, mode: 'allow_listed' });
    expect(
      (await call('alice', 'PUT', '/v1/compliance/residency-policy', { mode: 'in_kingdom_only' }))
        .statusCode,
    ).toBe(428);
    expect(
      (
        await call(
          'alice',
          'PUT',
          '/v1/compliance/residency-policy',
          { mode: 'in_kingdom_only' },
          orgA,
          { 'if-match': '"7"' },
        )
      ).statusCode,
    ).toBe(412);
    const two = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', changeNote: 'tighten' },
      orgA,
      { 'if-match': one.headers.etag as string },
    );
    expect(two.statusCode).toBe(200);
    expect(two.json().version).toBe(2);
    expect(
      await count(`SELECT count(*) n FROM compliance.residency_policies WHERE org_id = $1`, [orgA]),
    ).toBe(2); // versions are rows, never edits
  });
  it('refuses to loosen the floor: countries or assessments for a class the platform keeps in the Kingdom are 422 policy_below_floor', async () => {
    const cur = await call('alice', 'GET', '/v1/compliance/residency-policy');
    const r = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'allow_listed', allowedCountriesByClass: { credentials: ['AE'] } },
      orgA,
      { 'if-match': cur.headers.etag as string },
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().code ?? r.json().type).toContain('policy_below_floor');
    expect(JSON.stringify(r.json())).toContain('allowedCountriesByClass.credentials');
  });
  it('validates the body field by field', async () => {
    const cur = await call('alice', 'GET', '/v1/compliance/residency-policy');
    const r = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'anywhere', allowedCountriesByClass: { personal: ['ae'] }, exceptions: ['x'] },
      orgA,
      { 'if-match': cur.headers.etag as string },
    );
    expect(r.statusCode).toBe(422);
    const body = JSON.stringify(r.json());
    for (const f of ['mode', 'allowedCountriesByClass.personal', 'exceptions'])
      expect(body).toContain(f);
  });
  it('another organization has its own policy and cannot see this one; the audit trail records the change without the lists', async () => {
    expect(
      (await call('bob', 'GET', '/v1/compliance/residency-policy', undefined, orgB)).json(),
    ).toMatchObject({ version: 0, isDefault: true });
    expect(
      (await call('bob', 'GET', '/v1/compliance/residency-policy', undefined, orgA)).statusCode,
    ).toBe(404);
    const a = await h.env.sql(
      `SELECT after FROM audit.audit_logs WHERE org_id = $1 AND action = 'compliance.residency.policy_updated' ORDER BY chain_seq`,
      [orgA],
    );
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a)).not.toContain('"AE"');
  });
  it('RLS: a database session of another organization cannot read the rows, but everybody can read the platform floor', async () => {
    const r = await h.env.app.withOrg(orgB, (c) =>
      c.query(`SELECT org_id FROM compliance.residency_policies`),
    );
    expect(r.rows.every((x) => x.org_id === null)).toBe(true);
    await expect(
      h.env.sql(`UPDATE compliance.residency_policies SET mode = 'allow_listed'`),
    ).rejects.toThrow(/versioned/);
    await expect(h.env.sql(`DELETE FROM compliance.residency_policies`)).rejects.toThrow(
      /versioned/,
    );
  });
});

describe('evaluate() against the real database', () => {
  it('uses the stored policy: in-Kingdom allowed, GCC denied, then allow-listed after a change (cache invalidated by the write)', async () => {
    const cur = await call('alice', 'GET', '/v1/compliance/residency-policy');
    await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only' },
      orgA,
      { 'if-match': cur.headers.etag as string },
    );
    expect((await ask({ targetRegion: 'sa-central' })).decision).toBe('allow');
    const denied = await ask({ targetRegion: 'ae-dubai' });
    expect(denied.decision).toBe('deny');
    expect(denied.reasons[0]!.message.en.length).toBeGreaterThan(5);
    const c2 = await call('alice', 'GET', '/v1/compliance/residency-policy');
    await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'allow_listed', allowedCountriesByClass: { personal: ['AE'] } },
      orgA,
      { 'if-match': c2.headers.etag as string },
    );
    expect((await ask({ targetRegion: 'ae-dubai' })).decision).toBe('allow'); // no stale answer after the write
  });
  it('a denial is audited with a decision reference and no personal data', async () => {
    const r = await ask({ targetRegion: 'us-east', purpose: 'backup test' });
    expect(r.decision).toBe('deny');
    const ev = await h.env.sql(
      `SELECT detail, resource_id FROM audit.audit_logs WHERE org_id = $1 AND action = 'compliance.residency.evaluate_denied' AND resource_id = $2`,
      [orgA, r.evidenceRef],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({
      decision: 'deny',
      dataClass: 'personal',
      targetRegion: 'us-east',
      operation: 'write',
      policyVersion: expect.any(Number),
    });
  });
  it('an allow on a write path is not audited (denials and failures are)', async () => {
    const before = await count(
      `SELECT count(*) n FROM audit.audit_logs WHERE action LIKE 'compliance.residency.evaluate_%'`,
    );
    await ask({ targetRegion: 'sa-central' });
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action LIKE 'compliance.residency.evaluate_%'`,
      ),
    ).toBe(before);
  });
  it('a bad request is a programming error (422), not a decision', async () => {
    await expect(ask({ dataClass: 'secrets' })).rejects.toThrow(/Validation failed/);
    await expect(ask({ orgId: 'x' })).rejects.toThrow(/Validation failed/);
    await expect(ask({ operation: 'maybe' })).rejects.toThrow(/Validation failed/);
  });
  it('a named processor must be in the ROPA: unknown denies; once registered for the class it passes', async () => {
    const unknown = await ask({ targetRegion: 'sa-central', processorId: 'Example PSP' });
    expect(unknown.decision).toBe('deny');
    expect(unknown.reasons.map((x) => x.code)).toEqual(['processor_not_in_ropa']);
    const cur = (await admin('officer', 'GET', '/v1/admin/compliance/ropa?adapterKind=psp')).json()
      .items[0];
    const save = await admin('officer', 'POST', '/v1/admin/compliance/ropa', {
      entryKey: 'adapter:psp',
      baseVersion: cur.version,
      activity: cur.activity,
      purpose: cur.purpose,
      dataClasses: ['financial', 'personal'],
      processors: [
        { name: 'Example PSP', role: 'processor', region: 'SA', dataClasses: ['financial'] },
      ],
      regions: ['SA'],
    });
    expect(save.statusCode).toBe(201);
    expect(
      (
        await ask({
          targetRegion: 'sa-central',
          processorId: 'Example PSP',
          dataClass: 'financial',
        })
      ).decision,
    ).toBe('allow');
    const wrongClass = await ask({
      targetRegion: 'sa-central',
      processorId: 'Example PSP',
      dataClass: 'personal',
    });
    expect(wrongClass.reasons.map((x) => x.code)).toEqual(['processor_class_not_registered']);
  });
});

describe('transfer assessments', () => {
  let asmId = '';
  it('are requested by one person and decided by a DIFFERENT one (API and database both refuse a self-decision)', async () => {
    const r = await newAsm('officer');
    expect(r.statusCode).toBe(201);
    asmId = r.json().id;
    expect(r.json()).toMatchObject({
      status: 'pending',
      orgId: orgA,
      region: 'AE',
      expired: false,
      requestedBy: staff.officer!.id,
    });
    expect((await approve('officer', asmId)).statusCode).toBe(403);
    await expect(
      h.env.sql(
        `UPDATE compliance.transfer_assessments SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1`,
        [asmId],
      ),
    ).rejects.toThrow(/transfer_assessments_check|violates check/);
    const ok = await approve('root', asmId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: staff.root!.id });
    expect((await approve('root', asmId)).statusCode).toBe(200); // the same decision again
    expect(
      (
        await admin('root', 'POST', '/v1/admin/compliance/transfer-assessments', {
          assessmentId: asmId,
          decision: 'reject',
        })
      ).statusCode,
    ).toBe(409);
  });
  it('validate their scope, replay by Idempotency-Key, need a manager, and are immutable', async () => {
    expect((await newAsm('officer', { region: 'SA' })).statusCode).toBe(422);
    expect((await newAsm('officer', { dataClass: 'public' })).statusCode).toBe(422);
    expect((await newAsm('officer', { expiresAt: soon(800) })).statusCode).toBe(422); // more than 730 days
    expect((await newAsm('officer', { expiresAt: soon(-1) })).statusCode).toBe(422);
    expect(
      (await newAsm('officer', { orgId: '00000000-0000-4000-8000-0000000000aa' })).statusCode,
    ).toBe(422);
    expect((await newAsm('sec')).statusCode).toBe(403);
    const a = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/transfer-assessments',
      {
        dataClass: 'financial',
        region: 'eu',
        risk: 'low',
        mitigations: 'Standard clauses and a DPA',
        expiresAt: soon(90),
      },
      'asm-key-1',
    );
    const b = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/transfer-assessments',
      {
        dataClass: 'financial',
        region: 'eu',
        risk: 'low',
        mitigations: 'Standard clauses and a DPA',
        expiresAt: soon(90),
      },
      'asm-key-1',
    );
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().id).toBe(a.json().id);
    await expect(
      h.env.sql(`UPDATE compliance.transfer_assessments SET region = 'US' WHERE id = $1`, [asmId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM compliance.transfer_assessments WHERE id = $1`, [asmId]),
    ).rejects.toThrow(/never deleted/);
    expect(
      (
        await admin('root', 'POST', '/v1/admin/compliance/transfer-assessments', {
          assessmentId: '00000000-0000-4000-8000-000000000000',
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(404);
  });
  it('lists and filters', async () => {
    const all = (
      await admin('officer', 'GET', '/v1/admin/compliance/transfer-assessments?limit=50')
    ).json().items as Row[];
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(
      (await admin('officer', 'GET', '/v1/admin/compliance/transfer-assessments?status=approved'))
        .json()
        .items.every((x: Row) => x.status === 'approved'),
    ).toBe(true);
    expect(
      (await admin('officer', 'GET', '/v1/admin/compliance/transfer-assessments?status=bogus'))
        .statusCode,
    ).toBe(422);
  });
  it('an approved assessment, referenced by the policy, lets an in-Kingdom-only organization move that data to that country (and nothing else)', async () => {
    const cur = await call('alice', 'GET', '/v1/compliance/residency-policy');
    const put = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', exceptions: [asmId] },
      orgA,
      { 'if-match': cur.headers.etag as string },
    );
    expect(put.statusCode).toBe(200);
    const ok = await ask({ targetRegion: 'ae-dubai' });
    expect(ok).toMatchObject({ decision: 'allow', assessmentId: asmId });
    expect((await ask({ targetRegion: 'de-frankfurt' })).decision).toBe('deny'); // another region
    expect((await ask({ targetRegion: 'ae-dubai', dataClass: 'financial' })).decision).toBe('deny'); // another class
  });
  it('a policy may not rely on a pending, foreign or credentials assessment; an expired one is 422 assessment_expired', async () => {
    const cur = async () =>
      (await call('alice', 'GET', '/v1/compliance/residency-policy')).headers.etag as string;
    const pending = (await newAsm('officer', { dataClass: 'financial' })).json().id;
    const r1 = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', exceptions: [pending] },
      orgA,
      { 'if-match': await cur() },
    );
    expect(r1.statusCode).toBe(422);
    const foreign = (await newAsm('officer', { orgId: orgB })).json().id;
    await approve('root', foreign);
    const r2 = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', exceptions: [foreign] },
      orgA,
      { 'if-match': await cur() },
    );
    expect(r2.statusCode).toBe(422);
    const cred = (await newAsm('officer', { dataClass: 'credentials', orgId: null })).json().id;
    await approve('root', cred);
    const r3 = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', exceptions: [cred] },
      orgA,
      { 'if-match': await cur() },
    );
    expect(r3.statusCode).toBe(422);
    expect(JSON.stringify(r3.json())).toContain('policy_below_floor');
    // an assessment that expires: approved with a short life, then time passes
    const short = (
      await newAsm('officer', {
        dataClass: 'customer-content',
        expiresAt: new Date(Date.now() + 3000).toISOString(),
        orgId: orgA,
      })
    ).json().id;
    expect((await approve('root', short)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 3300));
    const r4 = await call(
      'alice',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only', exceptions: [short] },
      orgA,
      { 'if-match': await cur() },
    );
    expect(r4.statusCode).toBe(422);
    expect(JSON.stringify(r4.json())).toContain('assessment_expired');
    expect(
      (await admin('officer', 'GET', '/v1/admin/compliance/transfer-assessments?expired=true'))
        .json()
        .items.map((x: Row) => x.id),
    ).toContain(short);
    // an expired request cannot be approved
    const stale = (
      await newAsm('officer', { expiresAt: new Date(Date.now() + 2000).toISOString() })
    ).json().id;
    await new Promise((r) => setTimeout(r, 2300));
    const late = await approve('root', stale);
    expect(late.statusCode).toBe(422);
    expect(JSON.stringify(late.json())).toContain('assessment_expired');
  });
  it('the live assessment of an expired exception stops working in evaluate(): the expiry revokes the permission by itself', async () => {
    const policy = (await call('alice', 'GET', '/v1/compliance/residency-policy')).json();
    expect(policy.exceptions).toContain(asmId);
    const moved = new ResidencyService(h.env.app, app.get(AuditSink), new MockRegionRegistry(), {
      defaultMode: 'in_kingdom_only',
      cacheTtlMs: 0,
      maxAssessmentDays: 730,
      clock: () => new Date(Date.now() + 400 * 86_400_000),
    });
    const r = await moved.evaluate({
      orgId: orgA,
      dataClass: 'personal',
      targetRegion: 'ae-dubai',
      purpose: 'provisioning',
      operation: 'write',
    });
    expect(r.decision).toBe('deny');
    expect(r.reasons.map((x) => x.code)).toContain('assessment_expired');
  });
});

describe('fail closed (AC-M04-02)', () => {
  const real = () => h.env.app;
  const broken = (which: 'withoutScope' | 'withOrg' | 'withPlatformScope'): Db => {
    const d = real();
    const boom = async () => {
      throw new Error(`injected failure in ${which}`);
    };
    return new Proxy(d, {
      get: (t, p) => (p === which ? boom : ((t as any)[p]?.bind?.(t) ?? (t as any)[p])),
    }) as Db;
  };
  const mkSvc = (db: Db, regions = new MockRegionRegistry()) =>
    new ResidencyService(db, app.get(AuditSink), regions, {
      defaultMode: 'in_kingdom_only',
      cacheTtlMs: 0,
      maxAssessmentDays: 730,
    });
  const req = {
    orgId: '',
    dataClass: 'personal',
    targetRegion: 'sa-central',
    purpose: 'provisioning',
    operation: 'write',
  } as any;

  it.each([
    ['the floor cannot be read', 'withoutScope', {}],
    ['the organization policy cannot be read', 'withOrg', {}],
    ['the ROPA cannot be read', 'withPlatformScope', { processorId: 'Example PSP' }],
  ] as const)(
    '%s: even an in-Kingdom write is DENIED, with the precaution reason',
    async (_n, which, extra) => {
      const r = await mkSvc(broken(which)).evaluate({ ...req, orgId: orgA, ...extra });
      expect(r.decision).toBe('deny');
      expect(r.reasons.map((x) => x.code)).toEqual(['residency_unavailable']);
      expect(r.reasons[0]!.message.ar.length).toBeGreaterThan(5);
      expect(r.policyVersion).toBeNull();
    },
  );
  it('a failure on a read path also denies (the restrictive choice), and the failure is audited', async () => {
    const r = await mkSvc(broken('withOrg')).evaluate({
      ...req,
      orgId: orgA,
      operation: 'read',
      purpose: 'read-path failure test',
    });
    expect(r.decision).toBe('deny');
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.residency.evaluate_failed' AND org_id = $1`,
        [orgA],
      ),
    ).toBeGreaterThanOrEqual(4);
  });
  it('a broken region registry and a missing floor deny too', async () => {
    const badRegions = {
      resolve: () => {
        throw new Error('registry down');
      },
    } as unknown as MockRegionRegistry;
    expect((await mkSvc(real(), badRegions).evaluate({ ...req, orgId: orgA })).decision).toBe(
      'deny',
    );
    // a floor that is missing: simulate with a database that returns no floor row
    const noFloor = new Proxy(real(), {
      get: (t, p) =>
        p === 'withoutScope'
          ? async (fn: any) => fn({ query: async () => ({ rows: [] }) })
          : ((t as any)[p]?.bind?.(t) ?? (t as any)[p]),
    }) as Db;
    const r = await mkSvc(noFloor).evaluate({ ...req, orgId: orgA });
    expect(r.decision).toBe('deny');
    expect(r.reasons[0]!.code).toBe('residency_unavailable');
  });
  it('a failing audit write never turns a refusal into a pass', async () => {
    const failingAudit = {
      record: async () => {
        throw new Error('audit down');
      },
    } as unknown as AuditSink;
    const s = new ResidencyService(real(), failingAudit, new MockRegionRegistry(), {
      defaultMode: 'in_kingdom_only',
      cacheTtlMs: 0,
      maxAssessmentDays: 730,
    });
    expect((await s.evaluate({ ...req, orgId: orgA, targetRegion: 'us-east' })).decision).toBe(
      'deny',
    );
  });
});

describe('performance (proposal: p95 < 20 ms)', () => {
  it('evaluate() answers 5,000 cached decisions with p95 well under 20 ms', async () => {
    const s = new ResidencyService(
      h.env.app,
      { record: async () => undefined } as unknown as AuditSink,
      new MockRegionRegistry(),
      { defaultMode: 'in_kingdom_only', cacheTtlMs: 60_000, maxAssessmentDays: 730 },
    );
    const regionsList = ['sa-central', 'ae-dubai', 'de-frankfurt', 'us-east', 'sa-pending'];
    for (const r of regionsList)
      await s.evaluate({
        orgId: orgA,
        dataClass: 'personal',
        targetRegion: r,
        purpose: 'warm up',
        operation: 'write',
      }); // warm the cache
    const times: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t0 = performance.now();
      await s.evaluate({
        orgId: orgA,
        dataClass: i % 2 ? 'personal' : 'financial',
        targetRegion: regionsList[i % regionsList.length]!,
        purpose: 'benchmark',
        operation: 'read',
      });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(20);
    console.log(
      `residency evaluate p50=${times[2500]!.toFixed(3)} ms p95=${p95.toFixed(3)} ms p99=${times[4950]!.toFixed(3)} ms (5,000 sequential cached evaluations)`,
    );
  });
});
