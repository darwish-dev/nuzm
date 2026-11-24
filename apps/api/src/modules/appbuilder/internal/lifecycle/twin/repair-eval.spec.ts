import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builderTools, dataFence } from '@nuzm/domain';
import { describe, expect, it, vi } from 'vitest';

// a real compile per round is slow on a loaded machine
vi.setConfig({ testTimeout: 240_000 });
import { TWIN_VERSION, typecheckProject } from './ts-compiler-twin';

const A = builderTools;
const recorded = (id: string) => A.RECORDED_LOGS.find((r) => r.id === id)!;
const sortLines = (s: string) => s.trim().split('\n').sort().join('\n');

/** the offline repair evaluation (P3-S03): the corpus projects, the REAL TypeScript compiler as the verifier (in memory), the engine as the strategy, a SCRIPTED model */
const tsVerifier: builderTools.Verifier = {
  name: `typescript-in-memory (${TWIN_VERSION}, real compiler, nothing executed)`,
  verify: async (f) => {
    const r = typecheckProject(f);
    return { passed: r.passed, log: r.log };
  },
};
const predicateVerifier = (c: builderTools.CorpusCase): builderTools.Verifier => ({
  name: 'static-predicate (SIMULATED: no code executed)',
  verify: async (f) =>
    c.check!(f)
      ? { passed: true, log: '' }
      : { passed: false, log: recorded('vitest/test-assertion').log },
});
const strategyFor = (c: builderTools.CorpusCase) => {
  let asks = 0;
  const s = new A.AutoRepairStrategy({
    fence: dataFence(),
    complete: async () => {
      asks += 1;
      if (!c.modelReply)
        throw new Error('the engine asked a model for a case that must be deterministic');
      return JSON.stringify(c.modelReply);
    },
  });
  return { s, asks: () => asks };
};

describe('the corpus fails for real, exactly as the recorded tool output says', () => {
  for (const c of A.CORPUS.filter((x) => x.verifier === 'ts'))
    it(`${c.id}: the twin's compiler output equals the recorded tsc CLI output`, () => {
      const r = typecheckProject(new Map(Object.entries(c.files)));
      expect(r.passed).toBe(false);
      expect(sortLines(r.log)).toBe(sortLines(recorded(`tsc/${c.id}`).log));
    });
});

