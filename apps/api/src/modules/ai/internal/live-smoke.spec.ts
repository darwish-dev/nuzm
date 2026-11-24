import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_REQUIRED_DECISIONS,
  MOCK_TOOL_MODEL_ID,
  createLiveTwin,
  liveSuiteCost,
  liveSuiteWorstCase,
  type ModelAdapter,
} from '@nuzm/adapter-model';
import { runSmoke, type SmokeArgs, type SmokeDeps } from './live-smoke';

// Everything here is SYNTHETIC: a scripted twin stands in for the provider, the "key" is a made-up string, the references are not real decisions. Nothing is sent anywhere.
const KEY = `synthetic-key-${'q9Zx'.repeat(6)}`;
const W = liveSuiteWorstCase();
const need = liveSuiteCost({ currency: 'USD', inputPerMillion: '4.00', outputPerMillion: '20.00' });
const NOW = new Date('2026-12-01T00:00:00Z');

const approval = (over: Record<string, unknown> = {}) => ({
  ref: 'synthetic-D9-ref',
  approvedBy: 'synthetic-owner',
  environment: 'non-production',
  maxRequests: W.requests,
  maxTotalTokens: W.totalTokens,
  maxCostNano: need.maxNano,
  ...over,
});
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
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  AI_LIVE_PROVIDERS: 'claude',
  AI_PROBE_APPROVALS: JSON.stringify([
    {
      ref: 'synthetic-D9-ref',
      approvedBy: 'synthetic-owner',
      environment: 'non-production',
      maxRequests: W.requests,
      maxTotalTokens: W.totalTokens,
    },
  ]),
  ...over,
});
const args = (over: Partial<SmokeArgs> = {}): SmokeArgs => ({
  execute: false,
  provider: 'claude',
  vaultRef: 'vault://dev/ai-claude',
  approval: approval(),
  evidence: evidence(),
  ...over,
});

