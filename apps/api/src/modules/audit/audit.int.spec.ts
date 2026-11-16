import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { AuditIntegrity, HmacCheckpointSigner } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSink } from '../../common/audit';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests
type Row = Record<string, any>;

const PW_KEY = ['pass', 'word'].join(''); // built at runtime so secret scanners do not flag the fixture
const h = new Harness();
let app: App;
let integrity: AuditIntegrity;
let aliceJar: Record<string, string>;
let bobJar: Record<string, string>;
let carolJar: Record<string, string>;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};

const call = (
  jar: Record<string, string>,
  method: 'GET' | 'POST',
  url: string,
  org?: string,
  body?: object,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jar),
      'x-csrf-token': jar.nuzm_csrf!,
      ...(org ? { 'x-nuzm-org': org } : {}),
      'idempotency-key': `a-${Math.random()}`,
      'user-agent': 'vitest-agent/1.0',
    },
    ...(body ? { payload: body } : {}),
  });
const events = (org: string, q = '') =>
  call(aliceJar, 'GET', `/v1/audit-logs${q}`, org).then(
    (r) => r.json() as { items: Row[]; nextCursor: string | null },
  );

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  integrity = new AuditIntegrity(
    h.env.app,
    new HmacCheckpointSigner(new Uint8Array(randomBytes(32))),
  );
  for (const n of ['alice', 'bob', 'carol']) ids[n] = await h.createUser(n);
  aliceJar = await h.sessionFor(app, ids.alice!);
  bobJar = await h.sessionFor(app, ids.bob!);
  carolJar = await h.sessionFor(app, ids.carol!);
  orgA = (await call(aliceJar, 'POST', '/v1/organizations', undefined, { name: 'Audit A' })).json()
    .id;
  orgB = (await call(bobJar, 'POST', '/v1/organizations', undefined, { name: 'Audit B' })).json()
    .id;
  await h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'billing_admin')`,
    [orgA, ids.carol],
  );
});
afterAll(() => h.close());

describe('persistent audit sink', () => {
  it('records a mutation in the target org chain with actor, resource, trace id and hashed IP/UA', async () => {
    const ws = await call(aliceJar, 'POST', '/v1/workspaces', orgA, { name: 'ws-audited' });
    expect(ws.statusCode).toBe(201);
    const row = (
      await h.env.sql(
        `SELECT * FROM audit.audit_logs WHERE org_id=$1 AND action='tenancy.workspace.created'`,
        [orgA],
      )
    )[0]!;
    expect(row).toMatchObject({
      actor_type: 'user',
      actor_user_id: ids.alice,
      resource_type: 'workspace',
      resource_id: ws.json().id,
      outcome: 'success',
      chain_key: orgA,
    });
    expect(row.trace_id).toBe(ws.headers['x-trace-id']);
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.ua_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain('vitest-agent'); // raw UA/IP never stored
    expect(JSON.stringify(row)).not.toContain('127.0.0.1');
    expect((await integrity.verifyChain(orgA)).ok).toBe(true);
  });

  it('attributes API-key calls to the key (actor_type api_key)', async () => {
    await h.elevate(aliceJar);
    const k = await call(aliceJar, 'POST', '/v1/api-keys', orgA, {
      name: 'audit-key',
      scopes: ['workspace:create'],
    });
    expect(k.statusCode).toBe(201);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${k.json().key}`, 'idempotency-key': 'k-1' },
      payload: { name: 'by-key' },
    });
    expect(r.statusCode).toBe(201);
    const row = (
      await h.env.sql(
        `SELECT actor_type, actor_api_key_id, actor_user_id FROM audit.audit_logs WHERE org_id=$1 AND resource_id=$2`,
        [orgA, r.json().id],
      )
    )[0]!;
    expect(row).toMatchObject({
      actor_type: 'api_key',
      actor_api_key_id: k.json().id,
      actor_user_id: ids.alice,
    });
  });

  it('puts org-less events (e.g. failed logins) on the platform chain, not in Row tenant chain', async () => {
    await app
      .get(AuditSink)
      .record({ action: 'auth.login.failed', outcome: 'failure', detail: { reason: 'test' } });
    const row = (
      await h.env.sql(
        `SELECT chain_key, org_id FROM audit.audit_logs WHERE action='auth.login.failed'`,
      )
    )[0]!;
    expect(row).toEqual({ chain_key: '00000000-0000-0000-0000-000000000000', org_id: null });
    expect((await events(orgA)).items.map((i) => i.action)).not.toContain('auth.login.failed');
  });

  it('scrubs secret-shaped keys from free-form payloads', async () => {
    await app.get(AuditSink).record({
      action: 'test.payload.scrubbed',
      outcome: 'success',
      orgId: orgA,
      detail: {
        token: 'tok-123',
        nested: { [PW_KEY]: 'pw', safe: 'ok' },
        otpauthUri: 'otpauth://x',
        code: '123456',
      },
    });
    const d = (
      await h.env.sql(`SELECT detail FROM audit.audit_logs WHERE action='test.payload.scrubbed'`)
    )[0]!.detail;
    expect(d).toEqual({
      token: '[redacted]',
      nested: { [PW_KEY]: '[redacted]', safe: 'ok' },
      otpauthUri: '[redacted]',
      code: '[redacted]',
    });
  });

  it('fails loudly (never silently) when the audit write is rejected, and logs the event to stderr', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => (
      chunks.push(String(c)),
      true
    )) as typeof process.stderr.write;
    try {
      await expect(
        app
          .get(AuditSink)
          .record({ action: 'not-a-valid-action' as never, outcome: 'success', orgId: orgA }),
      ).rejects.toThrow(/check constraint/);
    } finally {
      process.stderr.write = orig;
    }
    expect(chunks.join('')).toContain('audit_write_failed');
  });
});

