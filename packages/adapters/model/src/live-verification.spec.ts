import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FaultInjectingAdapter,
  LIVE_CHECK_IDS,
  LiveSuiteRefused,
  assertLiveSuiteAllowed,
  liveSuiteCost,
  liveSuiteWorstCase,
  resilientInvoke,
  runLiveVerification,
  type LiveSuiteApproval,
} from './live-verification';
import { createLiveTwin, twinTarget, TWIN_PRICING } from './live-twin';
import { createResilience } from './resilience';
import { MockModelAdapter, MOCK_TOOL_MODEL_ID, MOCK_SERIAL_TOOL_MODEL_ID } from './mock';
import { ModelAdapterError, type Usage } from './types';
import { formatNano } from './probe-cost';
import { LIVE_REQUIRED_DECISIONS, type LiveEvidenceRow } from './live-evidence';

// SYNTHETIC approval and evidence: nothing below is a real decision or a real price.
const W = liveSuiteWorstCase();
const need = liveSuiteCost(TWIN_PRICING);
const approval = (over: Partial<LiveSuiteApproval> = {}): LiveSuiteApproval => ({
  ref: 'synthetic-D9-ref',
  approvedBy: 'synthetic-owner',
  environment: 'non-production',
  maxRequests: W.requests,
  maxTotalTokens: W.totalTokens,
  maxCostNano: need.maxNano,
  ...over,
});
const evidence = (): LiveEvidenceRow[] =>
  LIVE_REQUIRED_DECISIONS.map((decision) => ({
    decision,
    ref: `synthetic-ref-${decision}`,
    recordedBy: 'synthetic-owner',
    recordedAt: '2026-11-20T10:00:00Z',
    provider: 'mock-live-twin',
    environment: 'non-production',
    outcome: 'approved',
  }));
const sum = (us: Usage[]) => ({
  inputTokens: us.reduce((n, u) => n + u.inputTokens, 0),
  outputTokens: us.reduce((n, u) => n + u.outputTokens, 0),
});

afterEach(() => vi.restoreAllMocks());

describe('the plan and its worst case (what the approver sees)', () => {
  it('is 13 requests / 14,716 tokens, and costs at most USD 0.116720 at the synthetic 4/20 price', () => {
    expect(W).toEqual({
      requests: 13,
      inputTokens: 11_100,
      outputTokens: 3_616,
      totalTokens: 14_716,
    });
    expect(formatNano(need.maxNano, 6)).toBe('0.116720');
    expect(need.probeOnly.requests).toBe(8);
    expect(formatNano(need.probeOnly.maxNano)).toBe('0.080720');
  });
});

