import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  MockModelAdapter,
  ModelAdapterError,
  createResilience,
  type Clock,
  type Resilience,
} from '@nuzm/adapter-model';
import { ResidencyService } from '../compliance';
import { LedgerPostingService } from '../billing';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { AI_CONFIG, AiFlags, BudgetService, GatewayService, ModelProviderService, ModelAdapterRegistry } from './index';
import type { AiConfig } from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * Provider resilience through the REAL gateway (S-AG4): retry backoff, circuit breaker, health, approved fallback. Mock providers only; nothing leaves the process.
 * The suite builds its own GatewayService (own in-memory breaker state, controllable clock) next to the application's, so the other AI suites stay unaffected.
 */
let e: AiEnv;
const A = () => e.org.A!;
const msg = (content: string) => [{ role: 'user' as const, content }];
const base = () => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: msg('hello bakery'),
  maxTokens: 50,
  callId: `c-${uuidv7()}`,
});
const disable = (code: string) =>
  e.sql(
    `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code=$1`,
    [code],
  );

let now = 1_000_000;
const clock: Clock = { now: () => now };
const down = () => new ModelAdapterError('unavailable', 'down');

function gatewayWith(over: Partial<AiConfig>, r?: Resilience): GatewayService {
  const cfg: AiConfig = { ...e.app.get<AiConfig>(AI_CONFIG), ...over };
  return new GatewayService(
    e.app.get(DB),
    e.app.get(AuditSink),
    e.app.get(AiFlags),
    e.app.get(ModelAdapterRegistry),
    e.app.get(ModelProviderService),
    e.app.get(BudgetService),
    e.app.get(ResidencyService),
    e.app.get(LedgerPostingService),
    e.app.get(FieldCipher),
    cfg,
    r,
  );
}
const resilience = (o: Parameters<typeof createResilience>[0] = {}) =>
  createResilience({
    clock,
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 50, jitter: 'none' },
    breaker: { failureThreshold: 3, openMs: 10_000, halfOpenMaxProbes: 1 },
    ...o,
  });

beforeAll(async () => {
  e = await setupAiEnv();
  await e.fund(A(), '1000000');
}, 120_000);
afterAll(() => e.h.close());

