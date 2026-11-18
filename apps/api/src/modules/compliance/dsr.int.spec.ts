import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsService, type Db } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { DsrRegistry, NOT_APPLICABLE, type DsrHandler } from './internal/dsr/handlers';
import { DsrService } from './internal/dsr/dsr.service';
import { loadDsrConfig } from './internal/dsr/types';
import { ExportService } from './internal/exports/export.service';
import { LocalExportSink, NoExportSink } from './internal/exports/export-sink';
import { ComplianceJobs } from './internal/jobs';
import { gunzipSync } from 'node:zlib';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let orgQ = '';
let exportDir = '';
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, { id: string; jar: Record<string, string> }> = {};
const ids: Record<string, string> = {};
let seq = 0;

const call = (
  who: string,
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  org = orgA,
  key: string | null = method === 'POST' ? `k-${++seq}-${Math.random()}` : null,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
const admin = (who: string, url: string, body: object, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: cookieHeader(staff[who]!.jar),
      'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
      'idempotency-key': key ?? `a-${++seq}-${Math.random()}`,
    },
    payload: body,
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
const addMember = (org: string, user: string, role = 'viewer') =>
  h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [org, user, role],
  );
// the worker role discovers work across organizations (as in a deployment with WORKER_DATABASE_URL); the app's own instance runs request-driven
const jobs = () =>
  new ComplianceJobs(
    app.get(OperationsService),
    app.get(DsrService),
    app.get(ExportService),
    app.get<Db>(DB),
    new OperationsService(h.env.worker),
    'test-worker',
    false,
  );
const run = () => jobs().runDue(100);
const open = (who: string, body: object, org = orgA, key?: string | null) =>
  call(who, 'POST', '/v1/compliance/data-subject-requests', body, org, key as string);
const getReq = (who: string, id: string, org = orgA) =>
  call(who, 'GET', `/v1/compliance/data-subject-requests/${id}`, undefined, org);
const task = (r: Row, handler: string) => r.tasks.find((t: Row) => t.handler === handler);
const dbRow = async (id: string) =>
  (await h.env.sql(`SELECT * FROM compliance.dsr_requests WHERE id = $1`, [id]))[0] as Row;
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);

// a handler the tests can make fail: proves retry, partial results and that failures never leak
const flaky = { mode: 'ok' as 'ok' | 'fail' | 'fail2', calls: 0 };
const flakyHandler: DsrHandler = {
  name: 'flaky',
  datasets: ['flaky.table'],
  export: async () => {
    flaky.calls++;
    if (flaky.mode === 'fail' || (flaky.mode === 'fail2' && flaky.calls <= 2))
      throw new Error('boom: connection to carol@example.test lost');
    return NOT_APPLICABLE;
  },
  erase: async () => NOT_APPLICABLE,
  rectify: async () => NOT_APPLICABLE,
};

beforeAll(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'nuzm-exports-'));
  process.env.EXPORT_LOCAL_DIR = exportDir;
  process.env.DSR_KICK = 'off'; // tests run the jobs themselves
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  app.get(DsrRegistry).register(flakyHandler);
  for (const n of ['alice', 'bob', 'carol', 'dave']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  orgA = await mk('alice', 'DSR A');
  orgB = await mk('bob', 'DSR B');
  orgQ = await mk('alice', 'DSR quota');
  await addMember(orgA, ids.carol!);
  await addMember(orgA, ids.dave!);
  staff.officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  staff.root = await h.platformUser(app, 'root', ['platform_admin']);
});
afterAll(() => h.close());

