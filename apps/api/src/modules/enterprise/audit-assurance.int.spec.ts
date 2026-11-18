import 'reflect-metadata';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { AuditAssuranceService, type SignedExport } from './audit-assurance.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
const h = new Harness();
let app: App;
let officer: { id: string; jar: Record<string, string> };
let admin: { id: string; jar: Record<string, string> };
let secondApprover: { id: string; jar: Record<string, string> };
let orgA = '';
let seq = 0;
const sql = (q: string, p?: unknown[]) => h.env.sql(q, p);
const call = (
  who: { jar: Record<string, string> },
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: object,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(who.jar),
      'x-csrf-token': who.jar.nuzm_admin_csrf!,
      ...(method === 'POST' ? { 'idempotency-key': `k-${++seq}` } : {}),
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });

async function asOwner<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: h.env.adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  admin = await h.platformUser(app, 'root', ['platform_admin']);
  secondApprover = await h.platformUser(app, 'second', ['platform_admin']);
  const owner = await h.createUser('own-audit');
  const jar = await h.sessionFor(app, owner);
  const r = await app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.nuzm_csrf! },
    payload: { name: 'Audit Org' },
  });
  orgA = r.json().id;
});
afterAll(() => h.close());

describe('audit hash chain: verification, tamper detection, signed export', () => {
  it('verifies every chain and exports a signed manifest that verifies', async () => {
    const svc = app.get(AuditAssuranceService);
    const v = await svc.verifyAll();
    expect(v.ok).toBe(true);
    expect(v.chains.length).toBeGreaterThanOrEqual(1);
    const ex = await svc.export({ orgId: orgA });
    expect(ex.manifest.rows).toBeGreaterThan(0);
    expect(ex.manifest.chains[0]).toMatchObject({ chainKey: orgA });
    expect(svc.verifyExport(ex)).toBeNull();
  });
  it('detects a tampered export (body, manifest, signature) and a tampered chain', async () => {
    const svc = app.get(AuditAssuranceService);
    const ex = await svc.export({ orgId: orgA });
    const lines = ex.body.split('\n');
    expect(svc.verifyExport({ ...ex, body: lines.slice(1).join('\n') })).toMatch(
      /digest|row count/,
    );
    expect(svc.verifyExport({ ...ex, body: ex.body.replace('"success"', '"failure"') })).toMatch(
      /digest/,
    );
    expect(
      svc.verifyExport({ ...ex, manifest: { ...ex.manifest, rows: ex.manifest.rows + 1 } }),
    ).toMatch(/signature/);
    expect(svc.verifyExport({ ...ex, signature: '00'.repeat(32) } as SignedExport)).toMatch(
      /signature/,
    );
    // tamper with the stored chain (as the database owner, triggers off): the daily verification must notice
    await asOwner(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `UPDATE audit.audit_logs SET outcome = 'failure' WHERE id = (SELECT id FROM audit.audit_logs WHERE org_id = $1 ORDER BY chain_seq LIMIT 1)`,
        [orgA],
      );
    });
    const v = await svc.verifyAll();
    expect(v.ok).toBe(false);
    expect(v.broken.map((b) => b.chainKey)).toContain(orgA);
  });
});

