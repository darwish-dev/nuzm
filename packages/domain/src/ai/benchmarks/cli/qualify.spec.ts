import { describe, expect, it, vi } from 'vitest';
import {
  GOLDEN_TASKS,
  THRESHOLDS_VERSION,
  evidenceRecordProblems,
  referenceRecording,
  type CaptureSource,
  type EvidenceRecord,
} from '../index';
import { EXIT, runCli } from './qualify-core';

const run = async (argv: string[], env: Record<string, string> = {}, source?: CaptureSource) => {
  const out: string[] = [];
  const err: string[] = [];
  const loadSource = vi.fn(async () => source as CaptureSource);
  const writeFile = vi.fn();
  let t = 0;
  const code = await runCli(
    argv,
    env,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    { now: () => new Date(Date.UTC(2026, 11, 1, 0, 0, t++)).toISOString(), loadSource, writeFile },
  );
  return { code, out: out.join('\n'), err: err.join('\n'), loadSource, writeFile };
};
const evidenceOf = (text: string): EvidenceRecord =>
  JSON.parse(text.slice(text.indexOf('{\n  "schema"'))) as EvidenceRecord;

/** every approval a live stage A needs, as REFERENCES (Opus 5.5 list price: stage A maximum 440 cents) */
const LIVE_A: Record<string, string> = {
  NUZM_BENCH_LIVE: 'true',
  AI_LIVE_PROVIDERS: 'claude',
  NUZM_ENV: 'staging',
  NUZM_BENCH_PROVIDER_ID: 'claude',
  NUZM_BENCH_PROVIDER_MODEL: 'claude-opus-5-5',
  NUZM_BENCH_PROVIDER_EVIDENCE_REF: 'EV-PROVIDER-1',
  NUZM_BENCH_THRESHOLDS_VERSION: THRESHOLDS_VERSION,
  NUZM_BENCH_THRESHOLDS_ACCEPTED_BY: 'owner',
  NUZM_BENCH_THRESHOLDS_ACCEPTED_AT: '2026-12-01T00:00:00Z',
  NUZM_BENCH_BUDGET_REF: 'BUD-A',
  NUZM_BENCH_BUDGET_APPROVED_BY: 'owner',
  NUZM_BENCH_BUDGET_CURRENCY: 'USD',
  NUZM_BENCH_BUDGET_MAX_COST_MINOR: '440',
  NUZM_BENCH_BUDGET_MAX_TOKENS: '220000',
  NUZM_BENCH_BUDGET_MAX_REQUESTS: '30',
  NUZM_BENCH_REVIEWERS: 'r1:Reviewer One,r2:Reviewer Two',
  NUZM_BENCH_SECURITY_REVIEW_REF: 'SEC-1',
  NUZM_BENCH_SECURITY_REVIEW_BY: 'Security Person',
  NUZM_BENCH_SECURITY_REVIEW_AT: '2026-12-01T00:00:00Z',
  NUZM_BENCH_SECURITY_REVIEW_PASSED: 'true',
  NUZM_BENCH_PRICE_INPUT_MINOR: '400',
  NUZM_BENCH_PRICE_OUTPUT_MINOR: '2000',
  NUZM_BENCH_PRICE_CURRENCY: 'USD',
  NUZM_BENCH_PRICE_SOURCE: 'agreement ref 1',
  NUZM_BENCH_RATES_CONFIRMED_REF: 'D6-1',
  NUZM_BENCH_VENDOR_CAP_REF: 'D4-1',
  NUZM_BENCH_CAPTURE_SOURCE_MODULE: '/somewhere/source.js',
  NUZM_BENCH_APPROVAL_REF: 'APPROVAL-A-1',
};
const fakeSource = (mode: 'live' | 'mock'): { source: CaptureSource; calls: string[] } => {
  const calls: string[] = [];
  const byId = new Map(GOLDEN_TASKS.map((t) => [t.id, t]));
  return {
    calls,
    source: {
      mode,
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      capture: async ({ task }) => {
        calls.push(task.id);
        const rec = referenceRecording(byId.get(task.id)!);
        return {
          recording: {
            turns: rec.turns,
            patch: rec.patch,
            finishedWith: rec.finishedWith,
            contractVersion: rec.contractVersion,
          },
          usage: {
            tokensIn: rec.turns.reduce((a, t) => a + t.tokensIn, 0),
            tokensOut: rec.turns.reduce((a, t) => a + t.tokensOut, 0),
            requests: rec.turns.length,
          },
        };
      },
    },
  };
};