describe('opening a request', () => {
  it('a member asks about themselves: 201 received, due in 30 days, an operation, no tasks yet', async () => {
    const r = await open('carol', { type: 'access' });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({
      type: 'access',
      status: 'received',
      subjectRef: `member:${ids.carol}`,
      identityMethod: 'session',
      slaState: 'ok',
      hasDetails: false,
      tasks: [],
      reasonCode: null,
      downloadUrl: null,
    });
    expect(b.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const days = (Date.parse(b.dueAt) - Date.parse(b.receivedAt)) / 86_400_000;
    expect(days).toBeCloseTo(30, 3);
    expect(
      await count(`SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.dsr.opened'`),
    ).toBeGreaterThan(0);
  });
  it('needs an Idempotency-Key, and a retry with the same key returns the same request', async () => {
    const none = await open('carol', { type: 'access' }, orgA, null);
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(none.json())).toContain('idempotency_key_required');
    const a = await open('carol', { type: 'portability' }, orgA, 'same-key');
    const b = await open('carol', { type: 'portability' }, orgA, 'same-key');
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(
      await count(
        `SELECT count(*) n FROM compliance.dsr_requests WHERE requested_by = $1 AND idempotency_key = 'same-key'`,
        [ids.carol],
      ),
    ).toBe(1);
  });
  it('validates the type, the subject and the details', async () => {
    expect((await open('carol', { type: 'erase-everything' })).statusCode).toBe(422);
    expect((await open('carol', {})).statusCode).toBe(422);
    expect((await open('carol', { type: 'access', subjectRef: 'bad ref!' })).statusCode).toBe(422);
    expect((await open('carol', { type: 'access', details: 'text' })).statusCode).toBe(422);
    expect((await open('carol', { type: 'correction' })).statusCode).toBe(422); // needs details.patch
    expect(
      (await open('carol', { type: 'access', details: { text: 'x'.repeat(2001) } })).statusCode,
    ).toBe(422);
  });
  it('a request about someone else is for administrators and needs the identity check in writing', async () => {
    const other = { type: 'access', subjectRef: `member:${ids.dave}` };
    expect((await open('carol', other)).statusCode).toBe(403); // a viewer cannot
    const missing = await open('alice', other);
    expect(missing.statusCode).toBe(422);
    expect(JSON.stringify(missing.json())).toContain('dsr_identity_unverified');
    const short = await open('alice', { ...other, identityAttestation: 'ok' });
    expect(short.statusCode).toBe(422);
    const ok = await open('alice', {
      ...other,
      identityAttestation: 'Checked the signed form and a call-back to the registered number',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      identityMethod: 'org_attestation',
      subjectRef: other.subjectRef,
    });
  });
  it('free-text details are sealed: stored as ciphertext, never returned, never in the audit trail', async () => {
    const text = 'Please find everything about invoice SECRET-MARKER-77';
    const r = await open('dave', { type: 'access', details: { text } });
    expect(r.statusCode).toBe(201);
    expect(r.json().hasDetails).toBe(true);
    expect(JSON.stringify(r.json())).not.toContain('SECRET-MARKER');
    const row = await dbRow(r.json().id);
    expect(row.details_enc).toMatch(/^enc:v1:/);
    expect(row.details_enc).not.toContain('SECRET-MARKER');
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE after::text LIKE '%SECRET-MARKER%' OR detail::text LIKE '%SECRET-MARKER%'`,
      ),
    ).toBe(0);
    await run();
  });
});

describe('who sees what', () => {
  it('a member lists and reads only their own requests; an administrator sees all of the organization', async () => {
    const mine = await call('dave', 'GET', '/v1/compliance/data-subject-requests');
    expect(mine.statusCode).toBe(200);
    for (const x of mine.json().items) expect(x.subjectRef === `member:${ids.dave}`).toBe(true);
    const all = await call('alice', 'GET', '/v1/compliance/data-subject-requests?limit=100');
    expect(all.json().items.length).toBeGreaterThan(mine.json().items.length);
    const carols = (await call('carol', 'GET', '/v1/compliance/data-subject-requests')).json()
      .items[0];
    expect((await getReq('dave', carols.id)).statusCode).toBe(404); // someone else's
    expect((await getReq('alice', carols.id)).statusCode).toBe(200);
    expect((await getReq('alice', 'not-a-uuid')).statusCode).toBe(404);
  });
  it('filters by status and type', async () => {
    const r = await call(
      'alice',
      'GET',
      '/v1/compliance/data-subject-requests?type=portability&status=received',
    );
    expect(r.statusCode).toBe(200);
    for (const x of r.json().items) expect([x.type, x.status]).toEqual(['portability', 'received']);
  });
  it('another organization sees nothing: 403 for a non-member, 404 by id, and RLS under the hood', async () => {
    const id = (await call('alice', 'GET', '/v1/compliance/data-subject-requests')).json().items[0]
      .id;
    expect((await getReq('bob', id, orgA)).statusCode).toBe(404); // not a member: existence is not revealed
    expect((await getReq('bob', id, orgB)).statusCode).toBe(404);
    const list = await call('bob', 'GET', '/v1/compliance/data-subject-requests', undefined, orgB);
    expect(list.json().items).toEqual([]);
    const db = app.get<Db>(DB);
    const seen = await db.withOrg(orgB, async (c) =>
      Number((await c.query(`SELECT count(*) n FROM compliance.dsr_requests`)).rows[0].n),
    );
    expect(seen).toBe(0);
    const tasks = await db.withOrg(orgB, async (c) =>
      Number((await c.query(`SELECT count(*) n FROM compliance.dsr_tasks`)).rows[0].n),
    );
    expect(tasks).toBe(0);
  });
});

describe('access: the archive reaches the member who asked, and only theirs', () => {
  it('runs identity, then the handlers, then closes fulfilled with a download link', async () => {
    const created = (await open('carol', { type: 'access' })).json();
    const before = await run();
    expect(before.dsr).toBeGreaterThan(0);
    const r = (await getReq('carol', created.id)).json();
    expect(r.status).toBe('fulfilled');
    expect(r.identityVerifiedAt).toBeTruthy();
    expect(r.closedAt).toBeTruthy();
    expect(r.tasks.map((t: Row) => t.handler).sort()).toEqual(
      ['billing', 'consent', 'domain-contacts', 'flaky', 'identity', 'tenancy'].sort(),
    );
    expect(task(r, 'identity')).toMatchObject({ action: 'export', status: 'succeeded' });
    expect(r.outcome.exportId).toBeTruthy();
    expect(r.downloadUrl).toContain(`/v1/compliance/data-subject-requests/${created.id}?download=`);
    // the member downloads their own archive without the export permission
    const dl = await app.inject({
      method: 'GET',
      url: r.downloadUrl,
      headers: { cookie: cookieHeader(jars.carol!), 'x-nuzm-org': orgA },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/gzip');
    const doc = JSON.parse(gunzipSync(dl.rawPayload).toString('utf8'));
    expect(doc.subject).toBe(`member:${ids.carol}`);
    expect(doc.sections.identity.account.email).toBe('carol@example.test');
    expect(doc.sections.tenancy.membership.role).toBe('viewer');
    expect(JSON.stringify(doc)).not.toContain('alice@example.test'); // never someone else's data
    expect(JSON.stringify(doc)).not.toMatch(/token_hash|secret_hash/);
    // the task records hold counts and flags, never the exported data
    const stored = await h.env.sql(
      `SELECT result FROM compliance.dsr_tasks WHERE request_id = $1`,
      [created.id],
    );
    expect(JSON.stringify(stored)).not.toContain('carol@example.test');
  });
  it('a link made for one request does not open another request, nor another organization', async () => {
    const a = (await open('carol', { type: 'access' })).json();
    const b = (await open('dave', { type: 'portability' })).json();
    await run();
    const ra = (await getReq('carol', a.id)).json();
    const rb = (await getReq('dave', b.id)).json();
    const token = new URL(ra.downloadUrl, 'http://x').searchParams.get('download')!;
    // carol's token on dave's request id: she cannot see the request at all
    expect(
      (
        await call(
          'carol',
          'GET',
          `/v1/compliance/data-subject-requests/${b.id}?download=${encodeURIComponent(token)}`,
        )
      ).statusCode,
    ).toBe(404);
    // an administrator can see both requests, but the token belongs to request a only
    expect(
      (
        await call(
          'alice',
          'GET',
          `/v1/compliance/data-subject-requests/${b.id}?download=${encodeURIComponent(token)}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(rb.downloadUrl).toBeTruthy();
    // another organization's member with the token: not found, whatever the id
    expect(
      (
        await call(
          'bob',
          'GET',
          `/v1/compliance/data-subject-requests/${a.id}?download=${encodeURIComponent(token)}`,
          undefined,
          orgB,
        )
      ).statusCode,
    ).toBe(404);
    // garbage
    expect(
      (await call('carol', 'GET', `/v1/compliance/data-subject-requests/${a.id}?download=garbage`))
        .statusCode,
    ).toBe(404);
  });
  it('an expired link or archive is 410, and the request stops advertising it', async () => {
    const created = (await open('dave', { type: 'access' })).json();
    await run();
    const r = (await getReq('dave', created.id)).json();
    const token = new URL(r.downloadUrl, 'http://x').searchParams.get('download')!;
    const later = new ExportService(
      app.get<Db>(DB),
      app.get(AuditSink),
      new LocalExportSink(exportDir),
      app.get(FieldCipher),
      loadDsrConfig(),
      () => app.get(DsrRegistry).all(),
      () => new Date(Date.now() + 20 * 60_000), // link lives 15 minutes
    );
    await expect(later.download(orgA, ids.dave!, token)).rejects.toMatchObject({ status: 410 });
    const muchLater = new ExportService(
      app.get<Db>(DB),
      app.get(AuditSink),
      new LocalExportSink(exportDir),
      app.get(FieldCipher),
      loadDsrConfig(),
      () => app.get(DsrRegistry).all(),
      () => new Date(Date.now() + 4 * 86_400_000), // archive lives 72 hours
    );
    const fresh = await muchLater.linkIfLive(orgA, r.outcome.exportId);
    expect(fresh).toBeNull();
  });
});

