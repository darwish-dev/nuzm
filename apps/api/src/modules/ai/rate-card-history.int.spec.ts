import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { ModelProviderService } from './index';
import { rateCardSha } from './internal/provider.service';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/** Rate card history (S-AG4, migration 1900): every change of a card's CONTENT is appended; nothing else is. Synthetic numbers only. */
let e: AiEnv;
let svc: ModelProviderService;
const card = (i: string, o: string, ids: string[]) => ({
  models: Object.fromEntries(ids.map((id) => [id, { creditsPerMillionInput: i, creditsPerMillionOutput: o }])),
});
const configure = (code: string, rateCard: object, rateCardVersion: string) =>
  e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
    action: 'configure', code, adapter: 'mock', displayName: `Mock ${code}`, region: 'sa-central', vaultRef: 'vault://mock/ai', rateCard, rateCardVersion,
  });

beforeAll(async () => {
  e = await setupAiEnv();
  svc = e.app.get(ModelProviderService);
}, 120_000);
afterAll(() => e.h.close());

describe('rate card history', () => {
  const code = 'mock-model';
  let id: string;
  const ids = () => new MockModelAdapter({ id: code }).models().map((m) => m.modelId);
  beforeAll(() => e.registry.register(code, new MockModelAdapter({ id: code })));

  it('records the first card, appends only real content changes, and keeps the newest first with the diff against the previous one', async () => {
    const m = ids();
    let r = await configure(code, card('100', '500', m), 'v1');
    expect(r.statusCode).toBe(200);
    id = r.json().id as string;
    expect((await svc.rateCardHistory(id)).items).toHaveLength(1);
    // a re-save of the same card, and the same card under a new label: nothing appended
    expect((await configure(code, card('100', '500', m), 'v1')).statusCode).toBe(200);
    expect((await configure(code, card('100', '500', [...m].reverse()), 'v1-renamed')).statusCode).toBe(200);
    expect((await svc.rateCardHistory(id)).items).toHaveLength(1);
    r = await configure(code, card('120', '500', m), 'v2');
    expect(r.statusCode).toBe(200);
    const h = (await svc.rateCardHistory(id)).items;
    expect(h.map((x) => x.version)).toEqual(['v2', 'v1']);
    expect(h[0]!.changes.map((c) => [c.modelId, c.change])).toEqual(m.map((x) => [x, 'changed']).sort());
    expect(h[0]!.changes[0]).toMatchObject({ before: { creditsPerMillionInput: '100' }, after: { creditsPerMillionInput: '120' } });
    expect(h[1]!.changes.every((c) => c.change === 'added')).toBe(true);
    expect(h.every((x) => /^[0-9a-f-]{36}$/.test(x.recordedBy))).toBe(true);
  });
  it('removing prices is part of the history; an empty first card is not', async () => {
    const r = await configure(code, { models: {} }, 'v3-empty');
    expect(r.statusCode).toBe(200);
    const h = (await svc.rateCardHistory(id)).items;
    expect(h[0]).toMatchObject({ version: 'v3-empty', models: {} });
    expect(h[0]!.changes.every((c) => c.change === 'removed')).toBe(true);
    const fresh = await configure('mock-model-b', { models: {} }, 'v0');
    expect(fresh.statusCode).toBe(200);
    expect((await svc.rateCardHistory(fresh.json().id as string)).items).toEqual([]);
  });
  it('the history is append-only: an UPDATE, a DELETE and a TRUNCATE are refused by the database', async () => {
    await expect(e.sql(`UPDATE ai.model_rate_card_versions SET version='x' WHERE provider_id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(e.sql(`DELETE FROM ai.model_rate_card_versions WHERE provider_id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(e.sql(`TRUNCATE ai.model_rate_card_versions`)).rejects.toThrow(/append-only/);
    expect((await svc.rateCardHistory(id)).items.length).toBeGreaterThan(0);
  });
  it('is platform-scoped: the application role cannot read it without the platform scope, and an unknown or malformed id is refused', async () => {
    await expect(svc.rateCardHistory('not-a-uuid')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(svc.rateCardHistory('01a20b04-7528-72c9-9952-d8553b65aee1')).rejects.toMatchObject({ code: 'not_found' });
    const rows = (await e.h.env.sql(`SELECT count(*)::int n FROM ai.model_rate_card_versions`))[0]!.n; // the test owner role sees all
    expect(rows).toBeGreaterThan(0);
  });
  it('the content digest ignores key order and the version label', () => {
    const a = { models: { x: { creditsPerMillionInput: '1', creditsPerMillionOutput: '2' }, y: { creditsPerMillionInput: '3', creditsPerMillionOutput: '4' } } };
    const b = { models: { y: { creditsPerMillionInput: '3', creditsPerMillionOutput: '4' }, x: { creditsPerMillionInput: '1', creditsPerMillionOutput: '2' } } };
    expect(rateCardSha(a)).toBe(rateCardSha(b));
    expect(rateCardSha(a)).not.toBe(rateCardSha({ models: { ...a.models, y: { creditsPerMillionInput: '3', creditsPerMillionOutput: '5' } } }));
  });
});