describe('Track H command: simulate (the default)', () => {
  it('prints the HARD MAXIMUM first, then a SIMULATED scorecard and a valid evidence record, and calls nothing', async () => {
    const r = await run([]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out.indexOf('HARD MAXIMUM COST: 4.40 USD')).toBeGreaterThan(-1);
    expect(r.out.indexOf('HARD MAXIMUM COST')).toBeLessThan(r.out.indexOf('SIMULATED'));
    expect(r.out).toContain('*** SIMULATED ***');
    expect(r.out).toContain('NOT CONFIRMED: reference only');
    for (const d of ['functional', 'security', 'arabic-rtl', 'tool-calling-reliability', 'latency'])
      expect(r.out).toContain(d);
    const rec = evidenceOf(r.out);
    expect(rec).toMatchObject({
      simulated: true,
      stage: 'A',
      label: 'OFFLINE_MOCK_REPLAY',
      providerEvidenceRef: null,
      approvals: null,
    });
    expect(rec.taskIds).toHaveLength(5);
    expect(rec.dataset.version).toBeTruthy();
    expect(evidenceRecordProblems(rec)).toEqual([]);
    expect(r.loadSource).not.toHaveBeenCalled();
  });
  it('works for every stage and every profile, and the weak profiles show in the scorecard', async () => {
    for (const stage of ['A', 'B', 'C', 'D', 'E'])
      expect((await run(['--stage', stage])).code, stage).toBe(EXIT.OK);
    const sloppy = evidenceOf((await run(['--stage', 'C', '--profile', 'sloppy-tools'])).out);
    const tool = sloppy.dimensions.find((d) => d.dimension === 'tool-calling-reliability')!;
    expect(tool.value!).toBeLessThan(0.95);
    expect(sloppy.thresholds.find((t) => t.id === 'T03')!.status).toBe('FAIL');
    expect(sloppy.simulated).toBe(true);
  });
  it('the printed maximum is the stage maximum for the chosen rate (stage C at Opus 5.5 list price is 83.60 USD)', async () => {
    const r = await run(['--stage', 'C']);
    expect(r.out).toContain('HARD MAXIMUM COST: 83.60 USD (8360 minor units)');
    expect(evidenceOf(r.out).cost.maxCostMinor).toBe('8360');
  });
  it('writes the record only when --out is given', async () => {
    const without = await run([]);
    expect(without.writeFile).not.toHaveBeenCalled();
    const withOut = await run(['--out', '/tmp/x.json']);
    expect(withOut.writeFile).toHaveBeenCalledTimes(1);
    expect(withOut.out).toContain('do not commit');
  });
  it('rejects unknown arguments, a bad stage, a bad profile and an unknown rate with the usage exit code', async () => {
    for (const argv of [
      ['--nope'],
      ['--stage', 'Z'],
      ['--profile', 'x'],
      ['--mode', 'x'],
      ['--rate', 'Nothing 1'],
      ['--confirm-max', '1.5'],
    ])
      expect((await run(argv)).code, argv.join(' ')).toBe(EXIT.USAGE);
  });
});

