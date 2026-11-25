import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registryOf, type RecordedApproval } from './approvals';
import { REQUIRED_PROVIDER_DECISIONS, verifyProviderEnvelope } from './native-provider';
import { buildMatrix } from './matrix';
import { evidenceDir, repoRoot, verifyAll } from './verify';

/**
 * P3-S08: the independent verifier of P3-S01's native envelope (`nuzm.p3-provider-evidence`). The fixtures are SYNTHETIC (no run happened): they are shaped like the producer's output
 * and re-sealed (hashes recomputed) after each mutation so that a test proves exactly ONE rule.
 */
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test fixtures are mutated freely; the verifier under test validates the shape
const approvedAll = registryOf(
  REQUIRED_PROVIDER_DECISIONS.map((id): RecordedApproval => ({
    id,
    decision: 'x',
    reference: `REF-${id}`,
    date: '2026-12-02',
    by: 'owner',
  })),
);
const none = registryOf([]);

function record(track: 'A' | 'B' | 'C', mode: 'live' | 'mock', ok = true): Loose {
  return {
    schemaVersion: 1,
    track,
    mode,
    verdict: ok ? (mode === 'live' ? 'LIVE-VERIFIED' : 'SIMULATED') : 'FAIL',
    startedAt: '2026-12-02T10:00:00.000Z',
    finishedAt: '2026-12-02T10:00:05.000Z',
    totals: { requests: 2, tokensIn: 100, tokensOut: 50, costNano: '2000000' },
    checks: [
      {
        id: track === 'B' ? 'tool_calling' : track === 'C' ? 'codegen_slugify' : 'listing',
        ok,
        ran: true,
        detail: 'fixed sentence',
      },
    ],
  };
}
/** re-compute every hash of the envelope (what the producer does) */
function seal(e: Loose): Loose {
  e.tracks = (e.records as Loose[]).map((r) => ({
    track: r.track,
    status: 'ran',
    verdict: r.verdict,
    requests: 2,
    costNano: r.totals.costNano,
    recordSha256: sha(r),
  }));
  e.cap.spentNano = String(
    (e.records as Loose[]).reduce((a, r) => a + BigInt(r.totals.costNano), 0n),
  );
  e.outputsSha256 = sha({ records: e.records, suite: e.suite ?? null });
  return e;
}
function envelope(
  mode: 'live' | 'mock' = 'live',
  over: (e: Loose) => void = () => undefined,
): Loose {
  const live = mode === 'live';
  const e: Loose = {
    schema: 'nuzm.p3-provider-evidence',
    schemaVersion: 1,
    id: '0193a000-0000-7000-8000-000000000001',
    createdAt: '2026-12-02T10:00:10.000Z',
    mode,
    provider: live ? 'claude' : 'mock',
    model: live ? 'claude-opus-5-5' : 'mock-model',
    contractVersion: '1.1',
    components: {
      adapterPackage: '@nuzm/adapter-model',
      harness: 'p3-s01-live-executor/1',
      node: 'v22',
    },
    approvals: {
      ref: live ? 'APPR-1' : 'twin-synthetic',
      approvedBy: live ? 'owner' : 'twin',
      decisions: REQUIRED_PROVIDER_DECISIONS.map((decision) => ({
        decision,
        ref: `REF-${decision}`,
      })),
    },
    cap: { currency: 'USD', hardMaxNano: '314960000', spentNano: '0', overran: false },
    listPrice: { inputPerMillion: '4', outputPerMillion: '20', currency: 'USD' },
    inputsSha256: 'a'.repeat(64),
    records: [record('A', mode), record('B', mode), record('C', mode)],
    claims: [
      {
        claim: 'the key and host are valid',
        label: live ? 'LIVE-VERIFIED' : 'SIMULATED',
        basis: 'track A',
      },
      // a live envelope honestly carries claims that stay simulated or unverified
      {
        claim: 'retry and circuit breaker against the real vendor',
        label: 'SIMULATED',
        basis: 'faults can only be injected on our side',
      },
      { claim: 'model quality', label: 'NOT VERIFIED', basis: 'a benchmark question' },
    ],
    leakCheck: { performed: true, findings: 0 },
    verdict: live ? 'LIVE-VERIFIED' : 'SIMULATED',
    contentPolicy: 'no key, prompt, completion, tool argument or vendor message is recorded',
  };
  over(e);
  return seal(e);
}
const name = (e: Loose) => `2026-12-02-${e.mode === 'live' ? '' : 'sim-'}${e.id}.json`;
const check = (e: Loose, approvals = approvedAll, fileName: string | null = name(e)) =>
  verifyProviderEnvelope(e, { fileName, approvals });
