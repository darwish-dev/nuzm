import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/** The HTTP surface of the provider read models (CONTRACT-1): permission, shapes, and the closed live gate. Mock providers only. */
let e: AiEnv;
let providerId: string;
const base = '/v1/admin/ai/model-providers';

beforeAll(async () => {
  e = await setupAiEnv();
  const { row } = await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model' }),
  });
  providerId = row.id as string;
}, 120_000);
afterAll(() => e.h.close());

describe('provider insight routes', () => {
  it('capability registry and health answer a platform admin with the documented shapes', async () => {
    const reg = await e.admin('padmin', 'GET', `${base}/capability-registry`);
    expect(reg.statusCode, reg.body).toBe(200);
    const item = reg
      .json()
      .items.find((x: { providerCode: string }) => x.providerCode === 'mock-model');
    expect(item).toMatchObject({ providerEnabled: true, priced: true });
    expect(item.capabilities[0]).toHaveProperty('basis');
    const h = await e.admin('padmin', 'GET', `${base}/health`);
    expect(h.statusCode, h.body).toBe(200);
    expect(h.json().scope).toBe('process');
    expect(Array.isArray(h.json().items)).toBe(true);
  });
  it('rate card versions: 200 with the history, 422 for a malformed id, 404 for an unknown one', async () => {
    const r = await e.admin('padmin', 'GET', `${base}/${providerId}/rate-card-versions`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    expect(r.json().items[0]).toMatchObject({ version: 'test-1' });
    expect((await e.admin('padmin', 'GET', `${base}/nope/rate-card-versions`)).statusCode).toBe(
      422,
    );
    expect(
      (
        await e.admin(
          'padmin',
          'GET',
          `${base}/01a20b04-7528-72c9-9952-d8553b65aee1/rate-card-versions`,
        )
      ).statusCode,
    ).toBe(404);
  });
  it('usage report: validates the query and answers the documented shape', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const ok = await e.admin(
      'padmin',
      'GET',
      `/v1/admin/ai/usage?from=${from}&to=${to}&groupBy=model`,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ groupBy: 'model', truncated: false });
    expect((await e.admin('padmin', 'GET', `/v1/admin/ai/usage?from=${from}`)).statusCode).toBe(
      422,
    );
    expect(
      (await e.admin('padmin', 'GET', `/v1/admin/ai/usage?from=${from}&to=${to}&groupBy=org`))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.admin('padmin', 'GET', `/v1/admin/ai/usage?from=${to}&to=${from}`)).statusCode,
    ).toBe(422);
  });
  it('model discovery is refused while the live gate is closed (default) and sends nothing', async () => {
    const r = await e.admin('padmin', 'POST', `${base}/${providerId}/model-discovery`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
  });
  it('none of the routes is open to a customer session', async () => {
    for (const [m, url] of [
      ['GET', `${base}/capability-registry`],
      ['GET', `${base}/health`],
      ['GET', `${base}/${providerId}/rate-card-versions`],
      ['GET', '/v1/admin/ai/usage?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'],
      ['POST', `${base}/${providerId}/model-discovery`],
    ] as const) {
      const r = await e.call('alice', m, url);
      expect([401, 403, 404], `${m} ${url} -> ${r.statusCode}`).toContain(r.statusCode);
    }
  });
});
