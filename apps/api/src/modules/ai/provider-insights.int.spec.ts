import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  MOCK_TOOL_MODELS,
  MockModelAdapter,
  ModelAdapterError,
  type DiscoveredModel,
} from '@nuzm/adapter-model';
import { DB } from '../../common/tokens';
import { AuditSink } from '../../common/audit';
import {
  AI_CONFIG,
  GatewayService,
  ModelAdapterRegistry,
  ModelProviderService,
  ProviderInsightsService,
  type AiConfig,
} from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/** Provider administration read models (S-AG4): capability registry, health, usage report, gated model discovery. Mock providers only. */
let e: AiEnv;
let ins: ProviderInsightsService;
let gw: GatewayService;
const A = () => e.org.A!;
const msg = (content: string) => [{ role: 'user' as const, content }];
const call = (o: Partial<Parameters<GatewayService['invoke']>[0]> = {}) => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: msg('hello bakery'),
  maxTokens: 50,
  callId: `c-${uuidv7()}`,
  ...o,
});
const disable = (code: string) =>
  e.sql(
    `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code=$1`,
    [code],
  );
const wide = () => ({
  from: new Date(Date.now() - 24 * 3600_000),
  to: new Date(Date.now() + 3600_000),
});

class DiscoveringMock extends MockModelAdapter {
  found: DiscoveredModel[] = [];
  fail = false;
  discoverCalls = 0;
  async discoverModels(): Promise<DiscoveredModel[]> {
    this.discoverCalls++;
    if (this.fail) throw new ModelAdapterError('unavailable', 'down');
    return this.found;
  }
}

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
  ins = e.app.get(ProviderInsightsService);
  await e.fund(A(), '1000000');
}, 300_000);
afterAll(() => e.h.close());

describe('capability registry', () => {
  it('lists every model of a registered provider with effective and pending capabilities, whether or not it is enabled or priced', async () => {
    const adapter = new MockModelAdapter({ id: 'mock-reg', models: MOCK_TOOL_MODELS });
    await e.enableMock('mock-reg', { adapter });
    try {
      const r = await ins.capabilityRegistry();
      const mine = r.items.filter((x) => x.providerCode === 'mock-reg');
      expect(mine.map((x) => x.modelId).sort()).toEqual(
        adapter
          .models()
          .map((m) => m.modelId)
          .sort(),
      );
      expect(mine.every((x) => x.providerEnabled && x.priced)).toBe(true);
      // a development-reference provider keeps what its adapter declares under contract 1.1: nothing is pending
      const full = mine.find((x) => x.modelId === 'mock-tools-1')!;
      expect(full.effective).toEqual(
        expect.arrayContaining(['chat', 'tool-use', 'streaming-tool-calls', 'parallel-tool-calls']),
      );
      expect(mine.every((x) => x.pending.length === 0)).toBe(true);
    } finally {
      await disable('mock-reg');
    }
    const off = (await ins.capabilityRegistry()).items.filter((x) => x.providerCode === 'mock-reg');
    expect(off.length).toBe(2);
    expect(off.every((x) => !x.providerEnabled)).toBe(true);
  });
  it('a real provider (not a dev reference) shows its tool capabilities as pending until evidence exists', async () => {
    const adapter = new MockModelAdapter({ id: 'acme-reg', models: MOCK_TOOL_MODELS });
    e.registry.register('acme-reg', adapter);
    const models = Object.fromEntries(
      adapter
        .models()
        .map((m) => [m.modelId, { creditsPerMillionInput: '1', creditsPerMillionOutput: '1' }]),
    );
    const c = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'configure',
      code: 'acme-reg',
      adapter: 'acme',
      displayName: 'Acme',
      region: 'sa-central',
      rateCard: { models },
    });
    expect(c.statusCode).toBe(200);
    const row = (await ins.capabilityRegistry()).items.find(
      (x) => x.providerCode === 'acme-reg' && x.modelId === 'mock-tools-1',
    )!;
    expect(row.providerEnabled).toBe(false);
    expect(row.effective).toEqual(['chat', 'structured-output']);
    expect(row.pending).toEqual(['tool-use', 'streaming-tool-calls', 'parallel-tool-calls']);
    expect(row.capabilities.find((k) => k.capability === 'tool-use')!.basis).toBe('no_evidence');
  });
});