const rules = (e: Loose, approvals = approvedAll) => [
  ...new Set(check(e, approvals).problems.map((p) => p.rule)),
];

describe('native provider envelope: acceptance', () => {
  it('a consistent live envelope is accepted, although it honestly carries SIMULATED and NOT VERIFIED claims (they are never counted as live)', () => {
    const r = check(envelope('live'));
    expect(r.problems).toEqual([]);
    expect(r.derived.map((d) => [d.track, d.label, d.result])).toEqual([
      ['provider', 'LIVE-VERIFIED', 'PASS'],
      ['tool-calling', 'LIVE-VERIFIED', 'PASS'],
      ['codegen', 'LIVE-VERIFIED', 'PASS'],
    ]);
    // the derived live records carry ONLY live claims and real components: no simulated marker anywhere
    for (const d of r.derived) {
      expect(JSON.stringify(d)).not.toMatch(/SIMULATED|simulated/);
      expect(d.approvals.map((a) => a.id)).toEqual(REQUIRED_PROVIDER_DECISIONS);
    }
  });
  it('a consistent mock envelope is accepted and derives SIMULATED records only', () => {
    const r = check(envelope('mock'), none);
    expect(r.problems).toEqual([]);
    expect(r.derived.every((d) => d.label === 'SIMULATED' && d.approvals.length === 0)).toBe(true);
  });
  it('the matrix: derived LIVE records make the provider rows PASS; derived SIMULATED records never do', () => {
    const live = buildMatrix(check(envelope('live')).derived, approvedAll);
    expect(live.cells.find((c) => c.req.id === 'T1.model')!.status).toBe('PASS');
    expect(live.cells.find((c) => c.req.id === 'T3.codegen')!.status).toBe('PASS');
    const sim = buildMatrix(check(envelope('mock'), none).derived, none);
    expect(sim.cells.find((c) => c.req.id === 'T1.model')!.status).toBe('BLOCKED');
    expect(sim.cells.find((c) => c.req.id === 'T1.model')!.simulated.length).toBe(1);
  });
});