describe('Track H command: live REFUSES without every approval', () => {
  it('with nothing set it refuses, lists every missing approval, prints the maximum first, and never loads or calls a source', async () => {
    const { source, calls } = fakeSource('live');
    const r = await run(['--mode', 'live', '--stage', 'A'], {}, source);
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.out.indexOf('HARD MAXIMUM COST')).toBeLessThan(r.out.indexOf('REFUSED'));
    for (const code of [
      'FLAG_OFF',
      'LIVE_GATE_CLOSED',
      'ENVIRONMENT_NOT_ALLOWED',
      'PROVIDER_NOT_VERIFIED',
      'THRESHOLDS_NOT_ACCEPTED',
      'BUDGET_NOT_APPROVED',
      'REVIEWERS_NOT_NAMED',
      'SECURITY_REVIEW_MISSING',
      'PRICE_CARD_INVALID',
    ].filter((c) => c !== 'PRICE_CARD_INVALID'))
      expect(r.out, code).toContain(code);
    expect(r.out).toContain('CAPTURE_SOURCE_BUILT');
    expect(r.out).toContain('VENDOR_SPEND_CAP');
    expect(r.loadSource).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  const missing: [string, string, string][] = [
    ['the flag', 'NUZM_BENCH_LIVE', 'FLAG_OFF'],
    ['the live gate', 'AI_LIVE_PROVIDERS', 'LIVE_GATE_CLOSED'],
    ['the environment', 'NUZM_ENV', 'ENVIRONMENT_NOT_ALLOWED'],
    ['provider verification', 'NUZM_BENCH_PROVIDER_EVIDENCE_REF', 'PROVIDER_NOT_VERIFIED'],
    ['accepted thresholds', 'NUZM_BENCH_THRESHOLDS_ACCEPTED_BY', 'THRESHOLDS_NOT_ACCEPTED'],
    ['the approved budget', 'NUZM_BENCH_BUDGET_REF', 'BUDGET_NOT_APPROVED'],
    ['named reviewers', 'NUZM_BENCH_REVIEWERS', 'REVIEWERS_NOT_NAMED'],
    ['the security review', 'NUZM_BENCH_SECURITY_REVIEW_REF', 'SECURITY_REVIEW_MISSING'],
    ['the confirmed rates', 'NUZM_BENCH_RATES_CONFIRMED_REF', 'RATES_CONFIRMED'],
    ['the vendor spend cap', 'NUZM_BENCH_VENDOR_CAP_REF', 'VENDOR_SPEND_CAP'],
  ];
  for (const [what, key, code] of missing)
    it(`refuses without ${what} even when everything else is present`, async () => {
      const env = { ...LIVE_A };
      delete env[key];
      const { source, calls } = fakeSource('live');
      const r = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], env, source);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.out).toContain(code);
      expect(r.loadSource).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  it('refuses a security review that is present but not passed, a single reviewer, and production', async () => {
    for (const patch of [
      { NUZM_BENCH_SECURITY_REVIEW_PASSED: 'false' },
      { NUZM_BENCH_REVIEWERS: 'r1:Only One' },
      { NUZM_ENV: 'production' },
    ]) {
      const r = await run(
        ['--mode', 'live', '--stage', 'A', '--confirm-max', '440'],
        { ...LIVE_A, ...patch },
        fakeSource('live').source,
      );
      expect(r.code, JSON.stringify(patch)).toBe(EXIT.REFUSED);
    }
  });
  it('refuses a budget below the stage maximum (one minor unit less) and a zero price card', async () => {
    const tight = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], {
      ...LIVE_A,
      NUZM_BENCH_BUDGET_MAX_COST_MINOR: '439',
    });
    expect(tight.code).toBe(EXIT.REFUSED);
    expect(tight.out).toContain('BUDGET_TOO_SMALL');
    const zero = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], {
      ...LIVE_A,
      NUZM_BENCH_PRICE_INPUT_MINOR: '0',
    });
    expect(zero.code).toBe(EXIT.REFUSED);
    expect(zero.out).toContain('PRICE_CARD_INVALID');
  });
  it('stages B-E also need the previous stage (and E a baseline)', async () => {
    const r = await run(['--mode', 'live', '--stage', 'B'], {
      ...LIVE_A,
      NUZM_BENCH_BUDGET_MAX_COST_MINOR: '2360',
      NUZM_BENCH_BUDGET_MAX_TOKENS: '1180000',
      NUZM_BENCH_BUDGET_MAX_REQUESTS: '138',
    });
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.out).toContain('PREVIOUS_STAGE_EXITED');
  });
});