describe('circuit breaker through the gateway', () => {
  let a: MockModelAdapter;
  let b: MockModelAdapter;
  beforeEach(() => {
    a?.clearFaults();
    b?.clearFaults();
  });
  beforeAll(async () => {
    ({ adapter: a } = await e.enableMock('mock-res-a'));
    ({ adapter: b } = await e.enableMock('mock-res-b', { rate: ['2000000', '4000000'] })); // dearer: ranked second
  });
  afterAll(async () => {
    await disable('mock-res-a');
    await disable('mock-res-b');
  });

  it('opens after the threshold, then the failing provider is skipped BEFORE any reservation and the next allowed one serves', async () => {
    const r = resilience();
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    a.clearFaults();
    a.failNext(down(), 100);
    // three calls: each fails on A (one attempt) and is served by B; the third failure opens A's circuit
    for (let i = 0; i < 3; i++) expect((await gw.invoke(base())).providerCode).toBe('mock-res-b');
    const before = a.calls.length;
    const callId = `c-${uuidv7()}`;
    expect((await gw.invoke({ ...base(), callId })).providerCode).toBe('mock-res-b');
    expect(a.calls.length).toBe(before); // not even tried
    const held = await e.sql(`SELECT call_id FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2`, [A(), `${callId}@%`]);
    expect(held.map((x) => String(x.call_id).split('@')[1]!.startsWith('mock-res-a'))).not.toContain(true); // no hold was taken for A
    expect(gw.providerHealth().find((h) => h.key.startsWith('mock-res-a/'))).toMatchObject({ breaker: 'open', status: 'unhealthy', lastErrorCode: 'unavailable' });
    a.clearFaults();
  });

  it('recovers: after the wait ONE trial call goes to the provider, a success closes the circuit', async () => {
    const r = resilience();
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    a.failNext(down(), 100);
    for (let i = 0; i < 3; i++) await gw.invoke(base());
    a.clearFaults();
    expect(r.breaker.state('mock-res-a')).toBe('open');
    now += 9_999;
    const calls = a.calls.length;
    expect((await gw.invoke(base())).providerCode).toBe('mock-res-b'); // still open
    expect(a.calls.length).toBe(calls);
    now += 1;
    expect((await gw.invoke(base())).providerCode).toBe('mock-res-a'); // the trial call succeeded
    expect(r.breaker.state('mock-res-a')).toBe('closed');
    expect((await gw.invoke(base())).providerCode).toBe('mock-res-a');
  });

  it('a failed trial call re-opens it for a full wait', async () => {
    const r = resilience();
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    a.failNext(down(), 100);
    for (let i = 0; i < 3; i++) await gw.invoke(base());
    now += 10_000;
    const calls = a.calls.length;
    await gw.invoke(base()); // the trial goes to A, fails, B serves
    expect(a.calls.length).toBe(calls + 1);
    expect(r.breaker.state('mock-res-a')).toBe('open');
    now += 9_999;
    await gw.invoke(base());
    expect(a.calls.length).toBe(calls + 1);
    a.clearFaults();
  });

  it('with every circuit open the caller gets 503 "paused", the reservation table is untouched, and nothing is called', async () => {
    const r = resilience({ breaker: { failureThreshold: 1, openMs: 10_000, halfOpenMaxProbes: 1 } });
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    a.failNext(down(), 100);
    b.failNext(down(), 100);
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    const calls = [a.calls.length, b.calls.length];
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable', detail: expect.stringContaining('circuit open') });
    expect([a.calls.length, b.calls.length]).toEqual(calls);
    a.clearFaults();
    b.clearFaults();
  });

  it('errors that are not the provider\'s fault (content filtered, bad request) never open the circuit', async () => {
    const r = resilience({ breaker: { failureThreshold: 1, openMs: 10_000, halfOpenMaxProbes: 1 } });
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    for (let i = 0; i < 3; i++) {
      a.failNext(new ModelAdapterError('content_filtered', 'no'), 1);
      await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'content_blocked' });
    }
    expect(r.health.all().every((h) => h.breaker === 'closed')).toBe(true);
    expect((await gw.invoke(base())).providerCode).toBe('mock-res-a');
  });

  it('a call the caller cancels releases the trial slot of a half-open circuit and is not counted against the provider', async () => {
    const r = resilience();
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    a.failNext(down(), 100);
    for (let i = 0; i < 3; i++) await gw.invoke(base());
    a.clearFaults();
    now += 10_000; // half-open
    const ac = new AbortController();
    ac.abort();
    await expect(gw.invoke({ ...base(), signal: ac.signal })).rejects.toMatchObject({ code: 'conflict' });
    // the trial slot is free again: the next call is the trial and closes the circuit
    expect((await gw.invoke(base())).providerCode).toBe('mock-res-a');
  });
});

describe('retry backoff through the gateway', () => {
  let a: MockModelAdapter;
  beforeEach(() => a?.clearFaults());
  beforeAll(async () => {
    ({ adapter: a } = await e.enableMock('mock-retry'));
  });
  afterAll(() => disable('mock-retry'));

  it('honours a short Retry-After on the same reservation, then succeeds', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 3 }, resilience({ retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 200, jitter: 'none' } }));
    a.failNext(new ModelAdapterError('rate_limited', 'slow', true, 30), 1);
    const callId = `c-${uuidv7()}`;
    const started = Date.now();
    const r = await gw.invoke({ ...base(), callId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(r.finishReason).toBe('stop');
    const held = await e.sql(`SELECT count(*) n FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2`, [A(), `${callId}@%`]);
    expect(Number(held[0]!.n)).toBe(1);
  });

  it('a Retry-After longer than the cap is NOT waited for: no further attempt on this provider, the call fails over (here: 503)', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 3 }, resilience({ retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 200, jitter: 'none' } }));
    const calls = a.calls.length;
    a.failNext(new ModelAdapterError('rate_limited', 'slow', true, 60_000), 50);
    const started = Date.now();
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
    // no candidate got a second attempt: the 60 s hint exceeds the cap, so the gateway moved on instead of waiting
    const made = a.calls.slice(calls);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((c) => c.callId.endsWith('#1'))).toBe(true);
  });

  it('a call cancelled while it waits to be retried sends nothing more, releases the reservation and answers conflict', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 3 }, resilience({ retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10_000, jitter: 'none' } }));
    a.failNext(new ModelAdapterError('rate_limited', 'slow', true, 5_000), 1);
    const calls = a.calls.length;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const callId = `c-${uuidv7()}`;
    const started = Date.now();
    await expect(gw.invoke({ ...base(), callId, signal: ac.signal })).rejects.toMatchObject({ code: 'conflict' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(a.calls.length).toBe(calls + 1);
    const open = await e.sql(`SELECT state FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2`, [A(), `${callId}@%`]);
    expect(open.every((x) => x.state !== 'held')).toBe(true);
    a.clearFaults();
  });

  it('exponential backoff without a hint is bounded by the policy (deterministic, no jitter)', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 3 }, resilience({ retry: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 40, jitter: 'none', multiplier: 2 } }));
    a.failNext(down(), 2);
    const started = Date.now();
    await gw.invoke(base());
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(55); // 20 + 40
    expect(took).toBeLessThan(2_000);
  });
});

