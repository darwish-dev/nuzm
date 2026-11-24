import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_REQUIRED_DECISIONS,
  MOCK_TOOL_MODEL_ID,
  ModelAdapterError,
  createLiveTwin,
  liveSuiteWorstCase,
  tokenCostNano,
  trackWorstCase,
  TWIN_PRICING,
  type ModelAdapter,
  type QualificationTrack,
} from '@nuzm/adapter-model';
import {
  envelopeFileName,
  parseTracks,
  reconcileEnvelopeInvoice,
  runExecutor,
  scanForLeaks,
  usdToNano,
  type ExecutorArgs,
  type ExecutorTrack,
} from './live-executor';
import type { SmokeDeps } from './live-smoke';

// SYNTHETIC: a scripted twin stands in for the provider, the "key" is made up, the references are not real decisions. Nothing is sent anywhere; every result is SIMULATED.
const KEY = `synthetic-key-${'q9Zx'.repeat(6)}`;
const NOW = new Date('2026-12-01T00:00:00Z');
const worst = (tracks: ExecutorTrack[]) =>
  tracks
    .map((t) => (t === 'S' ? liveSuiteWorstCase() : trackWorstCase(t as QualificationTrack)))
    .reduce(
      (a, w) => ({
        requests: a.requests + w.requests,
        inputTokens: a.inputTokens + w.inputTokens,
        outputTokens: a.outputTokens + w.outputTokens,
        totalTokens: a.totalTokens + w.totalTokens,
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
const approvalFor = (tracks: ExecutorTrack[], over: Record<string, unknown> = {}) => {
  const w = worst(tracks);
  return {
    ref: 'synthetic-D9-ref',
    approvedBy: 'synthetic-owner',
    environment: 'non-production',
    maxRequests: w.requests,
    maxTotalTokens: w.totalTokens,
    maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING).toString(),
    ...over,
  };
};
const evidence = (skip?: string) =>
  LIVE_REQUIRED_DECISIONS.filter((d) => d !== skip).map((decision) => ({
    decision,
    ref: `synthetic-ref-${decision}`,
    recordedBy: 'synthetic-owner',
    recordedAt: '2026-11-20T10:00:00Z',
    provider: 'claude',
    environment: 'non-production',
    outcome: 'approved',
  }));
const envFor = (tracks: ExecutorTrack[], over: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const w = worst(tracks);
  return {
    NODE_ENV: 'test',
    AI_LIVE_PROVIDERS: 'claude',
    AI_PROBE_APPROVALS: JSON.stringify([
      {
        ref: 'synthetic-D9-ref',
        approvedBy: 'synthetic-owner',
        environment: 'non-production',
        maxRequests: w.requests,
        maxTotalTokens: w.totalTokens,
      },
    ]),
    ...over,
  };
};
const args = (tracks: ExecutorTrack[], over: Partial<ExecutorArgs> = {}): ExecutorArgs => ({
  tracks,
  execute: false,
  twin: false,
  provider: 'claude',
  vaultRef: 'vault://dev/ai-claude',
  approval: approvalFor(tracks),
  evidence: evidence(),
  ...over,
});

/** A twin standing in for the real adapter: reads the "key" on every call (like the real one) and, like a real vendor, refuses an output ceiling above the model limit. */
function harness(opts: { failComplete?: ModelAdapterError; contractVersion?: string } = {}) {
  const readKey = vi.fn(async () => KEY);
  let calls = 0;
  const deps = (e: NodeJS.ProcessEnv): SmokeDeps => ({
    env: e,
    readKey,
    model: MOCK_TOOL_MODEL_ID,
    now: () => NOW,
    makeAdapter: (getApiKey) => {
      const t = createLiveTwin('claude');
      return new Proxy(t, {
        get(target, prop, recv) {
          if (prop === 'contractVersion' && opts.contractVersion) return opts.contractVersion;
          if (prop === 'complete')
            return async (c: never, r: { maxTokens: number }) => {
              await getApiKey();
              calls++;
              if (opts.failComplete) throw opts.failComplete;
              if (r.maxTokens > target.models()[0]!.maxOutputTokens)
                throw new ModelAdapterError('invalid_request', 'refused', false);
              return target.complete(c, r as never);
            };
          if (prop === 'stream')
            return (c: never, r: never) =>
              (async function* () {
                await getApiKey();
                calls++;
                yield* target.stream(c, r);
              })();
          return Reflect.get(target, prop, recv);
        },
      }) as ModelAdapter;
    },
  });
  return { readKey, deps, calls: () => calls };
}

describe('helpers', () => {
  it('usdToNano reads plain decimals only', () => {
    expect(usdToNano('0.1167')).toBe(116_700_000n);
    expect(usdToNano('2')).toBe(2_000_000_000n);
    for (const bad of ['', '-1', '1e3', '0.1234567891', '$1', '1,5', 'abc'])
      expect(usdToNano(bad)).toBeNull();
  });
  it('parseTracks: default A,B,C, fixed order, unknown refused, the suite replaces B', () => {
    expect(parseTracks(undefined)).toEqual(['A', 'B', 'C']);
    expect(parseTracks('e,c,a')).toEqual(['A', 'E', 'C']);
    expect(parseTracks('A,Z')).toHaveProperty('error');
    expect(parseTracks('B,S')).toHaveProperty('error');
    expect(parseTracks('A,S')).toEqual(['A', 'S']);
  });
  it('scanForLeaks names what it found and never returns the match', () => {
    expect(scanForLeaks('fine text', [KEY])).toEqual([]);
    const f = scanForLeaks(
      `x ${KEY} y sk-${'a'.repeat(30)} Authorization: Bearer ${'t'.repeat(24)}`,
      [KEY],
    );
    expect(f).toEqual(
      expect.arrayContaining([
        'the credential itself',
        'an OpenAI-style key',
        'a bearer token',
        'an authorization header',
      ]),
    );
    for (const x of f) expect(x).not.toContain(KEY);
  });
  it('the file name is <date>-<id>.json, with sim- for a mock run', () => {
    expect(
      envelopeFileName({ createdAt: '2026-12-01T00:00:00.000Z', id: 'abc', mode: 'live' }),
    ).toBe('2026-12-01-abc.json');
    expect(
      envelopeFileName({ createdAt: '2026-12-01T00:00:00.000Z', id: 'abc', mode: 'mock' }),
    ).toBe('2026-12-01-sim-abc.json');
  });
});

describe('--twin: a rehearsal of every track, SIMULATED, no key and no evidence file needed', () => {
  it('runs A,D,B,E,C and the suite separately; every claim is SIMULATED or NOT VERIFIED, never LIVE-VERIFIED', async () => {
    for (const tracks of [
      ['A', 'B', 'C', 'D', 'E'],
      ['A', 'C', 'D', 'E', 'S'],
    ] as ExecutorTrack[][]) {
      const h = harness();
      const r = await runExecutor(
        args(tracks, { twin: true, approval: undefined, evidence: undefined, vaultRef: undefined }),
        h.deps({ NODE_ENV: 'test' }),
      );
      expect(r.kind).toBe('ran');
      if (r.kind !== 'ran') return;
      expect(r.envelope).toMatchObject({
        mode: 'mock',
        schema: 'nuzm.p3-provider-evidence',
        leakCheck: { performed: true, findings: 0 },
      });
      expect(r.envelope.claims.some((c) => c.label === 'LIVE-VERIFIED')).toBe(false);
      expect(r.envelope.claims.filter((c) => c.label === 'FAIL')).toEqual([]);
      expect(['SIMULATED', 'NOT VERIFIED']).toContain(r.envelope.verdict);
      expect(r.envelope.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.envelope.outputsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(h.readKey).not.toHaveBeenCalled();
      expect(r.fileName).toMatch(/^2026-12-01-sim-/);
    }
  });
});

describe('dry run: the plan and the HARD CAP first, nothing sent, no key read', () => {
  it('prints per-track maxima and the cumulative hard cap; the approval must cover the sum', async () => {
    const h = harness();
    const tracks: ExecutorTrack[] = ['A', 'B', 'C'];
    const r = await runExecutor(args(tracks), h.deps(envFor(tracks)));
    expect(r.kind).toBe('dry_run');
    if (r.kind !== 'dry_run') return;
    const w = worst(tracks);
    expect(r.plan.hardCapNano).toBe(
      tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING).toString(),
    );
    expect(r.plan.tracks.map((t) => t.track)).toEqual(['A', 'B', 'C']);
    expect(r.plan.approvalMustCover).toMatchObject({
      maxRequests: w.requests,
      maxTotalTokens: w.totalTokens,
    });
    expect(r.plan.decisionsStanding).toEqual([...LIVE_REQUIRED_DECISIONS]);
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.calls()).toBe(0);
  });
});

describe('refusals before the key is read (acceptance A5: every live path refuses without each of D2/D3/D4/D5/D6/D9)', () => {
  const tracks: ExecutorTrack[] = ['A', 'B', 'C'];
  it.each([...LIVE_REQUIRED_DECISIONS])('without the %s evidence row', async (decision) => {
    const h = harness();
    const r = await runExecutor(
      args(tracks, { execute: true, evidence: evidence(decision) }),
      h.deps(envFor(tracks)),
    );
    expect(r.kind).toBe('refused');
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.calls()).toBe(0);
  });
  it('without the live gate, without a vault reference, with a withdrawn D3, in production', async () => {
    const t = tracks;
    for (const [over, e] of [
      [{}, envFor(t, { AI_LIVE_PROVIDERS: '' })],
      [{ vaultRef: undefined }, envFor(t)],
      [{ vaultRef: KEY }, envFor(t)],
      [
        {
          evidence: [
            ...evidence(),
            { ...evidence()[1]!, outcome: 'withdrawn', recordedAt: '2026-11-21T10:00:00Z' },
          ],
        },
        envFor(t),
      ],
      [{}, envFor(t, { NODE_ENV: 'production' })],
    ] as [Partial<ExecutorArgs>, NodeJS.ProcessEnv][]) {
      const h = harness();
      const r = await runExecutor(args(t, { execute: true, ...over }), h.deps(e));
      expect(r.kind, JSON.stringify(over)).toBe('refused');
      expect(h.readKey).not.toHaveBeenCalled();
    }
  });
  it('an approval that covers only the largest single track does not cover the whole plan', async () => {
    const h = harness();
    const r = await runExecutor(
      args(tracks, { execute: true, approval: approvalFor(['B']) }),
      h.deps(envFor(['B'])),
    );
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.problems.join(' ')).toMatch(/worst case/);
    expect(h.readKey).not.toHaveBeenCalled();
  });
  it('a cap above the approval money ceiling, and a malformed cap, are refused', async () => {
    const h = harness();
    const w = worst(tracks);
    const above = (
      Number(tokenCostNano(w.inputTokens, w.outputTokens, TWIN_PRICING)) / 1e9 +
      1
    ).toFixed(6);
    const r = await runExecutor(
      args(tracks, { execute: true, capUsd: above }),
      h.deps(envFor(tracks)),
    );
    expect(r.kind).toBe('refused');
    const m = await runExecutor(
      args(tracks, { execute: true, capUsd: 'lots' }),
      h.deps(envFor(tracks)),
    );
    expect(m.kind).toBe('refused');
    expect(h.readKey).not.toHaveBeenCalled();
  });
});