describe('offline repair evaluation: real compiler verifier, scripted model', () => {
  const results: builderTools.CaseResult[] = [];
  for (const c of A.CORPUS)
    it(`${c.id}: ${c.title}`, async () => {
      const { s, asks } = strategyFor(c);
      const r = await A.runRepairCase(
        c,
        c.verifier === 'ts' ? tsVerifier : predicateVerifier(c),
        s,
        {
          strategyKind: 'engine+scripted-model',
          origin: 'TWIN',
          maxRounds: 3,
        },
      );
      results.push(r);
      expect(r.classesAsExpected, `first failure classes: ${r.firstClasses.join(',')}`).toBe(true);
      expect(r.green, JSON.stringify(r.rounds)).toBe(true);
      expect(r.rounds.length).toBeLessThanOrEqual(3);
      if (c.deterministic) {
        expect(asks(), 'a mechanical case needs no model').toBe(0);
        expect(r.rounds.every((x) => x.strategy.startsWith('deterministic:'))).toBe(true);
      } else {
        expect(asks()).toBeGreaterThan(0);
      }
      // the repaired project still obeys the guards: nothing was deleted, no test was weakened
      expect(
        builderTools.checkIntegrity(
          new Map(Object.entries(c.files)),
          [...r.files]
            .filter(([p, t]) => t !== c.files[p])
            .map(([p, t]) => ({ op: 'modify' as const, path: p, content: t })),
        ),
      ).toEqual([]);
    });

  it('the two-class case is solved in two rounds: the import mechanically, the type error by the model', async () => {
    const c = A.CORPUS.find((x) => x.id === 'ts-two-classes')!;
    const { s } = strategyFor(c);
    const r = await A.runRepairCase(c, tsVerifier, s, {
      strategyKind: 'engine+scripted-model',
      origin: 'TWIN',
    });
    expect(r.rounds.map((x) => x.strategy)).toEqual(['deterministic:add_missing_import', 'model']);
    expect(r.rounds[0]!.outcome).toBe('partial');
    expect(r.rounds[1]!.outcome).toBe('resolved');
  });

  it('aggregates per error class and (with P3S03_EVAL_WRITE=1) writes the evidence file', () => {
    expect(results.length).toBe(A.CORPUS.length);
    const tsOnly = results.filter((r) => r.verifier.startsWith('typescript'));
    const agg = A.aggregate(tsOnly);
    expect(agg).toMatchObject({ cases: 10, green: 10, greenRateBp: 10000 });
    const classes = Object.keys(agg.byClass);
    expect(classes.length).toBeGreaterThanOrEqual(8);
    for (const k of classes) expect(agg.byClass[k]!.rateBp).toBe(10000);
    const predicate = A.aggregate(results.filter((r) => r.verifier.startsWith('static-predicate')));
    if (process.env.P3S03_EVAL_WRITE === '1') {
      const file = resolve(
        __dirname,
        '../../../../../../../../docs/phase3/EVIDENCE/repair-offline/2026-11-24-offline-eval.json',
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            schema: 'nuzm.repair-offline-eval/1',
            session: 'P3-S03',
            claim: 'SIMULATED',
            label:
              'SIMULATED: the model is a scripted stand-in (developer-written replies); the verifier for typescript cases is the REAL TypeScript compiler run in memory (no runtime, nothing executed). This measures the repair ENGINE (diagnosis, class routing, deterministic fixers, guards, rounds, bookkeeping), not model quality and not a real build.',
            components: {
              compiler: TWIN_VERSION,
              recordedTools: [...new Set(A.RECORDED_LOGS.map((r) => r.version))],
              model: 'scripted (none called)',
              runtime: 'none (in-memory compile twin, origin MOCK)',
            },
            typescriptCases: agg,
            predicateCases: {
              ...predicate,
              note: 'verified by a static predicate: not a build, not a test run',
            },
            cases: results.map((r) => ({
              id: r.id,
              verifier: r.verifier,
              firstClasses: r.firstClasses,
              green: r.green,
              stop: r.stop,
              rounds: r.rounds.map((x) => ({
                round: x.round,
                strategy: x.strategy,
                before: x.before,
                after: x.after,
                outcome: x.outcome,
                asks: x.asks,
                refused: x.refused,
              })),
            })),
          },
          null,
          2,
        )}\n`,
      );
    }
  });
});

describe('what the guards do inside the loop', () => {
  it('a model that tries to pass the failing test by skipping it is refused, asked again, and the honest fix goes green', async () => {
    const c = A.CORPUS.find((x) => x.id === 'test-assertion')!;
    const replies = [JSON.stringify(A.CHEATING_REPLY), JSON.stringify(c.modelReply)];
    let n = 0;
    const s = new A.AutoRepairStrategy({
      fence: dataFence(),
      complete: async () => replies[Math.min(n++, 1)]!,
    });
    const r = await A.runRepairCase(c, predicateVerifier(c), s, {
      strategyKind: 'engine+scripted-model',
      origin: 'TWIN',
    });
    expect(r.green).toBe(true);
    expect(r.rounds[0]!.refused).toContain('test_skipped');
    expect(r.rounds[0]!.asks).toBe(2);
    expect(r.files.get('src/discount.test.ts')).toBe(c.files['src/discount.test.ts']); // the test is untouched
  });
  it('a model that never fixes the problem stops the loop (round limit or no progress), never green', async () => {
    const c = A.CORPUS.find((x) => x.id === 'ts-type-mismatch')!;
    const nop = JSON.stringify({
      summary: 'x',
      patches: [
        { op: 'modify', path: 'src/price.ts', content: `${c.files['src/price.ts']}// touched\n` },
      ],
    });
    let k = 0;
    const s = new A.AutoRepairStrategy({
      fence: dataFence(),
      complete: async () => nop.replace('touched', `touched ${k++}`),
    });
    const r = await A.runRepairCase(c, tsVerifier, s, {
      strategyKind: 'engine+scripted-model',
      origin: 'TWIN',
      maxRounds: 3,
    });
    expect(r.green).toBe(false);
    expect(['round_limit', 'no_progress']).toContain(r.stop);
  });
});
