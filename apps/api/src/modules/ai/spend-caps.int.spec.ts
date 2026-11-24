import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  MockModelAdapter,
  ModelAdapterError,
  type CallContext,
  type CompleteRequest,
} from '@nuzm/adapter-model';
import { GatewayService } from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * Phase 2, spending caps: the platform's caps are the FIRST line and must stop calls BEFORE the vendor's own monthly cap (D4) is reached. The vendor is a mock that behaves like the
 * documented vendor limit (requests are refused once the vendor-side spend is used up; the refusal is not retryable). Mock providers only; nothing leaves the process.
 */
let e: AiEnv;
let gw: GatewayService;
const A = () => e.org.A!;
const call = (over: object = {}) => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: [{ role: 'user' as const, content: 'hello bakery' }],
  maxTokens: 40,
  callId: `c-${uuidv7()}`,
  ...over,
});

/** a vendor with a monthly spend limit in tokens: past it, every request is refused, like the vendor console's cap */
class CappedVendor extends MockModelAdapter {
  spent = 0;
  vendorRefusals = 0;
  constructor(
    id: string,
    private readonly vendorCapTokens: number,
  ) {
    super({ id, handler: () => 'w'.repeat(4 * 30) });
  }
  override async complete(ctx: CallContext, req: CompleteRequest) {
    if (this.spent >= this.vendorCapTokens) {
      this.vendorRefusals += 1;
      throw new ModelAdapterError(
        'rate_limited',
        'the model provider spending limit is reached',
        false,
      );
    }
    const r = await super.complete(ctx, req);
    this.spent += (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    return r;
  }
}
const held = async () =>
  Number((await e.sql(`SELECT count(*)::int n FROM ai.reservations WHERE state='held'`))[0]!.n);
const only = (code: string) =>
  e.sql(
    `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code<>$1 AND enabled`,
    [code],
  );
const setOrgBudget = async (org: object) => {
  const g = await e.call('alice', 'GET', '/v1/ai/budgets');
  const r = await e.call('alice', 'PUT', '/v1/ai/budgets', { org }, A(), {
    'if-match': g.headers.etag as string,
  });
  expect(r.statusCode, r.body).toBe(200);
};
const usedCredits = async (code: string) =>
  BigInt(
    (
      await e.sql(
        `SELECT coalesce(sum(credits),0)::text s FROM ai.model_usage WHERE org_id=$1 AND provider_code=$2 AND outcome='ok'`,
        [A(), code],
      )
    )[0]!.s as string,
  );

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
  await e.fund(A(), '100000000');
}, 300_000);
afterAll(() => e.h.close());