describe('Track H command: the confirmation gate and the capture source', () => {
  it('with every approval but no confirmation it stops with NOT CONFIRMED and the figure to type back', async () => {
    const { source, calls } = fakeSource('live');
    const r = await run(['--mode', 'live', '--stage', 'A'], LIVE_A, source);
    expect(r.code).toBe(EXIT.NOT_CONFIRMED);
    expect(r.out).toContain('--confirm-max 440');
    expect(r.loadSource).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it('a wrong confirmation figure, or a missing approval reference, does not start anything', async () => {
    for (const [argv, env] of [
      [['--confirm-max', '441'], LIVE_A],
      [['--confirm-max', '440'], { ...LIVE_A, NUZM_BENCH_APPROVAL_REF: ' ' }],
    ] as const) {
      const { source, calls } = fakeSource('live');
      const r = await run(['--mode', 'live', '--stage', 'A', ...argv], { ...env }, source);
      expect(r.code).toBe(EXIT.NOT_CONFIRMED);
      expect(calls).toEqual([]);
    }
  });
  it('confirmed, but without a capture source module it refuses (no real source exists in this repository)', async () => {
    const env = { ...LIVE_A };
    delete env.NUZM_BENCH_CAPTURE_SOURCE_MODULE;
    const r = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], env);
    expect(r.code).toBe(EXIT.REFUSED); // CAPTURE_SOURCE_BUILT is a stage prerequisite
    expect(r.out).toContain('CAPTURE_SOURCE_BUILT');
  });
  it('fully approved and confirmed, a MOCK source yields a SIMULATED record (never evidence about a model)', async () => {
    const { source, calls } = fakeSource('mock');
    const r = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], LIVE_A, source);
    expect(r.code).toBe(EXIT.OK);
    expect(calls).toHaveLength(5);
    expect(r.out).toContain('SIMULATED');
    const rec = evidenceOf(r.out);
    expect(rec).toMatchObject({
      simulated: true,
      label: 'OFFLINE_MOCK_REPLAY',
      approvals: null,
      providerEvidenceRef: null,
    });
    expect(evidenceRecordProblems(rec)).toEqual([]);
  });
  it('fully approved and confirmed, a source declaring itself live yields the exact live evidence record with its provenance', async () => {
    const { source, calls } = fakeSource('live');
    const r = await run(['--mode', 'live', '--stage', 'A', '--confirm-max', '440'], LIVE_A, source);
    expect(r.code).toBe(EXIT.OK);
    expect(calls).toHaveLength(5);
    const rec = evidenceOf(r.out);
    expect(rec).toMatchObject({
      simulated: false,
      stage: 'A',
      label: 'OFFLINE_REPLAY_OF_RECORDED_RUN',
      model: { adapterId: 'claude', model: 'claude-opus-5-5' },
      providerEvidenceRef: 'EV-PROVIDER-1',
      thresholdsVersion: THRESHOLDS_VERSION,
      status: 'COMPLETED',
    });
    expect(rec.dataset.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.taskIds).toHaveLength(5);
    expect(rec.usage.tokens).toBe(rec.usage.tokensIn + rec.usage.tokensOut);
    expect(BigInt(rec.cost.costMinor)).toBeLessThanOrEqual(BigInt(rec.cost.maxCostMinor));
    expect(rec.dimensions.map((d) => d.dimension)).toHaveLength(7);
    expect(rec.approvals).toMatchObject({
      budgetRef: 'BUD-A',
      thresholdsAcceptedBy: 'owner',
      securityReviewRef: 'SEC-1',
      confirmRef: 'APPROVAL-A-1',
      reviewers: ['Reviewer One', 'Reviewer Two'],
    });
    expect(evidenceRecordProblems(rec)).toEqual([]);
    // the record never carries content: only ids, numbers and references
    expect(JSON.stringify(rec)).not.toMatch(/export const|<html|function /);
  });
  it('a source that is not the verified provider and model is refused by the runner without being called', async () => {
    const { source, calls } = fakeSource('live');
    const r = await run(
      ['--mode', 'live', '--stage', 'A', '--confirm-max', '440'],
      { ...LIVE_A, NUZM_BENCH_PROVIDER_MODEL: 'another-model' },
      source,
    );
    expect(r.code).toBe(EXIT.REFUSED);
    expect(calls).toEqual([]);
  });
});

describe('evidence record validation', () => {
  const base = async () => evidenceOf((await run([])).out);
  it('refuses a live record without provenance, a simulated record that claims to be recorded, a cost above the maximum, a missing dimension and a secret', async () => {
    const r = await base();
    const live = { ...r, simulated: false, label: 'OFFLINE_REPLAY_OF_RECORDED_RUN' };
    expect(evidenceRecordProblems(live).join('; ')).toMatch(/provider evidence reference/);
    expect(evidenceRecordProblems(live).join('; ')).toMatch(/approval reference/);
    expect(
      evidenceRecordProblems({ ...r, label: 'OFFLINE_REPLAY_OF_RECORDED_RUN' }).join(),
    ).toMatch(/simulated record cannot/);
    expect(
      evidenceRecordProblems({ ...r, cost: { ...r.cost, costMinor: '99999' } }).join(),
    ).toMatch(/exceeds the stage maximum/);
    expect(evidenceRecordProblems({ ...r, dimensions: r.dimensions.slice(1) }).join()).toMatch(
      /seven dimensions/,
    );
    expect(
      evidenceRecordProblems({ ...r, runId: 'api_key = "AAAAAAAAAAAAAAAAAAAAAAAA"' }).join(),
    ).toMatch(/secret/);
    expect(evidenceRecordProblems({ ...r, taskIds: [] }).join()).toMatch(/task ids/);
    expect(evidenceRecordProblems({ ...r, usage: { ...r.usage, tokens: 1 } }).join()).toMatch(
      /usage/,
    );
    expect(evidenceRecordProblems(null)).toEqual(['not an object']);
    expect(evidenceRecordProblems({ ...r, schema: 'x' }).join()).toMatch(/schema/);
  });
});