describe('usage report', () => {
  beforeAll(async () => {
    await e.enableMock('mock-use-a');
    await e.enableMock('mock-use-b', { rate: ['2000000', '4000000'] });
  });
  afterAll(async () => {
    await disable('mock-use-a');
    await disable('mock-use-b');
  });
  it('aggregates exactly what the append-only usage rows hold, by provider, model and day', async () => {
    for (let i = 0; i < 3; i++) await gw.invoke(call());
    await disable('mock-use-a'); // the next calls go to the other provider
    for (let i = 0; i < 2; i++) await gw.invoke(call());
    const q = { ...wide(), orgId: A() };
    const truth = (await e.sql(
      `SELECT provider_code, count(*)::int n, sum(tokens_in)::text ti, sum(tokens_out)::text tout, sum(credits)::text cr, sum(cost_minor)::text cm
         FROM ai.model_usage WHERE org_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY provider_code ORDER BY provider_code`,
      [A(), q.from.toISOString(), q.to.toISOString()],
    )) as { provider_code: string; n: number; ti: string; tout: string; cr: string; cm: string }[];
    const byProvider = await ins.usageReport({ ...q, groupBy: 'provider' });
    expect(byProvider.truncated).toBe(false);
    expect(
      byProvider.rows.map((r) => [
        r.providerCode,
        r.calls,
        r.tokensIn,
        r.tokensOut,
        r.credits,
        r.costMinor,
      ]),
    ).toEqual(truth.map((t) => [t.provider_code, t.n, t.ti, t.tout, t.cr, t.cm]));
    expect(byProvider.rows.every((r) => r.modelRef === null && r.day === null)).toBe(true);
    const byModel = await ins.usageReport({ ...q, groupBy: 'model' });
    expect(byModel.rows.reduce((n, r) => n + r.calls, 0)).toBe(
      Number(truth.reduce((n, t) => n + t.n, 0)),
    );
    expect(
      byModel.rows.every((r) => r.modelRef !== null && r.modelRef.startsWith(r.providerCode + '/')),
    ).toBe(true);
    const byDay = await ins.usageReport({ ...q, groupBy: 'day' });
    expect(byDay.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day!))).toBe(true);
    expect(byDay.rows.reduce((n, r) => n + r.calls, 0)).toBe(
      Number(truth.reduce((n, t) => n + t.n, 0)),
    );
    expect(byDay.rows.reduce((n, r) => n + BigInt(r.credits), 0n)).toBe(
      truth.reduce((n, t) => n + BigInt(t.cr), 0n),
    );
  });
  it('counts errors, estimated calls and latency percentiles apart, and filters by provider and organization', async () => {
    const { adapter } = await e.enableMock('mock-use-c');
    adapter.failNext(new ModelAdapterError('content_filtered', 'no'), 1);
    await expect(gw.invoke(call())).rejects.toMatchObject({ code: 'content_blocked' });
    await gw.invoke(call());
    const r = await ins.usageReport({
      ...wide(),
      groupBy: 'provider',
      providerCode: 'mock-use-c',
      orgId: A(),
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      providerCode: 'mock-use-c',
      calls: 2,
      okCalls: 1,
      errorCalls: 1,
    });
    expect(r.rows[0]!.p50LatencyMs === null || r.rows[0]!.p50LatencyMs >= 0).toBe(true);
    // another organization sees none of A's usage through the filter
    const other = await ins.usageReport({
      ...wide(),
      groupBy: 'provider',
      orgId: e.org.B!,
      providerCode: 'mock-use-c',
    });
    expect(other.rows).toEqual([]);
    await disable('mock-use-c');
  });
  it('refuses a malformed query before it reaches the database', async () => {
    const now = new Date();
    const bad = (q: Partial<Parameters<ProviderInsightsService['usageReport']>[0]>) =>
      expect(
        ins.usageReport({
          from: new Date(now.getTime() - 1000),
          to: now,
          groupBy: 'provider',
          ...q,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await bad({ to: new Date(now.getTime() - 2000) });
    await bad({ from: new Date('nope') });
    await bad({ from: new Date(now.getTime() - 400 * 24 * 3600_000) });
    await bad({ groupBy: 'org' as never });
    await bad({ providerCode: "x'; DROP TABLE ai.model_usage;--" });
    await bad({ orgId: 'not-a-uuid' });
    expect((await e.sql(`SELECT count(*)::int n FROM ai.model_usage`))[0]!.n).toBeGreaterThan(0);
  });
});

describe('health', () => {
  it('exposes the gateway health of this process, labelled as process-scoped', async () => {
    const h = ins.health();
    expect(h.scope).toBe('process');
    expect(h.items.length).toBeGreaterThan(0);
    expect(
      h.items.every((i) => ['unknown', 'healthy', 'degraded', 'unhealthy'].includes(i.status)),
    ).toBe(true);
  });
});

describe('model discovery (live-gated)', () => {
  const build = (live: string[]) =>
    new ProviderInsightsService(
      e.app.get(DB),
      e.app.get(AuditSink),
      e.app.get(ModelProviderService),
      e.app.get(ModelAdapterRegistry),
      gw,
      { ...e.app.get<AiConfig>(AI_CONFIG), liveProviders: live },
    );
  let adapter: DiscoveringMock;
  let id: string;
  beforeAll(async () => {
    adapter = new DiscoveringMock({ id: 'mock-disc' });
    ({
      row: { id },
    } = await e.enableMock('mock-disc', { adapter }));
  });
  afterAll(() => disable('mock-disc'));
  it('is refused, and nothing is called, while the provider is not approved for live calls (the default)', async () => {
    await expect(build([]).discoverModels(e.ids.alice!, id)).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(adapter.discoverCalls).toBe(0);
  });
  it('a provider without discovery, an unknown id and a production process are refused', async () => {
    const { row: plain } = await e.enableMock('mock-nodisc');
    await expect(
      build(['mock-nodisc']).discoverModels(e.ids.alice!, plain.id as string),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(build(['mock-disc']).discoverModels(e.ids.alice!, uuidv7())).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(build(['mock-disc']).discoverModels(e.ids.alice!, id)).rejects.toMatchObject({
        code: 'unsupported_capability',
      });
    } finally {
      if (was === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = was;
    }
    expect(adapter.discoverCalls).toBe(0);
    await disable('mock-nodisc');
  });
  it('reconciles the vendor list with the adapter, audits it, and never turns an unknown model into an offer', async () => {
    adapter.found = [
      { modelId: adapter.models()[0]!.modelId },
      { modelId: 'brand-new-model', displayName: 'New' },
    ];
    const r = await build(['mock-disc']).discoverModels(e.ids.alice!, id);
    expect(r).toMatchObject({
      live: true,
      providerCode: 'mock-disc',
      confirmed: [adapter.models()[0]!.modelId],
    });
    expect(r.notDeclared).toEqual([{ modelId: 'brand-new-model', displayName: 'New' }]);
    expect(r.unlistedByVendor).toEqual(
      adapter
        .models()
        .slice(1)
        .map((m) => m.modelId)
        .sort(),
    );
    const models = (await e.call('alice', 'GET', '/v1/ai/models')).json().items as {
      modelId: string;
    }[];
    expect(models.map((m) => m.modelId)).not.toContain('brand-new-model');
    expect(
      (e.sink.events as { action: string }[]).some(
        (x) => x.action === 'ai.provider.models_discovered',
      ),
    ).toBe(true);
  });
  it('a failing provider is a 503 without the upstream message, and the failure is audited', async () => {
    adapter.fail = true;
    await expect(build(['mock-disc']).discoverModels(e.ids.alice!, id)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(
      (e.sink.events as { action: string; outcome?: string }[]).some(
        (x) => x.action === 'ai.provider.models_discovered' && x.outcome === 'failure',
      ),
    ).toBe(true);
    adapter.fail = false;
  });
});
