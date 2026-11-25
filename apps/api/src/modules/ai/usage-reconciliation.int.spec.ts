import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { MockModelAdapter, ModelAdapterError, type Usage } from '@nuzm/adapter-model';
import { GatewayService, ProviderInsightsService } from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * D-31: usage reported by the vendor against ours, end to end with a mock twin of the vendor. The "vendor figure" is what the adapter itself reported for every call (an independent
 * capture point of the same usage); the tests then move it by known percentages to show where the 1% proposal draws the line. Mock provider only; nothing leaves the process.
 */
let e: AiEnv;
let gw: GatewayService;
let svc: ProviderInsightsService;
const A = () => e.org.A!;
const call = () => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: [
    { role: 'user' as const, content: 'hello bakery, please write a short note about bread' },
  ],
  maxTokens: 60,
  callId: `c-${uuidv7()}`,
});
const only = (code: string) =>
  e.sql(
    `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code<>$1 AND enabled`,
    [code],
  );
const window = () => ({
  from: new Date(Date.now() - 3_600_000),
  to: new Date(Date.now() + 3_600_000),
});

const reported: Usage[] = [];
class Vendor extends MockModelAdapter {
  override async complete(...a: Parameters<MockModelAdapter['complete']>) {
    const r = await super.complete(...a);
    if (r.usage) reported.push(r.usage);
    return r;
  }
}
const vendorFigure = () => ({
  inputTokens: reported.reduce((n, u) => n + u.inputTokens, 0),
  outputTokens: reported.reduce((n, u) => n + u.outputTokens, 0),
});

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
  svc = e.app.get(ProviderInsightsService);
  await e.fund(A(), '1000000000');
  const adapter = new Vendor({ id: 'mock-use-a', handler: () => 'bread '.repeat(20) });
  await e.enableMock('mock-use-a', { rate: ['1000000', '1000000'], adapter });
  await only('mock-use-a');
  for (let i = 0; i < 8; i++) await gw.invoke(call());
}, 300_000);
afterAll(() => e.h.close());

describe('usage reconciliation against the vendor figure', () => {
  const q = (over: object = {}) => ({
    providerCode: 'mock-use-a',
    ...window(),
    vendor: { ...vendorFigure(), source: 'twin call log (synthetic)' },
    ...over,
  });
  it('an exact figure reconciles with no tolerance at all, and the breakdown is reported', async () => {
    const r = await svc.reconcileUsage(q());
    expect(r.withinTolerance).toBe(true);
    expect(r.difference).toEqual({ inputTokens: '0', outputTokens: '0' });
    expect(r.ours.calls).toBe(8);
    expect(r.ours.estimatedCalls).toBe(0);
    expect(BigInt(r.ours.inputTokens)).toBe(BigInt(vendorFigure().inputTokens));
  });
  it('2% more at the vendor: outside the proposed 1%, inside 3%; 2% LESS (we would overcharge) is outside 1% too', async () => {
    const v = vendorFigure();
    const more = {
      inputTokens: Math.ceil(v.inputTokens * 1.02),
      outputTokens: Math.ceil(v.outputTokens * 1.02),
      source: 'synthetic',
    };
    expect(
      (await svc.reconcileUsage(q({ vendor: more, tolerancePerMille: 10 }))).withinTolerance,
    ).toBe(false);
    expect(
      (await svc.reconcileUsage(q({ vendor: more, tolerancePerMille: 30 }))).withinTolerance,
    ).toBe(true);
    const less = {
      inputTokens: Math.floor(v.inputTokens * 0.98),
      outputTokens: Math.floor(v.outputTokens * 0.98),
      source: 'synthetic',
    };
    const r = await svc.reconcileUsage(q({ vendor: less, tolerancePerMille: 10 }));
    expect(r.withinTolerance).toBe(false);
    expect(BigInt(r.difference.inputTokens)).toBeLessThan(0n);
  });
  it('the proposal draws the line at exactly 1% of OUR figure, rounded up, input and output judged apart', async () => {
    const v = vendorFigure();
    const edge = Math.ceil((v.inputTokens * 10) / 1000);
    const at = {
      inputTokens: v.inputTokens + edge,
      outputTokens: v.outputTokens,
      source: 'synthetic',
    };
    expect(
      (await svc.reconcileUsage(q({ vendor: at, tolerancePerMille: 10 }))).withinTolerance,
    ).toBe(true);
    expect(
      (
        await svc.reconcileUsage(
          q({ vendor: { ...at, inputTokens: at.inputTokens + 1 }, tolerancePerMille: 10 }),
        )
      ).withinTolerance,
    ).toBe(false);
    // an absolute tolerance is added to it
    expect(
      (
        await svc.reconcileUsage(
          q({
            vendor: { ...at, inputTokens: at.inputTokens + 1 },
            tolerancePerMille: 10,
            toleranceTokens: 1,
          }),
        )
      ).withinTolerance,
    ).toBe(true);
    // a big output difference is not hidden by a good input match
    expect(
      (
        await svc.reconcileUsage(
          q({
            vendor: { ...at, inputTokens: v.inputTokens, outputTokens: v.outputTokens * 2 },
            tolerancePerMille: 10,
          }),
        )
      ).withinTolerance,
    ).toBe(false);
  });
  it('calls whose tokens were estimated (the provider reported none) and failed calls are shown apart', async () => {
    const est = new Vendor({
      id: 'mock-use-b',
      handler: () => 'bread '.repeat(20),
      reportUsage: false,
    });
    await e.enableMock('mock-use-b', { rate: ['1000000', '1000000'], adapter: est });
    await only('mock-use-b');
    await gw.invoke(call());
    est.failNext(new ModelAdapterError('invalid_request', 'rejected', false));
    await gw.invoke(call()).catch(() => undefined);
    const r = await svc.reconcileUsage(
      q({
        providerCode: 'mock-use-b',
        vendor: { inputTokens: 0, outputTokens: 0, source: 'synthetic' },
      }),
    );
    // the failed call falls over to the provider's second model, which also reports no usage: both successes are estimated
    expect(r.ours.estimatedCalls).toBe(r.ours.calls);
    expect(r.ours.calls).toBeGreaterThanOrEqual(1);
    expect(r.errorCalls).toBeGreaterThanOrEqual(1);
    expect(BigInt(r.ours.estimatedInputTokens)).toBeGreaterThan(0n);
  });
  it('refuses nonsense and never reads another provider', async () => {
    for (const bad of [
      { providerCode: 'Bad Code' },
      { tolerancePerMille: -1 },
      { tolerancePerMille: 1001 },
      { tolerancePerMille: 1.5 },
      { toleranceTokens: -1 },
      { vendor: { inputTokens: -1, outputTokens: 1, source: 'synthetic' } },
      { vendor: { inputTokens: 1.5, outputTokens: 1, source: 'synthetic' } },
      { vendor: { inputTokens: 1, outputTokens: 1, source: '' } },
      { from: new Date('x') },
      { from: new Date(Date.now() + 10_000_000) },
    ])
      await expect(svc.reconcileUsage(q(bad)), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    const other = await svc.reconcileUsage(
      q({
        providerCode: 'mock-nonexistent',
        vendor: { inputTokens: 0, outputTokens: 0, source: 'synthetic' },
      }),
    );
    expect(other.ours.calls).toBe(0);
    expect(other.withinTolerance).toBe(true);
  });
});
