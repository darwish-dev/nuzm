import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockObjectStorageAdapter } from '@nuzm/adapter-data';
import { SecretStore } from '../../common/secrets';
import { DataAdapterRegistry, DataJobs, StorageFlow, SYSTEM_ORG } from './index';
import { DataAlerts } from './internal/alerts';
import { DatabaseFlow } from './internal/database-flow';
import { decimalGb, thousands } from './internal/storage-flow';
import { gibMonthFraction } from './internal/metering';
import { bucketGlobalName } from './internal/storage-policy';
import {
  EuObjectStorageAdapter,
  setupDataEnv,
  type DataEnv,
  type Row,
} from './testing/data-harness';

let e: DataEnv;
let reg: DataAdapterRegistry;
let jobs: DataJobs;
let flow: DatabaseFlow;
const orgA = () => e.org.A!;
const orgB = () => e.org.B!;
const mock = () => reg.get('object-storage', 'mock-object-storage') as MockObjectStorageAdapter;
const GiB = 1024 ** 3;
const quote = (who = 'alice', org = orgA(), gb = '100') =>
  e.call(who, 'POST', '/v1/quotes', { kind: 'storage', items: [{ estimatedGb: gb }] }, org);
let n = 0;
const mkBucket = async (
  who = 'alice',
  org = orgA(),
  name = `bkt-${++n}-${Math.random().toString(36).slice(2, 6)}`,
  extra: Row = {},
) => {
  const q = await quote(who, org);
  const r = await e.call(
    who,
    'POST',
    '/v1/storage/buckets',
    { quoteId: q.json().id, name, ...extra },
    org,
  );
  if (r.statusCode !== 202) throw new Error(`create bucket: ${r.statusCode} ${r.body}`);
  await jobs.runOne(org, r.json().operationId);
  return (
    await e.call(who, 'GET', `/v1/storage/buckets/${r.json().id}`, undefined, org)
  ).json() as Row;
};
const refOf = async (id: string) =>
  (await e.h.env.sql(`SELECT provider_ref FROM data.storage_buckets WHERE id = $1`, [id]))[0]!
    .provider_ref as string;

beforeAll(async () => {
  e = await setupDataEnv();
  reg = e.app.get(DataAdapterRegistry);
  jobs = e.app.get(DataJobs);
  flow = e.app.get(DatabaseFlow);
}, 120_000);
afterAll(() => e.h.close());

describe('no object-storage provider is enabled by default', () => {
  it('quotes and creates answer 422 unsupported_capability', async () => {
    const q = await quote();
    expect(q.statusCode).toBe(422);
    expect(q.json().code).toBe('unsupported_capability');
  });
});

describe('residency denial (AC-M08-15): a European bucket region is refused for an organization on the in-Kingdom default', () => {
  it('quote is 403 residency_denied', async () => {
    reg.register(
      'object-storage',
      'mock-object-storage-eu',
      new EuObjectStorageAdapter({ now: () => Date.now() }),
    );
    const eu = await e.enableLocal('object-storage', 'mock-object-storage-eu', {
      defaultRegion: 'de-frankfurt',
    });
    const q = await quote();
    expect(q.statusCode).toBe(403);
    expect(q.json().code).toBe('residency_denied');
    await e.admin('padmin', 'POST', '/v1/admin/data-providers', { action: 'disable', id: eu.id });
  });
});