describe('the mock twin runs EVERY check, and says it is simulated', () => {
  it('passes all nine checks within the approved caps; nothing is labelled live', async () => {
    const { target, primary } = twinTarget();
    // the "vendor figure" is what the twin reported through its own call log: an independent capture point of the same usage
    const rep = await runLiveVerification(target, approval(), {
      usageToleranceTokens: 0,
    });
    expect(rep.checks.map((c) => c.id)).toEqual([...LIVE_CHECK_IDS]);
    const failed = rep.checks.filter((c) => !(c.ok && c.ran));
    // usage reconciliation is NOT VERIFIED without a vendor figure, by design: every other check must pass
    expect(failed.map((c) => c.id)).toEqual(['usage_reconciliation']);
    expect(failed[0]!.detail).toContain('no vendor figure');
    expect(rep.checks.every((c) => c.evidence !== 'live')).toBe(true);
    expect(rep.allPassed).toBe(false);
    expect(rep.mode).toBe('mock');
    expect(rep.requests).toBeLessThanOrEqual(W.requests);
    expect(rep.totalTokens).toBeLessThanOrEqual(W.totalTokens);
    expect(BigInt(rep.costNano)).toBeLessThanOrEqual(BigInt(need.maxNano));
    expect(primary.calls.length).toBeGreaterThanOrEqual(rep.requests);
  });
  it('reconciles usage against a vendor figure; a figure that differs by one token fails at tolerance 0', async () => {
    const reported: Usage[] = [];
    const { target, primary } = twinTarget();
    // capture what the twin reports at the lowest level (an independent tally of the same calls)
    const origComplete = primary.complete.bind(primary);
    primary.complete = async (c, r) => {
      const x = await origComplete(c, r);
      if (x.usage) reported.push(x.usage);
      return x;
    };
    const origStream = primary.stream.bind(primary);
    primary.stream = (c, r) =>
      (async function* () {
        for await (const ch of origStream(c, r)) {
          if ('done' in ch && ch.usage) reported.push(ch.usage);
          yield ch;
        }
      })();
    target.vendorUsage = async () => ({ ...sum(reported), source: 'twin call log (synthetic)' });
    const ok = await runLiveVerification(target, approval());
    const u = ok.checks.find((c) => c.id === 'usage_reconciliation')!;
    expect(u, JSON.stringify(u)).toMatchObject({ ok: true, ran: true, evidence: 'simulated' });
    expect(ok.allPassed).toBe(true);

    const t2 = twinTarget();
    t2.target.vendorUsage = async () => ({
      inputTokens: 1,
      outputTokens: 1,
      source: 'synthetic wrong',
    });
    const bad = await runLiveVerification(t2.target, approval());
    expect(bad.checks.find((c) => c.id === 'usage_reconciliation')).toMatchObject({
      ok: false,
      ran: true,
    });
    expect(bad.allPassed).toBe(false);
    // the same wrong figure passes only with an absurd tolerance, which is the operator's explicit choice
    const t3 = twinTarget();
    t3.target.vendorUsage = async () => ({
      inputTokens: 1,
      outputTokens: 1,
      source: 'synthetic wrong',
    });
    const lax = await runLiveVerification(t3.target, approval(), {
      usageToleranceTokens: 1_000_000,
    });
    expect(lax.checks.find((c) => c.id === 'usage_reconciliation')!.ok).toBe(true);
  });
  it('without a second approved provider the fallback check proves the clean refusal, not a switch', async () => {
    const { target } = twinTarget({ withFallback: false });
    const rep = await runLiveVerification(target, approval());
    const f = rep.checks.find((c) => c.id === 'fallback_routing')!;
    expect(f).toMatchObject({ ok: true, evidence: 'simulated' });
    expect(f.detail).toContain('only the refusal path was exercised');
  });
  it('a twin that cannot tool-call (a serial-only model with no tool script) is NOT VERIFIED for tool calling, never a pass', async () => {
    const { target, primary } = twinTarget();
    primary.toolHandler = () => ({ text: 'I refuse to call tools' });
    const rep = await runLiveVerification(target, approval());
    expect(rep.checks.find((c) => c.id === 'tool_calling')).toMatchObject({ ok: false, ran: true });
    expect(rep.allPassed).toBe(false);
  });
  it('a contract-1.0 style target (no tool-use declared) leaves tool calling as not run, and cancellation still runs on its own', async () => {
    const { target, primary } = twinTarget();
    target.model = 'mock-chat-1';
    // an adapter whose model list has no tool-use model: build via the default mock model ids
    const plain = new MockModelAdapter({
      id: 'plain',
      pricing: TWIN_PRICING,
      chunkDelayMs: 0,
    });
    void primary;
    const t = { ...target, adapter: plain, model: 'mock-chat-1', fallback: undefined as never };
    delete (t as { fallback?: unknown }).fallback;
    const rep = await runLiveVerification(t, approval());
    expect(rep.checks.find((c) => c.id === 'tool_calling')).toMatchObject({
      ok: false,
      ran: false,
    });
    expect(rep.checks.find((c) => c.id === 'cancel_mid_stream')).toMatchObject({
      ok: true,
      ran: true,
    });
    expect(rep.checks.find((c) => c.id === 'streaming')!.ok).toBe(true);
  });
});

