import { describe, expect, it } from 'vitest';
import { newLifecycle } from './machine';
import { buildRunEvidence, claimOf, type EvidenceUsage } from './evidence';

const usage = (o: Partial<EvidenceUsage> = {}): EvidenceUsage => ({
  modelRefs: ['mock-a/model-1'],
  tokensIn: 700,
  tokensOut: 300,
  credits: '9',
  costMinor: null,
  calls: 1,
  realProvider: false,
  ...o,
});
const base = () => {
  const state = newLifecycle('2026-11-24T00:00:00.000Z');
  state.tokensIn = 700;
  state.tokensOut = 300;
  state.credits = '9';
  state.status = 'succeeded';
  return state;
};

describe('the run evidence record', () => {
  it('the claim comes from the origins of what ran, never from an assertion', () => {
    expect(claimOf(false, 'MOCK')).toBe('SIMULATED');
    expect(claimOf(false, null)).toBe('SIMULATED');
    expect(claimOf(true, 'MOCK')).toBe('MIXED');
    expect(claimOf(false, 'REAL')).toBe('MIXED');
    expect(claimOf(true, 'REAL')).toBe('REAL_COMPONENTS');
  });
  it('a dev-reference model plus a mock build is SIMULATED and says so; it is never LIVE-VERIFIED', () => {
    const e = buildRunEvidence({
      runId: 'r',
      projectId: 'p',
      state: base(),
      generator: 'model',
      generatedFiles: 12,
      builds: [
        {
          phase: 'build',
          round: 0,
          profile: 'typecheck',
          status: 'completed',
          durationMs: 5,
          origin: 'MOCK',
        },
      ],
      executionOrigin: 'MOCK',
      repairRecords: [],
      usage: usage(),
      finishedAt: '2026-11-24T00:01:00.000Z',
    });
    expect(e.claim).toBe('SIMULATED');
    expect(e.label).toMatch(/^SIMULATED/);
    expect(JSON.stringify(e)).not.toContain('LIVE-VERIFIED');
    expect(e.durations.totalMs).toBe(60_000);
    expect(e.filesGenerated).toBe(12);
    expect(e.reconciliation).toMatchObject({ equal: true, stateTokens: 1000, usageTokens: 1000 });
  });
  it('real model and real build give REAL_COMPONENTS, still not LIVE-VERIFIED (the qualification session decides that)', () => {
    const e = buildRunEvidence({
      runId: 'r',
      projectId: 'p',
      state: base(),
      generator: 'model',
      generatedFiles: 1,
      builds: [],
      executionOrigin: 'REAL',
      repairRecords: [],
      usage: usage({ realProvider: true, modelRefs: ['vendor/model-x'], costMinor: '120' }),
    });
    expect(e.claim).toBe('REAL_COMPONENTS');
    expect(e.label).toContain('not LIVE-VERIFIED');
    expect(e.costMinor).toBe('120');
  });
  it('a calls-free run is never "real" however the provider flag reads, and a mismatch between the lifecycle and the gateway shows as not equal', () => {
    const s = base();
    s.tokensIn = 1;
    const e = buildRunEvidence({
      runId: 'r',
      projectId: 'p',
      state: s,
      generator: 'skeleton',
      generatedFiles: 0,
      builds: [],
      executionOrigin: 'REAL',
      repairRecords: [],
      usage: usage({ realProvider: true, calls: 0 }),
    });
    expect(e.claim).toBe('MIXED');
    expect(e.reconciliation.equal).toBe(false);
  });
  it('summarizes tool invocations by tool without arguments', () => {
    const s = base();
    s.invocations = [
      {
        id: 'a',
        tool: 'read_file',
        step: 'file_generation',
        caller: 'runner',
        status: 'succeeded',
        argsHash: 'h',
        startedAt: 't',
      },
      {
        id: 'b',
        tool: 'apply_change',
        step: 'change_apply',
        caller: 'runner',
        status: 'denied',
        argsHash: 'h',
        startedAt: 't',
      },
    ] as never;
    const e = buildRunEvidence({
      runId: 'r',
      projectId: 'p',
      state: s,
      generator: null,
      generatedFiles: 0,
      builds: [],
      executionOrigin: null,
      repairRecords: [],
      usage: usage(),
    });
    expect(e.toolInvocationSummary).toEqual({
      read_file: { ok: 1, failed: 0, denied: 0 },
      apply_change: { ok: 0, failed: 0, denied: 1 },
    });
    expect(JSON.stringify(e.toolInvocations)).not.toContain('argsHash');
  });
});