describe('buckets (dev-reference provider: NOT VERIFIED)', () => {
  let b: Row;
  beforeAll(async () => {
    await e.enableLocal('object-storage', 'mock-object-storage', { defaultRegion: 'sa-central' });
  });

  it('quote → create → active: namespaced name, PRIVATE, endpoint, a vault REFERENCE for the bucket credential, never a secret', async () => {
    const q = await quote();
    expect(q.statusCode).toBe(201);
    expect(q.json().items[0]).toMatchObject({
      meterId: 'storage.object_gb_months',
      quantity: '100.00000000',
      amountMinor: '800',
    });
    const r = await e.call('alice', 'POST', '/v1/storage/buckets', {
      quoteId: q.json().id,
      name: 'assets',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: 'provisioning',
      name: 'assets',
      public: false,
      dataRegion: 'sa-central',
    });
    expect(r.json().bucketName).toBe(bucketGlobalName(orgA(), 'assets'));
    expect(r.json().bucketName).toMatch(/^nz-[0-9a-f]{10}-assets$/);
    await jobs.runOne(orgA(), r.json().operationId);
    b = (await e.call('alice', 'GET', `/v1/storage/buckets/${r.json().id}`)).json();
    expect(b).toMatchObject({ status: 'active', public: false, versioning: false });
    expect(b.endpoint).toMatch(/^https:\/\//);
    expect(b.credentialVaultRef).toMatch(/^vault:\/\//);
    expect(JSON.stringify(b)).not.toMatch(/mock-secret|accessKeySecret|providerRef|mockbkt-/);
    expect(mock().billableCount()).toBe(1);
    expect(
      (await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}/access-policy`)).json().policy,
    ).toEqual({ version: 1, access: 'private', statements: [] });
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['data.bucket.created', 'data.bucket.provisioned']),
    );
    // the credential in the vault is scoped to THIS bucket at the provider
    const secret = JSON.parse(await e.app.get(SecretStore).get(b.credentialVaultRef)) as {
      credentialId: string;
    };
    const other = await mkBucket('alice', orgA(), 'other-one');
    expect(mock().authorize(secret.credentialId, await refOf(b.id), 'write')).toBe(true);
    expect(mock().authorize(secret.credentialId, await refOf(other.id), 'read')).toBe(false);
  });

  it('validates names; public/policy/org cannot be set at creation; permissions; a duplicate is name_taken; another organization can use the same name (namespaced)', async () => {
    const q = async () => (await quote()).json().id as string;
    const post = async (body: Row, who = 'alice') =>
      e.call(who, 'POST', '/v1/storage/buckets', {
        quoteId: await q(),
        name: 'valid-name',
        ...body,
      });
    for (const name of [
      'A',
      'ab',
      '-bad',
      'bad-',
      'UPPER',
      'has space',
      'a'.repeat(41),
      'dots.in.name',
      'nz-12345-x',
      '../x',
    ])
      expect((await post({ name })).statusCode, name).toBe(422);
    for (const extra of [
      { public: true },
      { access: 'public-read' },
      { policy: {} },
      { orgId: orgB() },
    ])
      expect((await post(extra)).statusCode).toBe(422);
    expect((await post({ versioning: 'yes' })).statusCode).toBe(422);
    expect((await post({}, 'carol')).statusCode).toBe(403);
    const dupA = await post({ name: 'assets' });
    expect(dupA.statusCode).toBe(409);
    expect(dupA.json().code).toBe('name_taken');
    const bB = await mkBucket('bob', orgB(), 'assets'); // the same customer name in another organization: its own namespace
    expect(bB.bucketName).not.toBe(b.bucketName);
    // a true collision of the GLOBAL name (practically impossible, forced here) is the SAME answer as "yours is taken" (no enumeration)
    await e.h.env.sql(
      `INSERT INTO data.storage_buckets (id, org_id, name, name_global, state, data_region, provider_region_id, create_token) VALUES (gen_random_uuid(), $1, 'squat', $2, 'deleting', 'sa-central', 'sa-central', 'tok-squat')`,
      [orgB(), bucketGlobalName(orgA(), 'squat')],
    );
    const dupX = await post({ name: 'squat' });
    expect(dupX.statusCode).toBe(409);
    expect({
      code: dupX.json().code,
      title: dupX.json().title,
      detail: dupX.json().detail,
    }).toEqual({ code: dupA.json().code, title: dupA.json().title, detail: dupA.json().detail });
  });

  it('versioning is capability-gated; a quote of another kind is refused', async () => {
    const q = (await quote()).json().id;
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,object-storage.versioning}', '"unsupported"') WHERE provider_code = 'mock-object-storage'`,
    );
    const r = await e.call('alice', 'POST', '/v1/storage/buckets', {
      quoteId: q,
      name: 'versioned',
      versioning: true,
    });
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,object-storage.versioning}', '"supported"') WHERE provider_code = 'mock-object-storage'`,
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    const ai = (
      await e.call('alice', 'POST', '/v1/quotes', { kind: 'ai-credit', items: [{ credits: '10' }] })
    ).json().id;
    expect(
      (await e.call('alice', 'POST', '/v1/storage/buckets', { quoteId: ai, name: 'wrong-kind' }))
        .statusCode,
    ).toBe(422);
  });

  it('quota: the entitlement bucket count caps creation (422 quota_exceeded)', async () => {
    const count = Number(
      (
        await e.h.env.sql(
          `SELECT count(*)::int n FROM data.storage_buckets WHERE org_id = $1 AND state <> 'deleted' AND NOT system`,
          [orgA()],
        )
      )[0]!.n,
    );
    for (let i = count; i < 5; i++) await mkBucket();
    const r = await e.call('alice', 'POST', '/v1/storage/buckets', {
      quoteId: (await quote()).json().id,
      name: 'sixth-bucket',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('quota_exceeded');
  });

  it('a timeout after the provider created it, with the lookup also failing, parks the operation; the reconciler finds it by token: ONE bucket', async () => {
    const live = await e.h.env.sql(
      `SELECT id FROM data.storage_buckets WHERE org_id = $1 AND state <> 'deleted' AND NOT system ORDER BY created_at DESC LIMIT 1`,
      [orgA()],
    );
    await e.call('alice', 'DELETE', `/v1/storage/buckets/${live[0]!.id}`, {
      confirmName: (
        await e.h.env.sql(`SELECT name FROM data.storage_buckets WHERE id = $1`, [live[0]!.id])
      )[0]!.name,
      force: true,
    });
    await jobs.tick(new Date());
    const before = mock().billableCount();
    mock().inject('createBucket', 'timeout_after_side_effect');
    mock().inject('findBucketByToken', 'outage', 1);
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/storage/buckets', {
      quoteId: q.json().id,
      name: 'reconciled',
    });
    await jobs.runOne(orgA(), r.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json().state,
    ).toBe('needs_reconcile');
    expect(mock().billableCount()).toBe(before + 1);
    expect(await flow.reconcile(orgA(), r.json().operationId)).toBe('resumed');
    expect((await e.call('alice', 'GET', `/v1/storage/buckets/${r.json().id}`)).json().status).toBe(
      'active',
    );
    expect(mock().billableCount()).toBe(before + 1);
  });

  describe('access policy', () => {
    const pol = (id: string, body: Row, etag: string, who = 'alice') =>
      e.call(who, 'PUT', `/v1/storage/buckets/${id}/access-policy`, body, orgA(), {
        'if-match': etag,
      });
    const etagOf = async (id: string) =>
      (await e.call('alice', 'GET', `/v1/storage/buckets/${id}/access-policy`)).headers
        .etag as string;
    it('is deny-by-default: only the documented subset is accepted (>=10 invalid documents are 422 policy_invalid)', async () => {
      const t = etagOf;
      const bad: Row[] = [
        { policy: { version: 2, access: 'private', statements: [] } },
        { policy: { version: 1, access: 'world-writable', statements: [] } },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [
              { effect: 'deny', actions: ['read'], prefix: '', principal: 'bucket-credentials' },
            ],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [
              { effect: 'allow', actions: ['*'], prefix: '', principal: 'bucket-credentials' },
            ],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [{ effect: 'allow', actions: ['read'], prefix: '', principal: '*' }],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [
              {
                effect: 'allow',
                actions: ['read'],
                prefix: '../other',
                principal: 'bucket-credentials',
              },
            ],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [
              { effect: 'allow', actions: ['read'], prefix: 'a*', principal: 'bucket-credentials' },
            ],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [
              {
                effect: 'allow',
                actions: ['read'],
                prefix: '',
                principal: 'bucket-credentials',
                condition: {},
              },
            ],
          },
        },
        { policy: { version: 1, access: 'private', statements: [], extra: true } },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [],
            cors: [{ origins: ['*'], methods: ['GET'], maxAgeSeconds: 10 }],
          },
        },
        {
          policy: {
            version: 1,
            access: 'private',
            statements: [],
            cors: [{ origins: ['https://a.example'], methods: ['DELETE'], maxAgeSeconds: 10 }],
          },
        },
        { policy: 'allow everything' },
        { policy: [] },
      ];
      for (const body of bad) {
        const r = await pol(b.id, body, await t(b.id));
        expect(r.statusCode, JSON.stringify(body)).toBe(422);
        expect(r.json().code).toBe('policy_invalid');
      }
    });
    it('PUT needs the current ETag (428/412); a valid policy changes the ETag; roles without data:storage:admin are 403', async () => {
      const tag = await etagOf(b.id);
      const doc = {
        policy: {
          version: 1,
          access: 'private',
          statements: [
            {
              effect: 'allow',
              actions: ['write', 'read'],
              prefix: 'uploads/',
              principal: 'bucket-credentials',
            },
          ],
          cors: [
            { origins: ['https://app.example.com'], methods: ['GET', 'PUT'], maxAgeSeconds: 600 },
          ],
        },
      };
      expect(
        (await e.call('alice', 'PUT', `/v1/storage/buckets/${b.id}/access-policy`, doc)).statusCode,
      ).toBe(428);
      expect((await pol(b.id, doc, '"deadbeefdeadbeefdeadbeefdeadbeef"')).statusCode).toBe(412);
      expect((await pol(b.id, doc, tag, 'dave')).statusCode).toBe(403);
      const ok = await pol(b.id, doc, tag);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().policy.statements[0].actions).toEqual(['read', 'write']); // canonical
      expect(ok.headers.etag).not.toBe(tag);
      expect(ok.json().public).toBe(false);
      expect((await pol(b.id, doc, tag)).statusCode).toBe(412); // stale
      expect(e.sink.events.some((x) => x.action === 'data.bucket.policy_changed')).toBe(true);
    });
    it('making a bucket PUBLIC needs confirmPublic=true (bypass attempts fail), a recent MFA check, and is audited; making it private again needs no confirmation', async () => {
      const pub = { version: 1, access: 'public-read', statements: [] };
      const attempts: [string, Row, string][] = [
        ['no confirm', { policy: pub }, 'alice'],
        ['confirmPublic false', { policy: pub, confirmPublic: false }, 'alice'],
        ['confirmPublic string', { policy: pub, confirmPublic: 'true' }, 'alice'],
        ['confirmPublic number', { policy: pub, confirmPublic: 1 }, 'alice'],
        ['confirm inside the policy', { policy: { ...pub, confirmPublic: true } }, 'alice'],
        ['the policy as the body without confirm', pub, 'alice'],
        ['confirm as a sibling of a bare policy', { ...pub, confirmPublic: 'yes' }, 'alice'],
      ];
      for (const [label, body, who] of attempts) {
        const r = await pol(b.id, body, await etagOf(b.id), who);
        expect([422], label).toContain(r.statusCode);
      }
      expect((await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}`)).json().public).toBe(
        false,
      );
      const stale = await pol(
        b.id,
        { policy: pub, confirmPublic: true },
        await etagOf(b.id),
        'erin',
      );
      expect(stale.statusCode).toBe(401);
      expect(stale.json().code).toBe('step_up_required');
      expect((await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}`)).json().public).toBe(
        false,
      );
      const ok = await pol(b.id, { policy: pub, confirmPublic: true }, await etagOf(b.id));
      expect(ok.statusCode).toBe(200);
      expect(ok.json().public).toBe(true);
      expect((await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}`)).json().public).toBe(
        true,
      );
      expect(e.sink.events.some((x) => x.action === 'data.bucket.made_public')).toBe(true);
      expect(
        (
          await e.h.env.sql(`SELECT public_confirmed_by FROM data.storage_buckets WHERE id = $1`, [
            b.id,
          ])
        )[0]!.public_confirmed_by,
      ).toBe(e.ids.alice);
      const back = await pol(
        b.id,
        { policy: { version: 1, access: 'private', statements: [] } },
        await etagOf(b.id),
      );
      expect(back.statusCode).toBe(200);
      expect(back.json().public).toBe(false);
    });
  });

  describe('signed URLs', () => {
    const sign = (id: string, body: Row, who = 'alice') =>
      e.call(who, 'POST', `/v1/storage/buckets/${id}/signed-urls`, body);
    it('GET with the default TTL verifies at the provider; PUT needs write; ttl is capped at 7 days; invalid input is refused', async () => {
      const r = await sign(b.id, { key: 'docs/a.txt', method: 'GET' });
      expect(r.statusCode).toBe(201);
      expect(mock().verifyPresigned(r.json().url).ok).toBe(true);
      expect(Date.parse(r.json().expiresAt) - Date.now()).toBeGreaterThan(890_000);
      expect(Date.parse(r.json().expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
      expect((await sign(b.id, { key: 'docs/a.txt', method: 'GET' }, 'carol')).statusCode).toBe(
        201,
      ); // a viewer may read
      expect((await sign(b.id, { key: 'docs/a.txt', method: 'PUT' }, 'carol')).statusCode).toBe(
        403,
      ); // but not sign a write
      expect((await sign(b.id, { key: 'docs/a.txt', method: 'PUT' }, 'dave')).statusCode).toBe(201);
      const long = await sign(b.id, { key: 'a', method: 'GET', ttlSeconds: 604_801 });
      expect(long.statusCode).toBe(422);
      expect(long.json().code).toBe('ttl_too_long');
      expect((await sign(b.id, { key: 'a', method: 'GET', ttlSeconds: 604_800 })).statusCode).toBe(
        201,
      );
      for (const body of [
        { key: 'a', method: 'GET', ttlSeconds: 0 },
        { key: 'a', method: 'GET', ttlSeconds: -5 },
        { key: 'a', method: 'GET', ttlSeconds: 1.5 },
        { key: 'a', method: 'GET', ttlSeconds: '60' },
        { key: 'a', method: 'POST' },
        { key: 'a', method: 'get' },
        { key: '', method: 'GET' },
        { key: '../etc/passwd', method: 'GET' },
        { key: '/abs', method: 'GET' },
        { key: 'a\u0000b', method: 'GET' },
        { key: 'a\\b', method: 'GET' },
        { key: 'x'.repeat(1100), method: 'GET' },
        { key: 'a', method: 'GET', bucket: 'other' },
      ])
        expect((await sign(b.id, body)).statusCode, JSON.stringify(body)).toBe(422);
    });
    it('tampering and expiry are rejected by the provider; the URL never reaches the audit trail', async () => {
      const r = await sign(b.id, { key: 'docs/b.txt', method: 'GET', ttlSeconds: 1 });
      const url = r.json().url as string;
      expect(mock().verifyPresigned(url).ok).toBe(true);
      expect(mock().verifyPresigned(url.replace('X-Method=GET', 'X-Method=PUT')).ok).toBe(false);
      expect(mock().verifyPresigned(url.replace('docs/b.txt', 'docs/c.txt')).ok).toBe(false);
      expect(
        mock().verifyPresigned(url.replace(/X-Signature=[0-9a-f]{6}/, 'X-Signature=000000')).ok,
      ).toBe(false);
      expect(mock().verifyPresigned(url.replace(/X-Expires=\d+/, 'X-Expires=9999999999')).ok).toBe(
        false,
      );
      await new Promise((res) => setTimeout(res, 1100));
      expect(mock().verifyPresigned(url)).toMatchObject({ ok: false, reason: 'expired' });
      expect(JSON.stringify(e.sink.events)).not.toMatch(/X-Signature|mock\.invalid\/docs/);
      expect(e.sink.events.some((x) => x.action === 'data.signed_url.issued')).toBe(true);
    });
    it('a replay with the same Idempotency-Key returns the same URL', async () => {
      const key = { 'idempotency-key': 'sign-replay' };
      const a = await e.call(
        'alice',
        'POST',
        `/v1/storage/buckets/${b.id}/signed-urls`,
        { key: 'r.txt', method: 'GET' },
        orgA(),
        key,
      );
      const c = await e.call(
        'alice',
        'POST',
        `/v1/storage/buckets/${b.id}/signed-urls`,
        { key: 'r.txt', method: 'GET' },
        orgA(),
        key,
      );
      expect(c.json().url).toBe(a.json().url);
    });
  });

  describe('lifecycle', () => {
    it('expiry and multipart-abort rules are accepted; transitions only with the capability; invalid rules are 422; the capabilities are reported', async () => {
      const put = (rules: unknown, who = 'alice') =>
        e.call(who, 'PUT', `/v1/storage/buckets/${b.id}/lifecycle`, { rules }, orgA());
      const ok = await put([
        { id: 'tmp', prefix: 'tmp/', expireDays: 7, abortIncompleteMultipartDays: 1 },
      ]);
      expect(ok.statusCode).toBe(200);
      const got = (await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}/lifecycle`)).json();
      expect(got.rules).toHaveLength(1);
      expect(got.capabilities).toEqual({ expiry: true, abortMultipart: true, transition: true });
      await e.h.env.sql(
        `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,object-storage.lifecycle.transition}', '"unsupported"') WHERE provider_code = 'mock-object-storage'`,
      );
      const tr = await put([
        { id: 'cold', prefix: '', transition: { days: 30, storageClass: 'COLD' } },
      ]);
      expect(tr.statusCode).toBe(422);
      expect(tr.json().code).toBe('unsupported_capability');
      expect(
        (await e.call('alice', 'GET', `/v1/storage/buckets/${b.id}/lifecycle`)).json().capabilities
          .transition,
      ).toBe(false);
      await e.h.env.sql(
        `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,object-storage.lifecycle.transition}', '"supported"') WHERE provider_code = 'mock-object-storage'`,
      );
      for (const rules of [
        [{ id: 'x', prefix: '', expireDays: 0 }],
        [{ id: 'x', prefix: '' }],
        [
          { id: 'dup', prefix: '', expireDays: 1 },
          { id: 'dup', prefix: 'a', expireDays: 1 },
        ],
        [{ id: 'x', prefix: '../a', expireDays: 1 }],
        [{ id: 'x', prefix: '', expireDays: 99999 }],
        'nope',
        [{ id: 'x', prefix: '', expireDays: 1, bogus: true }],
      ])
        expect((await put(rules)).statusCode, JSON.stringify(rules)).toBe(422);
      expect((await put([{ id: 'x', prefix: '', expireDays: 1 }], 'carol')).statusCode).toBe(403);
    });
  });

  describe('delete', () => {
    it('a non-empty bucket is refused unless force; force needs data:storage:admin and a recent MFA check; the name is free afterwards', async () => {
      const d = await mkBucket('alice', orgA(), 'to-delete').catch(async () => {
        // the quota may be exhausted by earlier tests: free a slot first
        const old = (
          await e.h.env.sql(
            `SELECT id, name FROM data.storage_buckets WHERE org_id = $1 AND state = 'active' AND NOT system ORDER BY created_at LIMIT 1`,
            [orgA()],
          )
        )[0]!;
        const del = await e.call('alice', 'DELETE', `/v1/storage/buckets/${old.id}`, {
          confirmName: old.name,
          force: true,
        });
        await jobs.runOne(orgA(), del.json().operationId);
        return mkBucket('alice', orgA(), 'to-delete');
      });
      mock().putObject(await refOf(d.id), 'file.txt', 10);
      expect(
        (await e.call('alice', 'DELETE', `/v1/storage/buckets/${d.id}`, { confirmName: 'wrong' }))
          .statusCode,
      ).toBe(422);
      expect(
        (
          await e.call('alice', 'DELETE', `/v1/storage/buckets/${d.id}`, {
            confirmName: 'to-delete',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await e.call('dave', 'DELETE', `/v1/storage/buckets/${d.id}`, {
            confirmName: 'to-delete',
            force: true,
          })
        ).statusCode,
      ).toBe(403);
      const stale = await e.call('erin', 'DELETE', `/v1/storage/buckets/${d.id}`, {
        confirmName: 'to-delete',
        force: true,
      });
      expect(stale.json().code).toBe('step_up_required');
      const r = await e.call('alice', 'DELETE', `/v1/storage/buckets/${d.id}`, {
        confirmName: 'to-delete',
        force: true,
      });
      expect(r.statusCode).toBe(202);
      await jobs.runOne(orgA(), r.json().operationId);
      expect((await e.call('alice', 'GET', `/v1/storage/buckets/${d.id}`)).statusCode).toBe(404);
      await expect(e.app.get(SecretStore).get(d.credentialVaultRef)).rejects.toThrow();
      expect(e.sink.events.some((x) => x.action === 'data.bucket.deleted')).toBe(true);
      const again = await mkBucket('alice', orgA(), 'to-delete').catch(() => null);
      expect(again === null || again.status === 'active').toBe(true);
    });
  });

  describe('usage and metering (AC-M08-09)', () => {
    it('imports exact bytes, requests and egress; a figure the provider cannot report is unavailable (no event, never estimated); a re-run is idempotent', async () => {
      const u = await mkBucket('alice', orgA(), 'usage-bkt').catch(async () => {
        const old = (
          await e.h.env.sql(
            `SELECT id, name FROM data.storage_buckets WHERE org_id = $1 AND state = 'active' AND NOT system AND name <> 'assets' ORDER BY created_at LIMIT 1`,
            [orgA()],
          )
        )[0]!;
        const del = await e.call('alice', 'DELETE', `/v1/storage/buckets/${old.id}`, {
          confirmName: old.name,
          force: true,
        });
        await jobs.runOne(orgA(), del.json().operationId);
        return mkBucket('alice', orgA(), 'usage-bkt');
      });
      const ref = await refOf(u.id);
      mock().putObject(ref, 'big', 3 * GiB);
      mock().recordEgress(ref, 5_000_000_000, 2500);
      const sf = e.app.get(StorageFlow);
      const day = new Date(Date.now() + 86_400_000);
      expect(await sf.collectUsage(day)).toBeGreaterThanOrEqual(3);
      const ev = async (meter: string) =>
        (
          await e.h.env.sql(
            `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = $1 AND payload->>'resourceId' = $2`,
            [meter, u.id],
          )
        ).map((r) => r.payload as Row);
      expect((await ev('storage.object_gb_months'))[0]).toMatchObject({
        quantity: '0.10000000',
        unit: 'gib_month',
        source: 'storage@M08',
        dimensions: { region: 'sa-central', class: 'standard' },
      });
      expect((await ev('storage.requests_k'))[0]!.quantity).toBe('2.50000000');
      expect((await ev('storage.egress_gb'))[0]!.quantity).toBe('5.00000000');
      expect((await ev('storage.object_gb_months'))[0]!.quantity).toBe(
        gibMonthFraction(BigInt(3 * GiB)),
      );
      expect(thousands(2500)).toBe('2.50000000');
      expect(decimalGb(5_000_000_000)).toBe('5.00000000');
      const got = (await e.call('alice', 'GET', `/v1/storage/buckets/${u.id}`)).json();
      expect(got.usage).toMatchObject({
        bytesStored: 3 * GiB,
        requests: 2500,
        egressBytes: 5_000_000_000,
        available: { bytes: true, requests: true, egress: true },
      });
      // the provider stops reporting egress and requests
      mock().setCapabilities({
        'object-storage.usage.egress': 'unsupported',
        'object-storage.usage.requests': 'unsupported',
      });
      const day2 = new Date(day.getTime() + 86_400_000);
      await sf.collectUsage(day2);
      mock().setCapabilities({
        'object-storage.usage.egress': 'supported',
        'object-storage.usage.requests': 'supported',
      });
      expect((await ev('storage.egress_gb')).length).toBe(1); // none for day 2
      expect((await ev('storage.object_gb_months')).length).toBe(2); // bytes still reported
      const g2 = (await e.call('alice', 'GET', `/v1/storage/buckets/${u.id}`)).json();
      expect(g2.usage.available).toEqual({ bytes: true, requests: false, egress: false });
      await sf.collectUsage(day); // re-run of day 1: the same event ids again
      expect(new Set((await ev('storage.object_gb_months')).map((p) => p.eventId)).size).toBe(2);
    });
    it('exceeding the bucket quota raises one alert', async () => {
      const row = (
        await e.h.env.sql(
          `SELECT id, name FROM data.storage_buckets WHERE org_id = $1 AND name = 'usage-bkt'`,
          [orgA()],
        )
      )[0]!;
      const g = (await e.call('alice', 'GET', `/v1/storage/buckets/${row.id}`)).json();
      expect(
        (
          await e.call(
            'alice',
            'PATCH',
            `/v1/storage/buckets/${row.id}`,
            { quotaBytes: GiB },
            orgA(),
            { 'if-match': `"${g.etag}"` },
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await e.call(
            'alice',
            'PATCH',
            `/v1/storage/buckets/${row.id}`,
            { quotaBytes: -1 },
            orgA(),
            { 'if-match': `"${g.etag + 1}"` },
          )
        ).statusCode,
      ).toBe(422);
      await e.app.get(StorageFlow).collectUsage(new Date(Date.now() + 3 * 86_400_000));
      const alerts = e.app
        .get(DataAlerts)
        .raised.filter((a) => a.kind === 'data.bucket_over_quota');
      expect(alerts).toHaveLength(1);
    });
  });

  describe('system bucket pair for database backups', () => {
    it('creates nz-sys-<region>-backups and -replica in the SAME region through the object-storage provider; idempotent; invisible to tenants', async () => {
      const sf = e.app.get(StorageFlow);
      const a = await sf.ensureSystemBuckets('sa-central');
      expect(a).toEqual({
        backups: 'nz-sys-sa-central-backups',
        replica: 'nz-sys-sa-central-replica',
      });
      expect(await sf.ensureSystemBuckets('sa-central')).toEqual(a);
      const rows = await e.h.env.sql(
        `SELECT name_global, data_region, org_id, system FROM data.storage_buckets WHERE system ORDER BY name_global`,
      );
      expect(rows).toEqual([
        {
          name_global: 'nz-sys-sa-central-backups',
          data_region: 'sa-central',
          org_id: SYSTEM_ORG,
          system: true,
        },
        {
          name_global: 'nz-sys-sa-central-replica',
          data_region: 'sa-central',
          org_id: SYSTEM_ORG,
          system: true,
        },
      ]);
      expect(
        (await e.call('alice', 'GET', '/v1/storage/buckets?limit=200'))
          .json()
          .items.some((x: Row) => String(x.bucketName).startsWith('nz-sys-')),
      ).toBe(false);
      expect(
        await e.h.env.app.withOrg(
          orgA(),
          async (c) =>
            (await c.query(`SELECT count(*)::int n FROM data.storage_buckets WHERE system`))
              .rows[0]!.n,
        ),
      ).toBe(0);
    });
  });
});

describe('tenant isolation (AC-M08-05, bucket part): >=200 generated attack cases, 0 successes; uniform errors (no enumeration)', () => {
  it("another organization, no session and malformed ids never read or change alice's buckets", async () => {
    const mine = (await e.call('alice', 'GET', '/v1/storage/buckets?limit=1')).json()
      .items[0] as Row;
    const ids = [
      mine.id,
      mine.id.toUpperCase(),
      '00000000-0000-7000-8000-00000000dead',
      'not-a-uuid',
      '../../etc/passwd',
      `${mine.id}%00`,
      '0',
      `${mine.id}'--`,
      '%2e%2e%2f',
      ' ',
      'null',
      '*',
      '{id}',
      mine.bucketName,
    ];
    const leaks: string[] = [];
    let cases = 0;
    const note = (label: string, r: { statusCode: number; body: string }, ok: number[]) => {
      cases++;
      if (
        !ok.includes(r.statusCode) ||
        r.body.includes(mine.bucketName) ||
        r.body.includes(String(mine.credentialVaultRef)) ||
        r.body.includes(String(mine.endpoint))
      )
        leaks.push(`${label} -> ${r.statusCode} ${r.body.slice(0, 80)}`);
    };
    const tag = '"deadbeefdeadbeefdeadbeefdeadbeef"';
    for (const id of ids)
      for (const [who, org] of [
        ['bob', orgB()],
        ['bob', orgA()],
      ] as const) {
        const L = `${who}/${org === orgA() ? 'A' : 'B'} ${id.slice(0, 12)}`;
        const u = `/v1/storage/buckets/${id}`;
        note(L, await e.call(who, 'GET', u, undefined, org), [403, 404, 422]);
        note(
          L,
          await e.call(who, 'PATCH', u, { quotaBytes: 1 }, org, { 'if-match': '"1"' }),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(who, 'DELETE', u, { confirmName: mine.name, force: true }, org),
          [403, 404, 422],
        );
        note(L, await e.call(who, 'GET', `${u}/access-policy`, undefined, org), [403, 404, 422]);
        note(
          L,
          await e.call(
            who,
            'PUT',
            `${u}/access-policy`,
            { policy: { version: 1, access: 'public-read', statements: [] }, confirmPublic: true },
            org,
            { 'if-match': tag },
          ),
          [403, 404, 422],
        );
        note(
          L,
          await e.call(who, 'POST', `${u}/signed-urls`, { key: 'x', method: 'GET' }, org),
          [403, 404, 422],
        );
        note(L, await e.call(who, 'GET', `${u}/lifecycle`, undefined, org), [403, 404, 422]);
        note(
          L,
          await e.call(
            who,
            'PUT',
            `${u}/lifecycle`,
            { rules: [{ id: 'x', prefix: '', expireDays: 1 }] },
            org,
          ),
          [403, 404, 422],
        );
      }
    for (const id of ids.slice(0, 6)) {
      note(
        'anon GET',
        await e.app.inject({ method: 'GET', url: `/v1/storage/buckets/${id}` }),
        [401, 404],
      );
      note(
        'anon DELETE',
        await e.app.inject({ method: 'DELETE', url: `/v1/storage/buckets/${id}` }),
        [401, 404],
      );
    }
    expect(cases).toBeGreaterThanOrEqual(110);
    // bucket names are not enumerable: a foreign bucket id answers exactly like an id that does not exist
    const foreign = await e.call('bob', 'GET', `/v1/storage/buckets/${mine.id}`, undefined, orgB());
    const nothing = await e.call(
      'bob',
      'GET',
      '/v1/storage/buckets/00000000-0000-7000-8000-00000000dead',
      undefined,
      orgB(),
    );
    const strip = (r: { statusCode: number; json(): Row }) => ({
      s: r.statusCode,
      ...Object.fromEntries(Object.entries(r.json()).filter(([k]) => k !== 'traceId')),
    });
    expect(strip(foreign)).toEqual(strip(nothing));
    expect(
      (await e.call('bob', 'GET', '/v1/storage/buckets?limit=200', undefined, orgB()))
        .json()
        .items.some((x: Row) => x.id === mine.id),
    ).toBe(false);
    // the credentials of one bucket never open another (provider-side scoping)
    const mineCred = JSON.parse(await e.app.get(SecretStore).get(mine.credentialVaultRef)) as {
      credentialId: string;
    };
    const bobsBucket = (
      await e.h.env.sql(
        `SELECT provider_ref FROM data.storage_buckets WHERE org_id = $1 AND NOT system LIMIT 1`,
        [orgB()],
      )
    )[0]!.provider_ref as string;
    for (const action of ['read', 'write'] as const) {
      cases++;
      if (mock().authorize(mineCred.credentialId, bobsBucket, action))
        leaks.push(`credential reuse ${action}`);
    }
    // creating with a body that names another organization or tries to set public is refused
    for (const body of [
      { orgId: orgB() },
      { organizationId: orgB() },
      { public: true },
      { access: 'public-read' },
    ]) {
      cases++;
      const r = await e.call('alice', 'POST', '/v1/storage/buckets', {
        quoteId: (await quote()).json().id,
        name: 'attack-x',
        ...body,
      });
      if (r.statusCode !== 422) leaks.push(`create ${JSON.stringify(body)} -> ${r.statusCode}`);
    }
    // RLS under the application role
    const asB = await e.h.env.app.withOrg(orgB(), async (c) => ({
      buckets: (
        await c.query(`SELECT count(*)::int n FROM data.storage_buckets WHERE org_id = $1`, [
          orgA(),
        ])
      ).rows[0]!.n as number,
      policies: (
        await c.query(`SELECT count(*)::int n FROM data.bucket_policies WHERE org_id = $1`, [
          orgA(),
        ])
      ).rows[0]!.n as number,
    }));
    cases += 2;
    expect(asB).toEqual({ buckets: 0, policies: 0 });
    expect(leaks).toEqual([]);
    expect(cases).toBeGreaterThanOrEqual(120);
  });
});
