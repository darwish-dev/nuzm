import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_REQUIRED_DECISIONS,
  MOCK_TOOL_MODEL_ID,
  createLiveTwin,
  tokenCostNano,
  trackWorstCase,
  TWIN_PRICING,
  type ModelAdapter,
  type QualificationTrack,
} from '@nuzm/adapter-model';
import { runQualificationCommand, type QualifyArgs } from './live-qualification';
import type { SmokeDeps } from './live-smoke';

// SYNTHETIC: a scripted twin stands in for the provider, the "key" is made up, the references are not real decisions. Nothing is sent anywhere.
const KEY = `synthetic-key-${'q9Zx'.repeat(6)}`;
const NOW = new Date('2026-12-01T00:00:00Z');
const TRACKS: QualificationTrack[] = ['A', 'B', 'C'];

const approval = (t: QualificationTrack, over: Record<string, unknown> = {}) => {
  const w = trackWorstCase(t);
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
const evidence = () =>
  LIVE_REQUIRED_DECISIONS.map((decision) => ({
    decision,
    ref: `synthetic-ref-${decision}`,
    recordedBy: 'synthetic-owner',
    recordedAt: '2026-11-20T10:00:00Z',
    provider: 'claude',
    environment: 'non-production',
    outcome: 'approved',
  }));
const env = (t: QualificationTrack, over: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const w = trackWorstCase(t);
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
const args = (t: QualificationTrack, over: Partial<QualifyArgs> = {}): QualifyArgs => ({
  track: t,
  twin: false,
  execute: false,
  provider: 'claude',
  vaultRef: 'vault://dev/ai-claude',
  approval: approval(t),
  evidence: evidence(),
  ...over,
});
function harness() {
  const readKey = vi.fn(async () => KEY);
  const twins: ReturnType<typeof createLiveTwin>[] = [];
  const deps = (e: NodeJS.ProcessEnv): SmokeDeps => ({
    env: e,
    readKey,
    model: MOCK_TOOL_MODEL_ID,
    now: () => NOW,
    makeAdapter: (getApiKey) => {
      const t = createLiveTwin('claude');
      twins.push(t);
      return new Proxy(t, {
        get(target, prop, recv) {
          if (prop === 'complete')
            return async (c: never, r: never) => {
              await getApiKey();
              return target.complete(c, r);
            };
          if (prop === 'stream')
            return (c: never, r: never) =>
              (async function* () {
                await getApiKey();
                yield* target.stream(c, r);
              })();
          return Reflect.get(target, prop, recv);
        },
      }) as ModelAdapter;
    },
  });
  return { readKey, twins, deps };
}

describe('--twin: every track runs against the mock twin and says SIMULATED, with no key and no evidence file needed', () => {
  it.each(TRACKS)('track %s', async (t) => {
    const h = harness();
    const r = await runQualificationCommand(
      args(t, { twin: true, approval: undefined, evidence: undefined, vaultRef: undefined }),
      h.deps({ NODE_ENV: 'test' }),
    );
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    expect(r.evidence.verdict).toBe('SIMULATED');
    expect(r.evidence.mode).toBe('mock');
    expect(r.fileName).toMatch(/^qualification-[ABC]-mock-live-twin-mock-/);
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.twins).toHaveLength(0); // no real-adapter factory was even used
  });
});

describe('without --twin every track REFUSES before the key is read', () => {
  const cases: [
    string,
    (t: QualificationTrack) => Partial<QualifyArgs>,
    Record<string, string>,
    string,
  ][] = [
    ['a provider that is not claude (D11)', () => ({ provider: 'openai' }), {}, 'D11'],
    ['a production process', () => ({}), { NODE_ENV: 'production' }, 'production'],
    [
      'the provider missing from AI_LIVE_PROVIDERS (D3)',
      () => ({}),
      { AI_LIVE_PROVIDERS: '' },
      'AI_LIVE_PROVIDERS',
    ],
    [
      'no recorded probe approval (D9)',
      () => ({}),
      { AI_PROBE_APPROVALS: '' },
      'AI_PROBE_APPROVALS',
    ],
    [
      'an approval below the worst case',
      (t) => ({ approval: approval(t, { maxTotalTokens: trackWorstCase(t).totalTokens - 1 }) }),
      {},
      'worst case',
    ],
    [
      'a money ceiling below the worst case',
      (t) => ({ approval: approval(t, { maxCostNano: '1000' }) }),
      {},
      'money ceiling',
    ],
    ['a raw key as the credential', () => ({ vaultRef: KEY }), {}, 'dev-vault reference'],
    ['no evidence at all', () => ({ evidence: undefined }), {}, 'evidence'],
  ];
  it.each(TRACKS.flatMap((t) => cases.map((c) => [t, ...c] as const)))(
    'track %s: %s',
    async (t, _n, over, e, text) => {
      const h = harness();
      for (const execute of [false, true]) {
        const r = await runQualificationCommand(
          args(t, { ...over(t), execute }),
          h.deps(env(t, e)),
        );
        expect(r.kind, _n).toBe('refused');
        if (r.kind === 'refused') expect(r.problems.join(' | ')).toContain(text);
      }
      expect(h.readKey).not.toHaveBeenCalled();
      expect(h.twins.every((x) => x.calls.length === 0)).toBe(true);
    },
  );
  it.each(TRACKS.flatMap((t) => LIVE_REQUIRED_DECISIONS.map((d) => [t, d] as const)))(
    'track %s: missing evidence for %s',
    async (t, d) => {
      const h = harness();
      const r = await runQualificationCommand(
        args(t, { execute: true, evidence: evidence().filter((x) => x.decision !== d) }),
        h.deps(env(t)),
      );
      expect(r.kind === 'refused' && r.problems).toContain(`${d}: no valid evidence row`);
      expect(h.readKey).not.toHaveBeenCalled();
    },
  );
  it('an unknown track is refused', async () => {
    const h = harness();
    expect(
      await runQualificationCommand(args('A', { track: 'Z' as never }), h.deps(env('A'))),
    ).toMatchObject({ kind: 'refused' });
  });
});

describe('dry run and execution with every gate', () => {
  it.each(TRACKS)(
    'track %s: a dry run shows the plan, the worst case and the evidence file name; reads no key, sends nothing',
    async (t) => {
      const h = harness();
      const r = await runQualificationCommand(args(t), h.deps(env(t)));
      expect(r.kind).toBe('dry_run');
      if (r.kind !== 'dry_run') return;
      expect(r.plan.worstCase).toEqual(trackWorstCase(t));
      expect(r.plan.decisionsStanding).toEqual([...LIVE_REQUIRED_DECISIONS]);
      expect(r.plan.evidenceFile).toMatch(
        new RegExp(`^qualification-${t}-claude-live-20261201T000000Z\\.json$`),
      );
      expect(h.readKey).not.toHaveBeenCalled();
    },
  );
  it.each(TRACKS)(
    'track %s: --execute reads the key once, runs as LIVE, and the record is valid and key-free',
    async (t) => {
      const h = harness();
      const r = await runQualificationCommand(args(t, { execute: true }), h.deps(env(t)));
      expect(r.kind).toBe('ran');
      if (r.kind !== 'ran') return;
      expect(h.readKey).toHaveBeenCalledTimes(1);
      expect(h.readKey).toHaveBeenCalledWith('vault://dev/ai-claude');
      expect(r.evidence.mode).toBe('live');
      expect(r.evidence.verdict).toBe('LIVE-VERIFIED'); // the stand-in is a twin: this proves the labelling and the plumbing, not a provider
      expect(JSON.stringify(r)).not.toContain(KEY);
    },
  );
  it('a record that would carry the credential is discarded', async () => {
    const h = harness();
    const e = env('A', {
      AI_PROBE_APPROVALS: JSON.stringify([
        {
          ref: KEY,
          approvedBy: 'synthetic-owner',
          environment: 'non-production',
          maxRequests: trackWorstCase('A').requests,
          maxTotalTokens: trackWorstCase('A').totalTokens,
        },
      ]),
    });
    const r = await runQualificationCommand(
      args('A', { execute: true, approval: approval('A', { ref: KEY }) }),
      h.deps(e),
    );
    expect(r).toMatchObject({
      kind: 'refused',
      problems: ['the evidence record contained the credential and was discarded'],
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