describe('approved fallback routing through the gateway', () => {
  let a: MockModelAdapter;
  let b: MockModelAdapter;
  beforeEach(() => {
    a?.clearFaults();
    b?.clearFaults();
  });
  beforeAll(async () => {
    ({ adapter: a } = await e.enableMock('mock-fb-a'));
    ({ adapter: b } = await e.enableMock('mock-fb-b', { rate: ['2000000', '4000000'] }));
  });
  afterAll(async () => {
    await disable('mock-fb-a');
    await disable('mock-fb-b');
  });
  const modelOf = (ad: MockModelAdapter) => ad.models()[0]!.modelId;

  it('approved_only with nothing approved: a failing primary is NOT replaced by the other allowed provider', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 1, fallbackPolicy: { mode: 'approved_only', approved: {} } }, resilience());
    a.failNext(down(), 100);
    const bCalls = b.calls.length;
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(b.calls.length).toBe(bCalls);
    a.clearFaults();
  });
  it('approved_only with the pair approved: the fallback serves', async () => {
    const policy = { mode: 'approved_only' as const, approved: { [`mock-fb-a/${modelOf(a)}`]: [`mock-fb-b/${modelOf(b)}`] } };
    const gw = gatewayWith({ attemptsPerCandidate: 1, fallbackPolicy: policy }, resilience());
    a.failNext(down(), 100);
    expect((await gw.invoke(base())).providerCode).toBe('mock-fb-b');
    a.clearFaults();
  });
  it('the policy can never add a candidate: residency still decides who is allowed', async () => {
    await e.sql(`UPDATE ai.model_providers SET region='de-frankfurt' WHERE code='mock-fb-b'`);
    const policy = { mode: 'approved_only' as const, approved: { [`mock-fb-a/${modelOf(a)}`]: [`mock-fb-b/${modelOf(b)}`] } };
    const gw = gatewayWith({ attemptsPerCandidate: 1, fallbackPolicy: policy }, resilience());
    a.failNext(down(), 100);
    const bCalls = b.calls.length;
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(b.calls.length).toBe(bCalls);
    a.clearFaults();
    await e.sql(`UPDATE ai.model_providers SET region='sa-central' WHERE code='mock-fb-b'`);
  });
  it('without a policy (the default) every allowed candidate is a fallback, as before', async () => {
    const gw = gatewayWith({ attemptsPerCandidate: 1, fallbackPolicy: null }, resilience());
    a.failNext(down(), 100);
    expect((await gw.invoke(base())).providerCode).toBe('mock-fb-b');
    a.clearFaults();
  });
});

describe('health monitor through the gateway', () => {
  it('records successes with latency and failures with the code (per provider and per provider/model); a cancel is not a sample', async () => {
    const { adapter: a } = await e.enableMock('mock-health');
    const r = resilience({ breaker: { failureThreshold: 1000, openMs: 10_000, halfOpenMaxProbes: 1 } });
    const gw = gatewayWith({ attemptsPerCandidate: 1 }, r);
    for (let i = 0; i < 4; i++) await gw.invoke(base());
    const before = a.calls.length;
    a.failNext(new ModelAdapterError('timeout', 't'), 100);
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    a.clearFaults();
    const failures = a.calls.length - before;
    expect(failures).toBeGreaterThan(0);
    const ac = new AbortController();
    ac.abort();
    await expect(gw.invoke({ ...base(), signal: ac.signal })).rejects.toMatchObject({ code: 'conflict' });
    const h = gw.providerHealth().find((x) => x.key === 'mock-health')!;
    expect(h.samples).toBe(4 + failures);
    expect(h.successPerMille).toBe(Math.floor((4 * 1000) / (4 + failures)));
    expect(h.lastErrorCode).toBe('timeout');
    expect(h.p50LatencyMs).not.toBeNull();
    expect(['degraded', 'unhealthy']).toContain(h.status);
    const m = gw.providerHealth().filter((x) => x.key.startsWith('mock-health/'));
    expect(m.length).toBeGreaterThan(0);
    expect(m.reduce((n, x) => n + x.samples, 0)).toBe(4 + failures); // the model-level samples add up to the provider's
    await disable('mock-health');
  });
});