describe('the platform cap stops calls before the vendor cap', () => {
  it('a daily credit cap below the vendor cap ends the calls with budget_exceeded; the vendor never refuses and is not called after the denial', async () => {
    // 1 credit per token (rate 1,000,000 credits per million tokens); the vendor allows 20,000 tokens, the platform 600 credits a day
    const vendor = new CappedVendor('mock-cap-ok', 20_000);
    await e.enableMock('mock-cap-ok', { rate: ['1000000', '1000000'], adapter: vendor });
    await only('mock-cap-ok');
    await setOrgBudget({ dailyCredits: 600 });
    let ok = 0;
    let denied: unknown;
    for (let i = 0; i < 200 && !denied; i++) {
      try {
        await gw.invoke(call());
        ok += 1;
      } catch (err) {
        denied = err;
      }
    }
    expect(denied, 'the platform cap never stopped the calls').toMatchObject({
      code: 'budget_exceeded',
    });
    expect(ok).toBeGreaterThan(0);
    // the vendor was never refused: the platform stopped first, with a wide margin
    expect(vendor.vendorRefusals).toBe(0);
    expect(vendor.spent).toBeLessThan(20_000);
    // the cap held: what was charged never passes the day's credits, not even by one reservation
    expect(await usedCredits('mock-cap-ok')).toBeLessThanOrEqual(600n);
    // after the denial nothing more reaches the vendor, however often the caller retries
    const callsAtDenial = vendor.calls.length;
    for (let i = 0; i < 5; i++)
      await expect(gw.invoke(call())).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(vendor.calls.length).toBe(callsAtDenial);
    expect(await held()).toBe(0);
    await setOrgBudget({}); // lift the cap for the next tests
  });

  it('a wallet that cannot cover the reservation stops the call before any vendor request', async () => {
    const vendor = new CappedVendor('mock-cap-ok', 1_000_000);
    e.registry.register('mock-cap-ok', vendor);
    await e.fund(e.org.B!, '3');
    await expect(gw.invoke(call({ orgId: e.org.B!, maxTokens: 1000 }))).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    expect(vendor.calls).toHaveLength(0);
    expect(await e.wallet(e.org.B!)).toBe(3n);
  });

  it('the denial happens BEFORE the adapter is reached: the reservation is the gate, so the vendor sees nothing', async () => {
    const vendor = new CappedVendor('mock-cap-ok', 1_000_000);
    e.registry.register('mock-cap-ok', vendor);
    await setOrgBudget({ dailyCredits: 1 });
    await expect(gw.invoke(call())).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(vendor.calls).toHaveLength(0);
    expect(await held()).toBe(0);
    await setOrgBudget({});
  });

  it('a per-run credit cap stops the run before the vendor, and the vendor sees only the calls the cap allowed', async () => {
    const vendor = new CappedVendor('mock-cap-ok', 1_000_000);
    e.registry.register('mock-cap-ok', vendor);
    const runId = uuidv7();
    await e.sql(
      `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1,$2,'t','SA') ON CONFLICT DO NOTHING`,
      [runId, A()],
    );
    await e.sql(
      `INSERT INTO ai.runs (id, org_id, session_id, kind, data_region, budget) VALUES ($1,$2,$1,'chat','SA','{}')`,
      [runId, A()],
    );
    let ok = 0;
    let denied: unknown;
    for (let i = 0; i < 100 && !denied; i++) {
      try {
        await gw.invoke(call({ runId, runBudget: { maxCredits: 400 } }));
        ok += 1;
      } catch (err) {
        denied = err;
      }
    }
    expect(denied).toMatchObject({ code: 'budget_exceeded' });
    expect(ok).toBeGreaterThan(0);
    expect(vendor.vendorRefusals).toBe(0);
    expect(vendor.calls.length).toBe(ok);
    expect(await held()).toBe(0);
  });
});

describe('when the VENDOR cap is the lower one (the platform cap is higher or not set)', () => {
  it('the vendor refusal is not retried, nothing is charged for it, the reservation is released, and the other models of that provider are not tried', async () => {
    const vendor = new CappedVendor('mock-cap-vendor', 300);
    await e.enableMock('mock-cap-vendor', { rate: ['1000000', '1000000'], adapter: vendor });
    await only('mock-cap-vendor');
    const walletBefore = await e.wallet(A());
    let okCalls = 0;
    let failure: unknown;
    for (let i = 0; i < 50 && !failure; i++) {
      try {
        await gw.invoke(call());
        okCalls += 1;
      } catch (err) {
        failure = err;
      }
    }
    expect(failure, 'the vendor cap was never reached').toBeTruthy();
    expect(okCalls).toBeGreaterThan(0);
    // exactly ONE refused request for the failing gateway call: a spending limit is not retried, and the provider's other models (same account, same limit) are not tried either
    expect(vendor.vendorRefusals).toBe(1);
    // the caller is told the provider is unavailable (our fixed sentence), never anything the vendor said
    expect((failure as { code?: string }).code).toBe('service_unavailable');
    expect(await held()).toBe(0);
    // only the successful calls were charged
    expect(walletBefore - (await e.wallet(A()))).toBe(await usedCredits('mock-cap-vendor'));
  });
});