describe('execution', () => {
  it('runs one known operation (what a request does right after it is made), exactly once', async () => {
    const r = (await open('carol', { type: 'access' })).json();
    const j = jobs();
    expect(await j.runOne(orgA, r.operationId)).toMatchObject({ dsr: 1, failed: 0 });
    expect((await getReq('carol', r.id)).json().status).toBe('fulfilled');
    expect(await j.runOne(orgA, r.operationId)).toMatchObject({ dsr: 0, exports: 0 }); // finished: not claimable again
    expect(await j.runOne(orgB, r.operationId)).toMatchObject({ dsr: 0 }); // another organization cannot reach it
  });
  it('an operation leased by another worker is not run twice; an expired lease is taken over', async () => {
    const r = (await open('carol', { type: 'access' })).json();
    const ops = app.get(OperationsService);
    expect(
      await ops.claimById(orgA, r.operationId, 'worker-1', { leaseSeconds: 60 }),
    ).toMatchObject({ attempts: 1 });
    expect(await ops.claimById(orgA, r.operationId, 'worker-2')).toBeNull(); // leased
    await h.env.sql(
      `UPDATE platform.operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [r.operationId],
    );
    expect(await ops.claimById(orgA, r.operationId, 'worker-2')).toMatchObject({ attempts: 2 });
    await h.env.sql(
      `UPDATE platform.operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [r.operationId],
    );
    await run();
    expect((await getReq('carol', r.id)).json().status).toBe('fulfilled');
  });
});