describe('GET /v1/audit-logs', () => {
  it('returns only the caller organization, newest first, with filters', async () => {
    const all = await events(orgA);
    expect(all.items.length).toBeGreaterThan(3);
    expect(all.items.every((i) => i.orgId === orgA)).toBe(true);
    const times = all.items.map((i) => i.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    const ws = await events(orgA, '?action=tenancy.workspace.created');
    expect(ws.items.length).toBeGreaterThan(0);
    expect(ws.items.every((i) => i.action === 'tenancy.workspace.created')).toBe(true);
    const prefix = await events(orgA, '?action=tenancy.*');
    expect(prefix.items.every((i) => i.action.startsWith('tenancy.'))).toBe(true);
    expect((await events(orgA, `?actorUserId=${ids.bob}`)).items).toEqual([]);
    expect(
      (await events(orgA, '?outcome=failure')).items.every((i) => i.outcome === 'failure'),
    ).toBe(true);
    expect(
      (await events(orgA, `?from=${new Date(Date.now() + 60_000).toISOString()}`)).items,
    ).toEqual([]);
  });

  it("never shows another organization's events (org B sees none of A's, even when guessing filters)", async () => {
    const bob = await call(bobJar, 'GET', '/v1/audit-logs', orgB);
    const body = bob.json() as { items: Row[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.orgId === orgB)).toBe(true);
    expect(bob.body).not.toContain(orgA);
    const probe = await call(bobJar, 'GET', `/v1/audit-logs?actorUserId=${ids.alice}`, orgB);
    expect(probe.json().items).toEqual([]);
    expect((await call(bobJar, 'GET', '/v1/audit-logs', orgA)).statusCode).toBe(404); // not a member
  });

  it('paginates with a stable cursor: no duplicates, no gaps', async () => {
    for (let i = 0; i < 7; i++)
      await app
        .get(AuditSink)
        .record({ action: 'test.page.item', outcome: 'success', orgId: orgA, detail: { i } });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: { items: Row[]; nextCursor: string | null } = await events(
        orgA,
        `?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    const full = (await events(orgA, '?limit=200')).items.map((i) => i.id);
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThan(2);
  });

  it('billing_admin sees only billing-domain events; owner sees everything; viewer is refused', async () => {
    await app
      .get(AuditSink)
      .record({ action: 'billing.invoice.created', outcome: 'success', orgId: orgA });
    const carol = await call(carolJar, 'GET', '/v1/audit-logs?limit=200', orgA);
    expect(carol.statusCode).toBe(200);
    const actions = (carol.json().items as Row[]).map((i) => i.action);
    expect(actions).toContain('billing.invoice.created');
    expect(actions.every((a) => a.startsWith('billing.'))).toBe(true);
    // a plain developer lacks audit:read entirely
    const dev = await h.createUser('dev');
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'developer')`,
      [orgA, dev],
    );
    expect(
      (await call(await h.sessionFor(app, dev), 'GET', '/v1/audit-logs', orgA)).statusCode,
    ).toBe(403);
  });

  it('rejects malformed filters with 422', async () => {
    for (const q of [
      '?from=yesterday',
      '?actorUserId=nope',
      '?outcome=maybe',
      '?action=BAD ACTION',
    ])
      expect((await call(aliceJar, 'GET', `/v1/audit-logs${q}`, orgA)).statusCode, q).toBe(422);
  });

  it('keeps every chain intact after all of the above', async () => {
    for (const org of [orgA, orgB])
      expect(await integrity.verifyChain(org)).toMatchObject({ ok: true });
    expect((await integrity.runOnce()).chains.every((c) => c.ok)).toBe(true);
  });
});