describe('native provider envelope: rejections (each mutation proves one rule)', () => {
  it('mixed labels: a mock run claiming LIVE-VERIFIED, a mock record inside a live envelope, a live record inside a mock envelope', () => {
    expect(
      rules(
        envelope('mock', (e) => (e.verdict = 'LIVE-VERIFIED')),
        none,
      ),
    ).toContain('mixed-labels');
    expect(
      rules(
        envelope('mock', (e) => (e.claims[0].label = 'LIVE-VERIFIED')),
        none,
      ),
    ).toContain('mixed-labels');
    expect(rules(envelope('live', (e) => (e.records[1].mode = 'mock')))).toContain('mixed-labels');
    expect(
      rules(
        envelope('mock', (e) => (e.records[0].mode = 'live')),
        none,
      ),
    ).toContain('mixed-labels');
    expect(rules(envelope('live', (e) => (e.records[0].verdict = 'SIMULATED')))).toContain(
      'mixed-labels',
    );
    expect(rules(envelope('live', (e) => (e.claims[0].label = 'FAIL')))).toContain('mixed-labels');
  });
  it('live requirements: twin approval, overran cap, a track not run, missing or unrecorded decisions, a stand-in model name', () => {
    expect(rules(envelope('live', (e) => (e.approvals.ref = 'twin-synthetic')))).toContain('live');
    expect(rules(envelope('live', (e) => (e.cap.overran = true)))).toContain('live');
    const r = envelope('live');
    r.tracks[0].status = 'not_run';
    expect(rules(r)).toContain('live');
    expect(
      rules(
        envelope(
          'live',
          (e) =>
            (e.approvals.decisions = e.approvals.decisions.filter(
              (d: Loose) => d.decision !== 'D9',
            )),
        ),
      ),
    ).toContain('live');
    expect(rules(envelope('live', (e) => (e.approvals.decisions[0].ref = 'n/a')))).toContain(
      'live',
    );
    // the owner's decision log does not record them: self-claimed approvals do not count
    expect(rules(envelope('live'), none)).toContain('live');
    expect(rules(envelope('live', (e) => (e.model = 'mock-model-3')))).toContain('live');
  });
  it('hashes: an edited record, a wrong outputs hash, a wrong cost sum', () => {
    const e = envelope('live');
    e.records[0].totals.tokensIn = 999999; // edited after sealing
    expect(rules(e)).toContain('content-hash');
    const e2 = envelope('live');
    e2.outputsSha256 = 'b'.repeat(64);
    expect(rules(e2)).toContain('content-hash');
    const e3 = envelope('live');
    e3.cap.spentNano = '1';
    expect(rules(e3)).toContain('cost');
  });
  it('the leak check must have been performed with 0 findings', () => {
    expect(rules(envelope('live', (e) => (e.leakCheck.findings = 1)))).toContain('leak-check');
    expect(rules(envelope('live', (e) => delete e.leakCheck))).toContain('leak-check');
  });
  it('a key-shaped value anywhere is refused and not echoed', () => {
    const secret = ['sk-ant-', 'B'.repeat(30)].join('');
    const r = check(envelope('live', (e) => (e.claims[0].basis = secret)));
    expect(r.problems.some((p) => p.rule === 'secret')).toBe(true);
    expect(JSON.stringify(r.problems)).not.toContain(secret);
  });
  it('file name rules: sim- prefix exactly for non-live, id and date agree', () => {
    const e = envelope('live');
    expect(
      check(e, approvedAll, `2026-12-02-sim-${e.id}.json`).problems.map((p) => p.rule),
    ).toContain('placement');
    const m = envelope('mock');
    expect(check(m, none, `2026-12-02-${m.id}.json`).problems.map((p) => p.rule)).toContain(
      'placement',
    );
    expect(check(e, approvedAll, `2026-12-03-${e.id}.json`).problems.map((p) => p.rule)).toContain(
      'placement',
    );
    expect(check(e, approvedAll, `2026-12-02-other.json`).problems.map((p) => p.rule)).toContain(
      'placement',
    );
  });
  it('a failed check in a live run is never LIVE-VERIFIED: the derived record is FAIL with its blocker', () => {
    const e = envelope('live', (x) => {
      x.records[1] = record('B', 'live', false);
      x.verdict = 'FAIL';
    });
    const r = check(e);
    expect(r.problems).toEqual([]);
    const b = r.derived.find((d) => d.track === 'tool-calling')!;
    expect([b.label, b.result]).toEqual(['NOT VERIFIED', 'FAIL']);
    expect(b.blockers[0]!.text).toContain('tool_calling');
    expect(
      buildMatrix(r.derived, approvedAll).cells.find((c) => c.req.id === 'T2.runtime')!.status,
    ).not.toBe('PASS');
  });
  it('a file that is not this envelope is refused', () => {
    expect(
      verifyProviderEnvelope({ schema: 'something-else' }, { fileName: null, approvals: none }).ok,
    ).toBe(false);
    expect(verifyProviderEnvelope(null, { fileName: null, approvals: none }).ok).toBe(false);
  });
});

describe('directory verification dispatches native envelopes', () => {
  it('a native envelope under provider/ is accepted by verifyAll and its derived records reach the matrix; elsewhere it is refused; a bad one is refused and derives nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'p3s08-native-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
      mkdirSync(join(root, 'docs/phase3/EVIDENCE'), { recursive: true });
      cpSync(join(evidenceDir(repoRoot()), 'schemas'), join(root, 'docs/phase3/EVIDENCE/schemas'), {
        recursive: true,
      });
      const put = (dir: string, file: string, e: unknown) => {
        mkdirSync(join(root, 'docs/phase3/EVIDENCE', dir), { recursive: true });
        writeFileSync(join(root, 'docs/phase3/EVIDENCE', dir, file), JSON.stringify(e));
      };
      const good = envelope('live');
      put('provider', name(good), good);
      const bad = envelope('live', (e) => {
        e.id = '0193a000-0000-7000-8000-000000000002';
        e.leakCheck.findings = 2;
      });
      put('provider', name(bad), bad);
      const wrongDir = envelope('mock');
      put('codegen', name(wrongDir), wrongDir);
      const v = verifyAll(root, undefined, { approvals: approvedAll });
      const by = Object.fromEntries(v.results.map((r) => [r.file, r]));
      expect(by[`provider/${name(good)}`]!.ok).toBe(true);
      expect(by[`provider/${name(bad)}`]!.ok).toBe(false);
      expect(by[`codegen/${name(wrongDir)}`]!.ok).toBe(false);
      expect(v.accepted.map((r) => r.track).sort()).toEqual([
        'codegen',
        'provider',
        'tool-calling',
      ]);
      expect(v.accepted.every((r) => r.label === 'LIVE-VERIFIED')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