describe('correction', () => {
  it('applies the allowed patch and closes fulfilled; the patch is sealed with the details', async () => {
    const r = await open('dave', {
      type: 'correction',
      details: { patch: { displayName: 'Dave Corrected' } },
    });
    expect(r.statusCode).toBe(201);
    await run();
    const done = (await getReq('dave', r.json().id)).json();
    expect(done.status).toBe('fulfilled');
    expect(task(done, 'identity')).toMatchObject({ action: 'rectify', status: 'succeeded' });
    expect(
      (await h.env.sql(`SELECT display_name FROM identity.users WHERE id = $1`, [ids.dave]))[0]!
        .display_name,
    ).toBe('Dave Corrected');
    expect((await dbRow(done.id)).details_enc).not.toContain('Dave Corrected');
  });
  it('refuses a field it does not support, with a recorded reason, and changes nothing', async () => {
    const r = await open('dave', { type: 'correction', details: { patch: { displayName: '' } } });
    await run();
    const done = (await getReq('dave', r.json().id)).json();
    expect(task(done, 'identity')).toMatchObject({ status: 'refused', reasonCode: 'unsupported' });
    expect(done.reason ?? done.tasks.find((t: Row) => t.reason)?.reason).toMatchObject({
      ar: expect.any(String),
      en: expect.any(String),
    });
  });
});