describe('--execute (against the stand-in adapter: this proves the executor, never a provider)', () => {
  it('runs A,D,B,E,C within the cap, every claim labelled, no key in the envelope', async () => {
    const tracks: ExecutorTrack[] = ['A', 'B', 'C', 'D', 'E'];
    const h = harness();
    const r = await runExecutor(args(tracks, { execute: true }), h.deps(envFor(tracks)));
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    const e = r.envelope;
    expect(e.mode).toBe('live'); // the executor labels by the target's mode: here the stand-in is wired as the live adapter, so this proves the labelling, never a provider
    expect(e.tracks.map((t) => [t.track, t.status])).toEqual([
      ['A', 'ran'],
      ['D', 'ran'],
      ['B', 'ran'],
      ['E', 'ran'],
      ['C', 'ran'],
    ]);
    expect(BigInt(e.cap.spentNano)).toBeLessThanOrEqual(BigInt(e.cap.hardMaxNano));
    expect(e.cap.overran).toBe(false);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(e.approvals.decisions.map((x) => x.decision)).toEqual([...LIVE_REQUIRED_DECISIONS]);
    expect(e.claims.find((c) => /agent tool loop/.test(c.claim))?.label).toBe('LIVE-VERIFIED');
    expect(e.claims.find((c) => /retry and circuit breaker/.test(c.claim))?.label).toBe(
      'SIMULATED',
    );
    expect(e.claims.find((c) => /401, 429 and 5xx/.test(c.claim))?.label).toBe('NOT VERIFIED');
    expect(e.leakCheck).toEqual({ performed: true, findings: 0 });
    expect(h.readKey).toHaveBeenCalled();
  });
  it('the cap is enforced BEFORE each track: a cap that covers A but not B runs A and reports the rest as not run', async () => {
    const tracks: ExecutorTrack[] = ['A', 'B', 'C'];
    const a = worst(['A']);
    const capA = Number(tokenCostNano(a.inputTokens, a.outputTokens, TWIN_PRICING)) / 1e9;
    const h = harness();
    const r = await runExecutor(
      args(tracks, { execute: true, capUsd: capA.toFixed(9) }),
      h.deps(envFor(tracks)),
    );
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    expect(r.envelope.tracks[0]).toMatchObject({ track: 'A', status: 'ran' });
    expect(r.envelope.tracks.slice(1).map((t) => t.status)).toEqual(['not_run', 'not_run']);
    expect(r.envelope.tracks[1]!.reason).toMatch(/remaining budget/);
    expect(BigInt(r.envelope.cap.spentNano)).toBeLessThanOrEqual(
      BigInt(r.envelope.cap.hardMaxNano),
    );
    expect(r.envelope.verdict).toBe('NOT VERIFIED');
  });
  it('a cap below every track runs nothing and never reads the key', async () => {
    const tracks: ExecutorTrack[] = ['A', 'B', 'C'];
    const h = harness();
    const r = await runExecutor(
      args(tracks, { execute: true, capUsd: '0.000001' }),
      h.deps(envFor(tracks)),
    );
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    expect(r.envelope.tracks.every((t) => t.status === 'not_run')).toBe(true);
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.calls()).toBe(0);
  });
  it('a credential or availability failure ends the run: nothing further is sent, nothing is retried', async () => {
    const tracks: ExecutorTrack[] = ['A', 'C'];
    const h = harness({ failComplete: new ModelAdapterError('unavailable', 'no key', false) });
    const r = await runExecutor(args(tracks, { execute: true }), h.deps(envFor(tracks)));
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    expect(r.envelope.tracks[0]).toMatchObject({ track: 'A', status: 'ran' });
    expect(r.envelope.tracks[1]).toMatchObject({ track: 'C', status: 'not_run' });
    expect(r.envelope.tracks[1]!.reason).toMatch(/credential_or_availability/);
    expect(r.envelope.verdict).toBe('FAIL');
    expect(h.calls()).toBe(1); // the one failed request of track A; track C sent nothing
  });
  it('the live-run leak check discards an envelope that contains the credential (acceptance A4)', async () => {
    const tracks: ExecutorTrack[] = ['A'];
    const h = harness({ contractVersion: `1.1.0-${KEY}` });
    const r = await runExecutor(args(tracks, { execute: true }), h.deps(envFor(tracks)));
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') {
      expect(r.problems.join(' ')).toMatch(/discarded/);
      expect(r.problems.join(' ')).not.toContain(KEY);
    }
  });
});