describe('a broken provider is caught, never passed', () => {
  it('a stream that ignores cancellation fails the cancel check', async () => {
    const { target, primary } = twinTarget();
    const orig = primary.stream.bind(primary);
    // ignore the abort signal: the same chunks, but the signal is not passed on
    primary.stream = (_c, r) => orig({ callId: 'x' }, r);
    primary.toolHandler = () => ({ text: 'no tools' }); // so the cancel check runs on its own, not from the probe
    const rep = await runLiveVerification(target, approval());
    expect(rep.checks.find((c) => c.id === 'cancel_mid_stream')).toMatchObject({
      ok: false,
      ran: true,
    });
  });
  it('a structured-output answer that is not JSON fails; so does one that is JSON but not the requested object', async () => {
    for (const text of ['Sure! {"ok": true}', '["ok"]', '{"ok":false}']) {
      const { target, primary } = twinTarget();
      primary.handler = (r) => (r.responseFormat === 'json' ? text : 'ok');
      const rep = await runLiveVerification(target, approval());
      expect(rep.checks.find((c) => c.id === 'structured_output')!.ok, text).toBe(false);
    }
  });
  it('a provider that reports no usage fails streaming and reconciliation (no estimate is passed off as a report)', async () => {
    const { target, primary } = twinTarget();
    primary.reportUsage = false;
    const rep = await runLiveVerification(target, approval());
    expect(rep.checks.find((c) => c.id === 'streaming')!.ok).toBe(false);
    expect(rep.checks.find((c) => c.id === 'usage_reconciliation')!.ok).toBe(false);
  });
  it('a credential failure stops the run at once and the rest is listed as not run', async () => {
    const { target, primary } = twinTarget();
    primary.failNext(new ModelAdapterError('invalid_request', 'the key was rejected', false));
    const rep = await runLiveVerification(target, approval());
    expect(rep.stoppedEarly).toBe('credential_or_availability');
    expect(rep.checks.find((c) => c.id === 'streaming')).toMatchObject({ ok: false, ran: true });
    expect(rep.checks.find((c) => c.id === 'structured_output')).toMatchObject({
      ok: false,
      ran: false,
    });
    expect(rep.allPassed).toBe(false);
    expect(primary.calls.length).toBe(1);
  });
  it('a rate limit stops the run; a cancelled signal stops it before anything is sent', async () => {
    const t = twinTarget();
    t.primary.failNext(new ModelAdapterError('rate_limited', 'slow down'));
    expect((await runLiveVerification(t.target, approval())).stoppedEarly).toBe('rate_limited');
    const ac = new AbortController();
    ac.abort();
    const t2 = twinTarget();
    const rep = await runLiveVerification(t2.target, approval(), { signal: ac.signal });
    expect(rep.stoppedEarly).toBe('aborted');
    expect(t2.primary.calls).toHaveLength(0);
  });
});

describe('refusals before anything is sent', () => {
  const t = () => twinTarget().target;
  it.each([
    ['no approval', undefined, 'recorded approval'],
    ['a short reference', approval({ ref: 'x' }), 'reference'],
    ['no approver', approval({ approvedBy: ' ' }), 'name of the approver'],
    ['too few requests', approval({ maxRequests: W.requests - 1 }), 'requests'],
    [
      'a token cap below the worst case',
      approval({ maxTotalTokens: W.totalTokens - 1 }),
      'token cap',
    ],
    ['no money ceiling', approval({ maxCostNano: '' }), 'money ceiling'],
    [
      'a money ceiling below the worst case',
      approval({ maxCostNano: (BigInt(need.maxNano) - 1n).toString() }),
      'money ceiling',
    ],
    [
      'a production environment value',
      approval({ environment: 'production' as never }),
      'non-production',
    ],
  ])('%s', async (_n, a, text) => {
    const target = t();
    await expect(runLiveVerification(target, a as LiveSuiteApproval)).rejects.toThrow(
      LiveSuiteRefused,
    );
    await expect(runLiveVerification(target, a as LiveSuiteApproval)).rejects.toThrow(text);
    expect((target.adapter as ReturnType<typeof createLiveTwin>).calls).toHaveLength(0);
  });
  it('an unknown model, and a production process', () => {
    const { target } = twinTarget();
    expect(() => assertLiveSuiteAllowed({ ...target, model: 'nope' }, approval())).toThrow(
      'unknown model',
    );
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertLiveSuiteAllowed(target, approval())).toThrow('production');
    vi.unstubAllEnvs();
  });
  it('a LIVE target needs the live gate and every evidence row; the mock twin never opens either', async () => {
    const { target, primary } = twinTarget();
    const live = { ...target, mode: 'live' as const };
    expect(() => assertLiveSuiteAllowed(live, approval(), { evidence: evidence() })).toThrow(
      'AI_LIVE_PROVIDERS',
    );
    expect(() =>
      assertLiveSuiteAllowed(live, approval(), { liveProviders: ['mock-live-twin'] }),
    ).toThrow('live run refused');
    for (const d of LIVE_REQUIRED_DECISIONS) {
      const rows = evidence().filter((r) => r.decision !== d);
      expect(
        () =>
          assertLiveSuiteAllowed(live, approval(), {
            liveProviders: ['mock-live-twin'],
            evidence: rows,
          }),
        d,
      ).toThrow(`${d}: no valid evidence row`);
    }
    expect(() =>
      assertLiveSuiteAllowed(live, approval(), { liveProviders: ['other'], evidence: evidence() }),
    ).toThrow('AI_LIVE_PROVIDERS');
    expect(() =>
      assertLiveSuiteAllowed(live, approval(), {
        liveProviders: ['mock-live-twin'],
        evidence: evidence(),
      }),
    ).not.toThrow();
    // refused runs sent nothing
    await expect(runLiveVerification(live, approval())).rejects.toThrow(LiveSuiteRefused);
    expect(primary.calls).toHaveLength(0);
  });
  it('a LIVE run labels its real checks live and the injected-fault checks simulated', async () => {
    const { target } = twinTarget();
    const rep = await runLiveVerification({ ...target, mode: 'live' }, approval(), {
      liveProviders: ['mock-live-twin'],
      evidence: evidence(),
    });
    const by = Object.fromEntries(rep.checks.map((c) => [c.id, c.evidence]));
    expect(by).toMatchObject({
      streaming: 'live',
      structured_output: 'live',
      tool_calling: 'live',
      cancel_mid_stream: 'live',
      health: 'live',
      retry_and_breaker: 'simulated',
      fallback_routing: 'simulated',
    });
  });
});

