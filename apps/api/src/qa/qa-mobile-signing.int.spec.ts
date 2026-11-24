import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA) - API-level re-verification of the R6 "10b viewer-forbidden" scenario (`e2e/tests/10b-mobile.spec.ts`, "signing is owner/admin only"), in an isolated database
 * of its own (own cluster :54347). The browser half of that scenario (the forbidden screen, no API call from the page) is the E2E; this covers what the API must guarantee
 * whatever the screen does: a REAL viewer membership is refused for reading and writing, nothing is stored, a user with no membership gets no data, and an owner control
 * request succeeds (so the refusals are authorization, not a malformed request). Plus: key material is rejected and never echoed. Offline: no vault, no signing stage.
 */
let e: AiEnv;
const A = () => e.org.A!;
const body = (o: Row = {}) => ({
  platform: 'android',
  label: 'qa upload key',
  vaultRef: 'vault://dev/mobile/qa-upload-key',
  authorizedBy: '',
  ...o,
});
const count = async () =>
  Number(
    (
      await e.sql(`SELECT count(*) n FROM mobile.signing_credential_refs WHERE org_id=$1`, [A()])
    )[0]!.n,
  );
const post = (who: string, b: Row, org = A()) =>
  e.call(who, 'POST', '/v1/mobile/signing-credentials', b, org);

beforeAll(async () => {
  e = await setupAiEnv();
  await e.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'mobile_builder.enabled', NULL, 'true')`,
  );
}, 180_000);
afterAll(() => e.h.close());

describe('QA 10b (API level): signing credentials are owner/admin only', () => {
  it('a viewer (carol) is refused for reading and writing and nothing is stored', async () => {
    const before = await count();
    const read = await e.call('carol', 'GET', '/v1/mobile/signing-credentials', undefined, A());
    expect(read.statusCode).toBe(403);
    const write = await post('carol', body({ authorizedBy: e.ids.carol! }));
    expect(write.statusCode).toBe(403);
    expect(await count()).toBe(before);
    // the refusal body names nothing about credentials
    expect(read.body + write.body).not.toMatch(/vault:\/\//);
  });
  it('a developer and a billing admin are refused as well (the permission is owner/admin only)', async () => {
    for (const who of ['dave', 'frank'])
      expect((await post(who, body({ authorizedBy: e.ids[who]! }))).statusCode, who).toBe(403);
  });
  it('a signed-in user with no membership in the organization gets no data (404, existence hiding)', async () => {
    expect(
      (await e.call('bob', 'GET', '/v1/mobile/signing-credentials', undefined, A())).statusCode,
    ).toBe(404);
    expect((await post('bob', body({ authorizedBy: e.ids.bob! }))).statusCode).toBe(404);
  });
  it('control: the owner creates a credential reference (201), so the refusals above are authorization and not a bad request', async () => {
    const before = await count();
    const ok = await post('alice', body({ authorizedBy: e.ids.alice! }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await count()).toBe(before + 1);
    // and the viewer still cannot see it
    expect(
      (await e.call('carol', 'GET', '/v1/mobile/signing-credentials', undefined, A())).statusCode,
    ).toBe(403);
    // the owner of another organization sees none of it
    const other = await e.call('bob', 'GET', '/v1/mobile/signing-credentials', undefined, e.org.B!);
    expect(other.statusCode).toBe(200);
    expect(other.json().items).toEqual([]);
  });
  it("nobody authorizes in another person's name", async () => {
    const r = await post('alice', body({ authorizedBy: e.ids.erin! }));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
  it('key material is rejected with 422 and never echoed back', async () => {
    const before = await count();
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const blob = 'A'.repeat(64);
    for (const b of [
      body({ authorizedBy: e.ids.alice!, label: pem }),
      body({ authorizedBy: e.ids.alice!, vaultRef: `vault://dev/${blob}` }),
      { ...body({ authorizedBy: e.ids.alice! }), keystorePassword: 'hunter2-hunter2' },
      { ...body({ authorizedBy: e.ids.alice! }), privateKey: pem },
    ]) {
      const r = await post('alice', b);
      expect(r.statusCode, JSON.stringify(Object.keys(b))).toBe(422);
      expect(r.body).not.toContain('hunter2');
      expect(r.body).not.toContain('MIIEvQIBADANB');
      expect(r.body).not.toContain(blob);
    }
    expect(await count()).toBe(before);
  });
});