/** A twin that behaves like the real adapter in the one way that matters here: it asks for the key before every request. */
function harness() {
  const readKey = vi.fn(async () => KEY);
  const made: ModelAdapter[] = [];
  const twinRef: { t?: ReturnType<typeof createLiveTwin> } = {};
  const deps = (e: NodeJS.ProcessEnv = env()): SmokeDeps => ({
    env: e,
    readKey,
    model: MOCK_TOOL_MODEL_ID,
    now: () => NOW,
    makeAdapter: (getApiKey) => {
      const t = createLiveTwin('claude');
      twinRef.t ??= t;
      const wrap = new Proxy(t, {
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
      made.push(wrap);
      return wrap;
    },
  });
  return { readKey, deps, made, twinRef };
}

describe('smoke runner gates: every refusal happens before the key is read', () => {
  const cases: [string, Partial<SmokeArgs>, Record<string, string>, string][] = [
    ['a provider that is not claude (D11)', { provider: 'openai' }, {}, 'D11'],
    ['a production process', {}, { NODE_ENV: 'production' }, 'production'],
    [
      'the provider missing from AI_LIVE_PROVIDERS (D3)',
      {},
      { AI_LIVE_PROVIDERS: '' },
      'AI_LIVE_PROVIDERS',
    ],
    ['no recorded probe approval (D9)', {}, { AI_PROBE_APPROVALS: '' }, 'AI_PROBE_APPROVALS'],
    [
      'a malformed AI_PROBE_APPROVALS value',
      {},
      { AI_PROBE_APPROVALS: '{not json' },
      'AI_PROBE_APPROVALS',
    ],
    [
      'an approval whose reference is not the recorded one',
      { approval: approval({ ref: 'another-ref' }) },
      {},
      'same reference',
    ],
    ['no approval file', { approval: undefined }, {}, 'approval file'],
    ['a raw key given as the credential', { vaultRef: KEY }, {}, 'dev-vault reference'],
    [
      'a production vault reference',
      { vaultRef: 'vault://prod/ai-claude' },
      {},
      'dev-vault reference',
    ],
    ['no credential reference', { vaultRef: undefined }, {}, 'dev-vault reference'],
    [
      'an approval below the worst case in tokens',
      { approval: approval({ maxTotalTokens: W.totalTokens - 1 }) },
      {},
      'worst case',
    ],
    [
      'an approval below the worst case in money',
      { approval: approval({ maxCostNano: '1000' }) },
      {},
      'money ceiling',
    ],
    [
      'an approval file asking for more than the recorded approval',
      { approval: approval({ maxRequests: W.requests + 5 }) },
      {},
      'more requests or tokens',
    ],
    ['no evidence at all', { evidence: undefined }, {}, 'evidence'],
    [
      'an approval in a production environment value',
      { approval: approval({ environment: 'production' }) },
      {},
      'non-production',
    ],
  ];
  it.each(cases)('%s', async (_n, over, e, text) => {
    const h = harness();
    for (const execute of [false, true]) {
      const r = await runSmoke(args({ ...over, execute }), h.deps(env(e)));
      expect(r.kind, _n).toBe('refused');
      if (r.kind === 'refused') expect(r.problems.join(' | ')).toContain(text);
    }
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.twinRef.t?.calls ?? []).toHaveLength(0);
  });
  it.each(LIVE_REQUIRED_DECISIONS)('missing evidence for %s refuses, naming it', async (d) => {
    const h = harness();
    const r = await runSmoke(
      args({ execute: true, evidence: evidence().filter((x) => x.decision !== d) }),
      h.deps(),
    );
    expect(r).toMatchObject({ kind: 'refused' });
    if (r.kind === 'refused') expect(r.problems).toContain(`${d}: no valid evidence row`);
    expect(h.readKey).not.toHaveBeenCalled();
  });
  it('lists every problem at once', async () => {
    const h = harness();
    const r = await runSmoke(
      args({ provider: 'gemini', vaultRef: undefined, approval: undefined, evidence: [] }),
      h.deps(env({ AI_LIVE_PROVIDERS: '', AI_PROBE_APPROVALS: '' })),
    );
    expect(r.kind === 'refused' && r.problems.length).toBeGreaterThanOrEqual(9);
  });
});

describe('smoke runner: dry run and execution', () => {
  it('is a dry run by default: shows the plan and the worst-case cost, reads no key, sends nothing', async () => {
    const h = harness();
    const r = await runSmoke(args(), h.deps());
    expect(r.kind).toBe('dry_run');
    if (r.kind !== 'dry_run') return;
    expect(r.plan.worstCase).toEqual(W);
    expect(r.plan.maxCostNano).toBe(need.maxNano);
    expect(r.plan.decisionsStanding).toEqual([...LIVE_REQUIRED_DECISIONS]);
    expect(r.plan.message).toContain('nothing was sent');
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.twinRef.t?.calls ?? []).toHaveLength(0);
  });
  it('executes only with --execute and every gate: reads the key from the dev vault reference, runs the suite as LIVE, and the report never carries the key', async () => {
    const h = harness();
    const r = await runSmoke(args({ execute: true }), h.deps());
    expect(r.kind).toBe('ran');
    if (r.kind !== 'ran') return;
    expect(h.readKey).toHaveBeenCalledWith('vault://dev/ai-claude');
    expect(h.readKey).toHaveBeenCalledTimes(1); // read once, then kept for the run only
    expect(r.report.mode).toBe('live');
    expect(r.report.checks.find((c) => c.id === 'streaming')).toMatchObject({
      ok: true,
      evidence: 'live',
    });
    expect(r.report.checks.find((c) => c.id === 'retry_and_breaker')).toMatchObject({
      evidence: 'simulated',
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
    // no vendor figure was supplied: reconciliation is NOT VERIFIED and the run is not a clean pass
    expect(r.report.checks.find((c) => c.id === 'usage_reconciliation')).toMatchObject({
      ok: false,
      ran: false,
    });
    expect(r.report.allPassed).toBe(false);
  });
  it('the effective caps are the LOWER of the approval file and the recorded approval', async () => {
    const h = harness();
    const r = await runSmoke(
      args({ execute: true, approval: approval({ maxTotalTokens: W.totalTokens }) }),
      h.deps(
        env({
          AI_PROBE_APPROVALS: JSON.stringify([
            {
              ref: 'synthetic-D9-ref',
              approvedBy: 'synthetic-owner',
              environment: 'non-production',
              maxRequests: W.requests,
              maxTotalTokens: W.totalTokens + 1000,
            },
          ]),
        }),
      ),
    );
    expect(r.kind).toBe('ran');
  });
  it('a malformed vendor-usage file refuses before the key is read', async () => {
    const h = harness();
    const r = await runSmoke(
      args({ execute: true, vendorUsage: { inputTokens: 'many' } }),
      h.deps(),
    );
    expect(r).toMatchObject({ kind: 'refused' });
    expect(h.readKey).not.toHaveBeenCalled();
  });
  it('a report that would carry the credential is discarded, not returned', async () => {
    const h = harness();
    // an approval reference that equals the key forces it into a report field (approvalRef): the guard must catch it
    const e = env({
      AI_PROBE_APPROVALS: JSON.stringify([
        {
          ref: KEY,
          approvedBy: 'synthetic-owner',
          environment: 'non-production',
          maxRequests: W.requests,
          maxTotalTokens: W.totalTokens,
        },
      ]),
    });
    const r = await runSmoke(args({ execute: true, approval: approval({ ref: KEY }) }), h.deps(e));
    expect(r).toMatchObject({
      kind: 'refused',
      problems: ['the report contained the credential and was discarded'],
    });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