describe('caps stop the run before the money does', () => {
  it('a provider that reports far more input than the allowance trips the running cap: later requests are NOT sent, and the overrun is flagged', async () => {
    const { target, primary } = twinTarget();
    const inflate = (u: Usage | null): Usage | null =>
      u ? { inputTokens: u.inputTokens + 3_000, outputTokens: u.outputTokens } : u;
    const oc = primary.complete.bind(primary);
    primary.complete = async (c, r) => {
      const x = await oc(c, r);
      return { ...x, usage: inflate(x.usage) };
    };
    const os = primary.stream.bind(primary);
    primary.stream = (c, r) =>
      (async function* () {
        for await (const ch of os(c, r))
          yield 'done' in ch ? { ...ch, usage: inflate(ch.usage) } : ch;
      })();
    const rep = await runLiveVerification(target, approval());
    expect(['token_cap', 'cost_cap']).toContain(rep.stoppedEarly);
    expect(rep.requests).toBeLessThan(W.requests);
    expect(primary.calls.length).toBeLessThan(W.requests);
    expect(rep.allPassed).toBe(false);
    expect(rep.checks.some((c) => !c.ran)).toBe(true);
  });
  it('a provider with no usage report is charged at the ceilings, which are exactly the approved worst case: the run completes within the caps', async () => {
    const { target, primary } = twinTarget();
    primary.reportUsage = false;
    const rep = await runLiveVerification(target, approval());
    expect(rep.overran).toBe(false);
    expect(rep.totalTokens).toBeLessThanOrEqual(W.totalTokens);
    expect(BigInt(rep.costNano)).toBeLessThanOrEqual(BigInt(need.maxNano));
  });
  it('the real-money ceiling stops the run even when the token cap would allow it', async () => {
    const { target } = twinTarget();
    // the approval check refuses a ceiling below the plan; a price that rises after the check (a changed adapter price) is what the running guard is for
    const a = approval();
    let calls = 0;
    const price = { ...TWIN_PRICING };
    Object.defineProperty(target.adapter, 'pricing', {
      get: () => (++calls > 1 ? { ...price, outputPerMillion: '2000.00' } : price),
    });
    const rep = await runLiveVerification(target, a);
    expect(rep.stoppedEarly).toBe('cost_cap');
  });
});

describe('FaultInjectingAdapter and resilientInvoke', () => {
  it('a faulted attempt is never delegated; a scripted null lets the next one through', async () => {
    const twin = createLiveTwin();
    const fi = new FaultInjectingAdapter(twin);
    fi.script(new ModelAdapterError('unavailable', 'x'), null);
    const res = createResilience({
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 'none' },
    });
    const r = await resilientInvoke(
      res,
      [{ key: 'p/m', providerCode: 'p', modelId: MOCK_TOOL_MODEL_ID, adapter: fi }],
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 20 },
      'c',
    );
    expect(r.ok).toBe(true);
    expect(fi.attempts).toBe(2);
    expect(fi.delegated).toBe(1);
    expect(twin.calls).toHaveLength(1);
    expect(r.healthOk).toBe(1);
    expect(r.healthFail).toBe(1);
  });
  it('MOCK_SERIAL_TOOL_MODEL_ID is still a declared model of the twin (a guard against list drift)', () => {
    expect(
      createLiveTwin()
        .models()
        .map((m) => m.modelId),
    ).toContain(MOCK_SERIAL_TOOL_MODEL_ID);
  });
});