describe('audit retention (GET/PUT /v1/admin/audit-retention)', () => {
  it('shows the audit dataset policies, the proposal minimum, and says archival is not available', async () => {
    const r = await call(officer, 'GET', '/v1/admin/audit-retention');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.dataset).toBe('audit.audit_logs');
    expect(b.policies.every((p: any) => p.dataset === 'audit.audit_logs')).toBe(true);
    expect(b.minimumRetainDays).toBe(395);
    expect(b.archival.available).toBe(false);
    expect(b.preview.execution).toBe('not-built');
  });
  it('rejects retention below the minimum (422 below_minimum_retention) and creates a new VERSION otherwise', async () => {
    const put = (body: object) => call(officer, 'PUT', '/v1/admin/audit-retention', body);
    const low = await put({
      dataClass: 'personal',
      retainDays: 100,
      archiveAfterDays: 50,
      basis: 'too short for audit',
    });
    expect(low.statusCode).toBe(422);
    expect(low.json().code).toBe('below_minimum_retention');
    const ok = await put({
      dataClass: 'personal',
      retainDays: 2555,
      archiveAfterDays: 395,
      basis: 'Counsel memo draft (D-34 pending)',
      baseVersion: 1,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      dataset: 'audit.audit_logs',
      version: 2,
      retainDays: 2555,
      status: 'proposal',
    });
    expect(
      (
        await put({
          dataClass: 'personal',
          retainDays: 2555,
          archiveAfterDays: 395,
          basis: 'Counsel memo draft (D-34 pending)',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBeLessThan(300);
    expect(
      (
        await put({
          dataClass: 'personal',
          dataset: 'metering.usage_events',
          retainDays: 2555,
          archiveAfterDays: 395,
          basis: 'x y z',
        })
      ).statusCode,
    ).toBe(422);
    const acts = (
      await sql(`SELECT action FROM audit.audit_logs WHERE action = 'audit.retention.changed'`)
    ).length;
    expect(acts).toBeGreaterThanOrEqual(1);
    expect(
      (
        await call(admin, 'PUT', '/v1/admin/audit-retention', {
          dataClass: 'personal',
          retainDays: 3000,
          archiveAfterDays: 400,
          basis: 'again here',
          baseVersion: 2,
        })
      ).statusCode,
    ).toBeLessThan(300);
  });
  it("a legal hold keeps an organization's audit rows out of every archive candidate count", async () => {
    // age the organization's audit rows past the archive cutoff (as the owner: the log is append-only for runtime roles)
    await asOwner(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `UPDATE audit.audit_logs SET occurred_at = now() - interval '3000 days' WHERE org_id = $1`,
        [orgA],
      );
    });
    const before = (await call(officer, 'GET', '/v1/admin/audit-retention')).json().preview;
    expect(before.archiveCandidates).toBeGreaterThan(0);
    expect(before.heldCandidates).toBe(0);
    // dual-approval hold on the organization (M04)
    const create = await call(officer, 'POST', '/v1/admin/compliance/legal-holds', {
      scope: { orgId: orgA },
      reason: 'Litigation hold for the audit retention test',
      approvers: [officer.id, secondApprover.id],
    });
    expect(create.statusCode).toBe(201);
    const holdId = create.json().id;
    const decide = await call(secondApprover, 'POST', '/v1/admin/compliance/legal-holds', {
      holdId,
      decision: 'approve',
      note: 'approved',
    });
    expect(decide.json().status).toBe('active');
    const after = (await call(officer, 'GET', '/v1/admin/audit-retention')).json();
    expect(after.legalHolds.some((x: any) => x.orgId === orgA && x.status === 'active')).toBe(true);
    expect(after.preview.heldCandidates).toBeGreaterThan(0);
    expect(after.preview.eligibleToArchive).toBeLessThan(before.eligibleToArchive + 1);
    expect(after.preview.eligibleToArchive + after.preview.heldCandidates).toBeLessThanOrEqual(
      before.archiveCandidates,
    );
    // nothing was deleted by any of this
    expect(
      (await sql(`SELECT count(*)::int AS n FROM audit.audit_logs WHERE org_id = $1`, [orgA]))[0]!
        .n,
    ).toBeGreaterThan(0);
  });
});

describe('policy versions (GET/PUT /v1/admin/policy-versions)', () => {
  const put = (who: typeof admin, body: object, etag?: string) =>
    call(
      who,
      'PUT',
      '/v1/admin/policy-versions',
      body,
      etag === undefined ? {} : { 'if-match': etag },
    );
  const v1 = {
    policyKey: 'security',
    title: 'Information security policy',
    bodyRef: 'docs/policies/security-v1.md',
    effectiveFrom: '2026-12-01',
  };
  it('publishes versions with If-Match; stale or missing ETag is refused; the version is immutable', async () => {
    expect((await put(admin, v1)).statusCode).toBe(428);
    const a = await put(admin, v1, '"0"');
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ version: 1, status: 'draft' });
    expect(a.headers.etag).toBe('"1"');
    expect((await put(admin, v1, '"0"')).statusCode).toBe(412);
    const b = await put(
      admin,
      {
        ...v1,
        bodyRef: 'docs/policies/security-v2.md',
        approvedBy: secondApprover.id,
        approvalRef: 'docs/reports/approvals/security-v2.md',
      },
      '"1"',
    );
    expect(b.json()).toMatchObject({
      version: 2,
      status: 'approved',
      approvedBy: secondApprover.id,
    });
    expect(
      (await put(admin, { ...v1, approvedBy: admin.id, approvalRef: 'self' }, '"2"')).statusCode,
    ).toBe(422); // no self-approval
    expect(
      (await call(admin, 'GET', '/v1/admin/policy-versions?policyKey=security')).headers.etag,
    ).toBe('"2"');
    expect(
      (await call(admin, 'GET', '/v1/admin/policy-versions?history=true&policyKey=security')).json()
        .items,
    ).toHaveLength(2);
    await expect(sql(`UPDATE compliance.policy_versions SET title = 'x'`)).rejects.toThrow();
    expect(
      (await sql(`SELECT action FROM audit.audit_logs WHERE action = 'policy.version.published'`))
        .length,
    ).toBe(2);
  });
  it('needs admin:compliance:manage to publish', async () => {
    const sec = await h.platformUser(app, 'sec-only', ['security']);
    expect((await call(sec, 'GET', '/v1/admin/policy-versions')).statusCode).toBe(200);
    expect((await put(sec, v1, '"2"')).statusCode).toBe(403);
  });
});
