import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';

/**
 * O-9 route `GET|PUT /v1/builder/policies/content-access` (CONTRACT-S05-P2-2, revised by the Master: the PUT is SESSION-ONLY, an API key is refused 403). PARKED with the controller
 * until it is registered on the tree; then rename to `builder-policy-route.int.spec.ts` (this file sits next to `builder-lifecycle.int.spec.ts`). Covers: GET for every role,
 * PUT by owner (session) and by an admin-less role (403), PUT with an API key (403, even an owner's key with every scope; nothing changes, nothing is audited as changed), validation
 * (422), and that the setting really drives the five content reads.
 */
let e: AiEnv;
const A = () => e.org.A!;
const URL = '/v1/builder/policies/content-access';
const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await e.sql(sql, p)) as Row[];

beforeAll(async () => {
  e = await setupAiEnv();
  await q(`INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'builder_tools.enabled', $1, 'true'::jsonb)`, [A()]);
}, 300_000);
afterAll(() => e.h.close());

describe('content-access policy route', () => {
  it('reads: every member sees the setting, default allow', async () => {
    for (const who of ['alice', 'dave', 'carol', 'frank']) {
      const r = await e.call(who, 'GET', URL, undefined, A());
      expect(r.statusCode, who).toBe(200);
      expect(r.json()).toEqual({ mode: 'allow', default: 'allow' });
    }
  });
  it('writes: a session owner can; a developer, viewer and billing admin cannot (403)', async () => {
    for (const who of ['dave', 'carol', 'frank'])
      expect((await e.call(who, 'PUT', URL, { mode: 'deny' }, A())).statusCode, who).toBe(403);
    expect((await e.call('alice', 'PUT', URL, { mode: 'deny' }, A())).json()).toEqual({ mode: 'deny', default: 'allow' });
    expect((await e.call('alice', 'PUT', URL, { mode: 'allow' }, A())).statusCode).toBe(200);
  });
  it('an API key can NEVER change it, whatever its scopes or its owner: 403, nothing changes, nothing is audited as changed', async () => {
    const k = await e.call('alice', 'POST', '/v1/api-keys', { name: 'o9', scopes: ['org:update', 'org:read', 'builder:read', 'builder:write'] }, A());
    expect(k.statusCode, k.body).toBe(201);
    const bearer = k.json().key as string;
    const before = e.sink.events.filter((x) => x.action === 'builder.policy.content_access_changed').length;
    const put = await e.app.inject({ method: 'PUT', url: URL, headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': 'o9-key' }, payload: { mode: 'deny' } });
    expect(put.statusCode, put.body).toBe(403);
    expect((await e.call('alice', 'GET', URL, undefined, A())).json().mode).toBe('allow');
    expect(e.sink.events.filter((x) => x.action === 'builder.policy.content_access_changed').length).toBe(before);
    // a key may still READ the setting
    const get = await e.app.inject({ method: 'GET', url: URL, headers: { authorization: `Bearer ${bearer}` } });
    expect(get.statusCode).toBe(200);
  });
  it('malformed bodies are 422, and the setting drives the content reads', async () => {
    for (const body of [{}, { mode: 'maybe' }, { mode: 'deny', extra: 1 }])
      expect((await e.call('alice', 'PUT', URL, body, A())).statusCode, JSON.stringify(body)).toBe(422);
    const p = (await e.call('alice', 'POST', '/v1/builder/projects', { name: 'O9 route', type: 'webapp' }, A())).json().id as string;
    await e.call('alice', 'POST', `/v1/builder/projects/${p}/changes`, { baseVersion: null, source: 'user', patches: [{ op: 'add', path: 'a.ts', content: 'export {};\n' }] }, A());
    expect((await e.call('frank', 'GET', `/v1/builder/projects/${p}/review`, undefined, A())).statusCode).toBe(200);
    await e.call('alice', 'PUT', URL, { mode: 'deny' }, A());
    expect((await e.call('frank', 'GET', `/v1/builder/projects/${p}/review`, undefined, A())).statusCode).toBe(403);
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
  });
});