describe('deletion never bypasses what must stay', () => {
  it('a member erased from the organization: the membership goes; billing and consent evidence and the global account are refused with reasons', async () => {
    const r = await open('dave', { type: 'deletion' });
    await run();
    // dave's membership is gone, so he can no longer read: the administrator reads the outcome
    const view = (await getReq('alice', r.json().id)).json();
    expect(view.status).toBe('partially_fulfilled'); // tenancy done, billing and identity refused
    expect(task(view, 'tenancy')).toMatchObject({ action: 'erase', status: 'succeeded' });
    expect(task(view, 'billing')).toMatchObject({
      status: 'refused',
      reasonCode: 'retention_mandatory',
    });
    expect(task(view, 'identity')).toMatchObject({
      status: 'refused',
      reasonCode: 'account_is_global',
    });
    expect(
      await count(`SELECT count(*) n FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
        orgA,
        ids.dave,
      ]),
    ).toBe(0);
    expect(await count(`SELECT count(*) n FROM identity.users WHERE id = $1`, [ids.dave])).toBe(1); // the account stays
    expect((await getReq('dave', r.json().id)).statusCode).toBe(404); // no longer a member
  });
  it('the only owner is never removed: everything refused is rejected with the most specific reason', async () => {
    const r = await open('alice', { type: 'deletion' });
    await run();
    const view = (await getReq('alice', r.json().id)).json();
    expect(view.status).toBe('rejected');
    expect(view.reasonCode).toBe('retention_mandatory'); // outranks last_owner and account_is_global
    expect(task(view, 'tenancy')).toMatchObject({ status: 'refused', reasonCode: 'last_owner' });
    expect(
      await count(`SELECT count(*) n FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
        orgA,
        ids.alice,
      ]),
    ).toBe(1);
  });
  it('a legal hold blocks erasure first, before any handler runs', async () => {
    const hold = await admin('officer', '/v1/admin/compliance/legal-holds', {
      scope: { orgId: orgA },
      reason: 'Litigation hold, matter 2026/77',
      approvers: [staff.officer!.id, staff.root!.id],
    });
    expect(hold.statusCode).toBe(201);
    expect(
      (
        await admin('root', '/v1/admin/compliance/legal-holds', {
          holdId: hold.json().id,
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    await addMember(orgA, ids.dave!); // dave is back, with a membership to protect
    const r = await open('dave', { type: 'deletion' });
    await run();
    const view = (await getReq('dave', r.json().id)).json();
    expect(view.status).toBe('rejected');
    expect(view.reasonCode).toBe('legal_hold_active');
    for (const t of view.tasks.filter((x: Row) => x.handler !== 'flaky'))
      expect(t).toMatchObject({ status: 'refused', reasonCode: 'legal_hold_active' });
    expect(
      await count(`SELECT count(*) n FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
        orgA,
        ids.dave,
      ]),
    ).toBe(1);
    // an access request is not blocked by the hold: reading is allowed
    const a = await open('dave', { type: 'access' });
    await run();
    expect((await getReq('dave', a.json().id)).json().status).toBe('fulfilled');
  });
});

describe('a failing handler', () => {
  it('is retried within the run; success on the third attempt counts', async () => {
    flaky.mode = 'fail2';
    flaky.calls = 0;
    const r = await open('carol', { type: 'access' });
    await run();
    const view = (await getReq('carol', r.json().id)).json();
    expect(task(view, 'flaky')).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(view.status).toBe('fulfilled');
  });
  it('after the attempts are used the task is failed, the rest still completes (partially fulfilled), and the error never reaches the caller', async () => {
    flaky.mode = 'fail';
    flaky.calls = 0;
    const r = await open('carol', { type: 'access' });
    await run();
    const view = (await getReq('carol', r.json().id)).json();
    expect(task(view, 'flaky')).toMatchObject({ status: 'failed', attempts: 3, reasonCode: null });
    expect(view.status).toBe('partially_fulfilled');
    expect(JSON.stringify(view)).not.toContain('boom');
    const stored = (
      await h.env.sql(
        `SELECT error FROM compliance.dsr_tasks WHERE request_id = $1 AND handler = 'flaky'`,
        [view.id],
      )
    )[0]!;
    expect(String(stored.error)).toContain('boom'); // kept for the operator
    expect(flaky.calls).toBe(3);
    flaky.mode = 'ok';
  });
  it('processing a closed request again does nothing', async () => {
    const r = await open('carol', { type: 'access' });
    await run();
    const svc = app.get(DsrService);
    const before = await count(
      `SELECT count(*) n FROM compliance.dsr_tasks WHERE request_id = $1`,
      [r.json().id],
    );
    expect(await svc.process(orgA, r.json().id)).toBe('fulfilled');
    expect(
      await count(`SELECT count(*) n FROM compliance.dsr_tasks WHERE request_id = $1`, [
        r.json().id,
      ]),
    ).toBe(before);
  });
});

describe('database guards (evidence is never rewritten)', () => {
  it('a closed request cannot change, nothing is deleted or truncated, a finished task is frozen, the identity of a request is immutable', async () => {
    const r = (await open('carol', { type: 'access' })).json();
    await run();
    const closed = (await getReq('carol', r.id)).json();
    expect(closed.closedAt).toBeTruthy();
    await expect(
      h.env.sql(`UPDATE compliance.dsr_requests SET reason_code = 'unsupported' WHERE id = $1`, [
        r.id,
      ]),
    ).rejects.toThrow(/closed/);
    await expect(
      h.env.sql(`UPDATE compliance.dsr_requests SET subject_ref = 'org' WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM compliance.dsr_requests WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(h.env.sql(`TRUNCATE compliance.dsr_requests CASCADE`)).rejects.toThrow();
    await expect(
      h.env.sql(`UPDATE compliance.dsr_tasks SET attempts = 9 WHERE request_id = $1`, [r.id]),
    ).rejects.toThrow(/finished task/);
    await expect(
      h.env.sql(`DELETE FROM compliance.dsr_tasks WHERE request_id = $1`, [r.id]),
    ).rejects.toThrow(/never deleted/);
    // an open request cannot skip a step
    const o = (await open('carol', { type: 'access' })).json();
    await expect(
      h.env.sql(
        `UPDATE compliance.dsr_requests SET status = 'fulfilled', closed_at = now() WHERE id = $1`,
        [o.id],
      ),
    ).rejects.toThrow(/illegal data-subject request transition/);
    await run();
  });
  it('the runtime role cannot rewrite what the application never rewrites', async () => {
    const db = app.get<Db>(DB);
    const r = (await open('carol', { type: 'access' })).json();
    await expect(
      db.withOrg(orgA, (c) =>
        c.query(
          `UPDATE compliance.dsr_requests SET due_at = now() + interval '900 days' WHERE id = $1`,
          [r.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withOrg(orgA, (c) => c.query(`DELETE FROM compliance.dsr_requests WHERE id = $1`, [r.id])),
    ).rejects.toThrow(/permission denied/);
    await run();
  });
});

describe('deadline timers', () => {
  it('warns the owners at 70% and escalates at 90%, once each', async () => {
    await run(); // close everything opened above
    const svc = app.get(DsrService);
    const r = (await open('carol', { type: 'access' })).json();
    const rec = Date.parse(r.receivedAt);
    const at = (days: number) => new Date(rec + days * 86_400_000);
    expect(await svc.sweep(at(10))).toMatchObject({ warned: 0, escalated: 0 });
    expect(await svc.sweep(at(21.5))).toMatchObject({ warned: 1, escalated: 0 });
    expect(await svc.sweep(at(22))).toMatchObject({ warned: 0, escalated: 0 }); // once
    expect(await svc.sweep(at(27.5))).toMatchObject({ warned: 0, escalated: 1 });
    expect(await svc.sweep(at(28))).toMatchObject({ warned: 0, escalated: 0 });
    const note = await h.env.sql(
      `SELECT kind, body FROM platform.notifications WHERE org_id = $1 AND user_id = $2 AND kind LIKE 'compliance.dsr_sla_%' ORDER BY kind`,
      [orgA, ids.alice],
    );
    expect(note.map((n: Row) => n.kind)).toEqual([
      'compliance.dsr_sla_escalation',
      'compliance.dsr_sla_warning',
    ]);
    expect(JSON.stringify(note)).toContain(r.id);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.dsr.sla_warning' AND resource_id = $1`,
        [r.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.dsr.escalated' AND resource_id = $1`,
        [r.id],
      ),
    ).toBe(1);
    // overdue shows on the request
    const dto = await svc.get(orgA, { userId: ids.alice!, canManage: true }, r.id);
    expect(dto.slaState).toBe('ok'); // the real clock is nowhere near the deadline
    await run();
  });
  it('a closed request is never warned about, however late', async () => {
    const svc = app.get(DsrService);
    const r = (await open('carol', { type: 'access' })).json();
    await run();
    expect(await svc.sweep(new Date(Date.parse(r.receivedAt) + 40 * 86_400_000))).toMatchObject({
      warned: 0,
      escalated: 0,
    });
  });
  it('re-creates the execution record of a request whose operation was never made', async () => {
    const svc = app.get(DsrService);
    const r = (await open('carol', { type: 'access' })).json();
    await h.env.sql(`UPDATE compliance.dsr_requests SET operation_id = NULL WHERE id = $1`, [r.id]);
    const out = await svc.sweep(new Date(Date.now() + 120_000)); // the request is older than a minute by then
    expect(out.repaired).toBeGreaterThanOrEqual(1);
    expect((await dbRow(r.id)).operation_id).toBeTruthy();
    await run();
    expect((await getReq('carol', r.id)).json().status).toBe('fulfilled');
  });
});

describe('data exports', () => {
  it('are for owners and administrators; a viewer is 403', async () => {
    expect((await call('carol', 'GET', '/v1/compliance/data-exports')).statusCode).toBe(403);
    expect(
      (await call('carol', 'POST', '/v1/compliance/data-exports', { scope: 'org' })).statusCode,
    ).toBe(403);
  });
  it('validates the request and needs an Idempotency-Key', async () => {
    expect(
      (await call('alice', 'POST', '/v1/compliance/data-exports', { scope: 'planet' })).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/compliance/data-exports', {
          scope: 'org',
          subjectRef: 'org',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/compliance/data-exports', {
          scope: 'user',
          subjectRef: 'bad ref',
        })
      ).statusCode,
    ).toBe(422);
    const none = await call(
      'alice',
      'POST',
      '/v1/compliance/data-exports',
      { scope: 'org' },
      orgA,
      null,
    );
    expect(JSON.stringify(none.json())).toContain('idempotency_key_required');
  });
  let exportId = '';
  let downloadUrl = '';
  it('an organization export is accepted (202), replays on the same key (200), then runs to an encrypted archive', async () => {
    const a = await call(
      'alice',
      'POST',
      '/v1/compliance/data-exports',
      { scope: 'org' },
      orgA,
      'exp-1',
    );
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({
      scope: 'org',
      status: 'pending',
      downloadUrl: null,
      bytes: null,
    });
    const b = await call(
      'alice',
      'POST',
      '/v1/compliance/data-exports',
      { scope: 'org' },
      orgA,
      'exp-1',
    );
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    exportId = a.json().id;
    expect((await run()).exports).toBeGreaterThanOrEqual(1);
    const list = (await call('alice', 'GET', '/v1/compliance/data-exports?limit=100')).json();
    const mine = list.items.find((x: Row) => x.id === exportId);
    expect(mine).toMatchObject({ status: 'succeeded', scope: 'org', dsrRequestId: null });
    expect(mine.bytes).toBeGreaterThan(100);
    expect(mine.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(mine.expiresAt) - Date.now()).toBeGreaterThan(71 * 3_600_000);
    expect(mine.downloadUrl).toContain('/v1/compliance/data-exports?download=');
    downloadUrl = mine.downloadUrl;
  });
  it('the stored archive is ciphertext; the link returns the readable archive', async () => {
    const file = join(exportDir, `${orgA}_${exportId}.enc`);
    const stored = readFileSync(file);
    expect(stored.subarray(12, 14).toString('hex')).not.toBe('1f8b'); // not gzip
    expect(stored.toString('latin1')).not.toContain('alice@example.test');
    const list = (await call('alice', 'GET', '/v1/compliance/data-exports?limit=100')).json();
    expect(list.items.find((x: Row) => x.id === exportId).sha256).toBe(
      createHash('sha256').update(stored).digest('hex'),
    );
    const dl = await call('alice', 'GET', downloadUrl);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/gzip');
    const doc = JSON.parse(gunzipSync(dl.rawPayload).toString('utf8'));
    expect(doc).toMatchObject({ organization: orgA, subject: 'org' });
    expect(doc.sections.tenancy.org.name).toBe('DSR A');
    expect(doc.sections.identity.members.map((m: Row) => m.email)).toContain('alice@example.test');
    expect(JSON.stringify(doc)).not.toContain('bob@example.test'); // never another organization
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.export.downloaded' AND resource_id = $1`,
        [exportId],
      ),
    ).toBe(1);
  });
  it('another organization cannot use the link, and a tampered link is not found', async () => {
    const token = new URL(downloadUrl, 'http://x').searchParams.get('download')!;
    expect(
      (
        await call(
          'bob',
          'GET',
          `/v1/compliance/data-exports?download=${encodeURIComponent(token)}`,
          undefined,
          orgB,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'alice',
          'GET',
          `/v1/compliance/data-exports?download=${encodeURIComponent(token.slice(0, -4) + 'AAAA')}`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('bob', 'GET', '/v1/compliance/data-exports', undefined, orgB)).json().items,
    ).toEqual([]);
    expect(
      (await call('bob', 'GET', '/v1/compliance/data-exports', undefined, orgA)).statusCode,
    ).toBe(404); // not a member: existence is not revealed
  });
  it('a user-scope export covers one subject only', async () => {
    const r = await call('alice', 'POST', '/v1/compliance/data-exports', {
      scope: 'user',
      subjectRef: `member:${ids.carol}`,
    });
    expect(r.statusCode).toBe(202);
    await run();
    const item = (await call('alice', 'GET', '/v1/compliance/data-exports?limit=100'))
      .json()
      .items.find((x: Row) => x.id === r.json().id);
    const dl = await call('alice', 'GET', item.downloadUrl);
    const doc = JSON.parse(gunzipSync(dl.rawPayload).toString('utf8'));
    expect(doc.subject).toBe(`member:${ids.carol}`);
    expect(JSON.stringify(doc)).not.toContain('alice@example.test');
  });
  it('an expired link is 410 and an expired archive shows as expired', async () => {
    const mk2 = (offsetMs: number) =>
      new ExportService(
        app.get<Db>(DB),
        app.get(AuditSink),
        new LocalExportSink(exportDir),
        app.get(FieldCipher),
        loadDsrConfig(),
        () => app.get(DsrRegistry).all(),
        () => new Date(Date.now() + offsetMs),
      );
    const token = new URL(downloadUrl, 'http://x').searchParams.get('download')!;
    await expect(mk2(20 * 60_000).download(orgA, ids.alice!, token)).rejects.toMatchObject({
      status: 410,
    });
    const late = await mk2(4 * 86_400_000).list(orgA, { limit: 100 });
    const it2 = late.items.find((x) => x.id === exportId)!;
    expect(it2.status).toBe('expired');
    expect(it2.downloadUrl).toBeNull();
  });
  it('without a sink the deployment says so (422 no_export_sink) instead of writing somewhere unreviewed', async () => {
    const none = new ExportService(
      app.get<Db>(DB),
      app.get(AuditSink),
      new NoExportSink(),
      app.get(FieldCipher),
      loadDsrConfig(),
      () => [],
    );
    await expect(none.request(orgA, ids.alice!, 'k', { scope: 'org' })).rejects.toThrow(
      /No export sink/i,
    );
    expect(none.sinkAvailable()).toBe(false);
  });
  it('at most five are in progress per organization (422 quota_exceeded); another organization is unaffected', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (await call('alice', 'POST', '/v1/compliance/data-exports', { scope: 'org' }, orgQ))
          .statusCode,
      ).toBe(202);
    const sixth = await call(
      'alice',
      'POST',
      '/v1/compliance/data-exports',
      { scope: 'org' },
      orgQ,
    );
    expect(sixth.statusCode).toBe(422);
    expect(JSON.stringify(sixth.json())).toContain('quota_exceeded');
    expect(
      (await call('bob', 'POST', '/v1/compliance/data-exports', { scope: 'org' }, orgB)).statusCode,
    ).toBe(202);
    await run(); // they finish, and the quota frees
    expect(
      (await call('alice', 'POST', '/v1/compliance/data-exports', { scope: 'org' }, orgQ))
        .statusCode,
    ).toBe(202);
    await run();
  });
});