describe('invoice reconciliation of a saved envelope', () => {
  const live = async () => {
    const h = harness();
    const r = await runExecutor(args(['A'], { execute: true }), h.deps(envFor(['A'])));
    if (r.kind !== 'ran') throw new Error('setup');
    return r.envelope;
  };
  it('a live envelope whose cost equals the invoice and whose vendor tokens price to it verifies both claims; a wrong amount fails; a mock envelope is refused', async () => {
    const e = await live();
    const usd = (Number(e.cap.spentNano) / 1e9).toFixed(9);
    // the tokens the run reported, summed from its records
    const tin = e.records.reduce((n, r) => n + r.totals.tokensIn, 0);
    const tout = e.records.reduce((n, r) => n + r.totals.tokensOut, 0);
    const ok = reconcileEnvelopeInvoice(e, {
      amountUsd: usd,
      currency: 'USD',
      source: 'synthetic console',
      vendorInputTokens: tin,
      vendorOutputTokens: tout,
    });
    expect(ok.kind).toBe('reconciled');
    if (ok.kind === 'reconciled')
      expect(ok.claims.map((c) => c.label)).toEqual(['LIVE-VERIFIED', 'LIVE-VERIFIED']);
    const wrong = reconcileEnvelopeInvoice(e, {
      amountUsd: '9.000000000',
      currency: 'USD',
      source: 'synthetic console',
    });
    expect(wrong.kind === 'reconciled' && wrong.claims[0]!.label).toBe('FAIL');
    expect(wrong.kind === 'reconciled' && wrong.claims[1]!.label).toBe('NOT VERIFIED');
    const mock = reconcileEnvelopeInvoice(
      { ...e, mode: 'mock' },
      { amountUsd: usd, currency: 'USD', source: 'x' },
    );
    expect(mock.kind).toBe('refused');
    expect(
      reconcileEnvelopeInvoice(e, { amountUsd: 'lots', currency: 'USD', source: 'x' }).kind,
    ).toBe('refused');
    expect(reconcileEnvelopeInvoice({}, {}).kind).toBe('refused');
  });
});
