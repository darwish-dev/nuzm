import { builderTools, dataFence } from '@nuzm/domain';
import { describe, expect, it, vi } from 'vitest';

// a real compile per build is slow on a loaded machine
vi.setConfig({ testTimeout: 240_000 });
import type { FileGenerator } from '../lifecycle.types';
import { LifecycleRunner } from '../lifecycle.runner';
import { MemoryEnv, MemoryHost } from '../lifecycle.testing';
import { TypeScriptTwinBuildPort } from './ts-compiler-twin';

const T = builderTools;

/**
 * The repair engine inside the REAL lifecycle runner (P3-S03, acceptance L2 offline): a deliberately broken synthetic project (a missing import, a type error, a failing test) is
 * detected by the real TypeScript compiler (twin) and a static test predicate, repaired round by round through the validated change pipeline of the in-memory environment, and
 * rebuilt green within the repair limit. Every label is honest: the model is a scripted stand-in, the build port is the in-memory compiler (origin MOCK), the test run is a predicate.
 */
const BROKEN: Record<string, string> = {
  'tsconfig.json': T.TSCONFIG,
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "version": "0.0.0"\n}\n',
  // the globals of the test runner, as a project that uses one would declare them
  'src/test-globals.d.ts':
    'declare function test(name: string, fn: () => void): void;\ndeclare function expect(v: unknown): { toBe(x: unknown): void };\n',
  'src/format.ts':
    'export function formatMoney(minor: number): string {\n  return (minor / 100).toFixed(2);\n}\n',
  'src/cart.ts': 'export function show(minor: number): string {\n  return formatMoney(minor);\n}\n',
  'src/count.ts': "export const items: number = 'three';\n",
  'src/discount.ts':
    'export function applyDiscount(price: number, percent: number): number {\n  return price - percent;\n}\n',
  'src/discount.test.ts':
    "import { applyDiscount } from './discount';\n\ntest('applies a percentage discount', () => {\n  expect(applyDiscount(100, 10)).toBe(90);\n});\n",
};
const TEST_LOG =
  ' FAIL  src/discount.test.ts > applies a percentage discount\nAssertionError: expected 90 to be 90 // Object.is equality\n ❯ src/discount.test.ts:4:34\n';
const testsPass = (f: ReadonlyMap<string, string>) =>
  /\/\s*100/.test(f.get('src/discount.ts') ?? '')
    ? { passed: true, log: '' }
    : { passed: false, log: TEST_LOG.replace('expected 90 to be 90', 'expected 80 to be 90') };

/** a generator that ignores the placeholder plan and brings the broken project (the first task only), as a model-written first draft would */
const draftGenerator = (): FileGenerator => {
  let first = true;
  return {
    kind: 'model',
    async generate(_i, current) {
      if (!first) return { ops: [] };
      first = false;
      return {
        ops: Object.entries(BROKEN)
          .filter(([p]) => !current.has(p))
          .map(([path, content]) => ({ op: 'add' as const, path, content })),
        note: 'scripted first draft',
      };
    },
  };
};
const reply = (path: string, content: string, summary = 'fix') =>
  JSON.stringify({ summary, patches: [{ op: 'modify', path, content }] });
const FIX_TYPE = reply('src/count.ts', 'export const items: number = 3;\n');
const FIX_TEST = reply(
  'src/discount.ts',
  'export function applyDiscount(price: number, percent: number): number {\n  return Math.round(price - (price * percent) / 100);\n}\n',
);

function rig(replies: string[], limits: { maxRepairRounds?: number } = {}) {
  const host = new MemoryHost();
  host.input = { prompt: 'A small shop with a cart and discounts', ...limits };
  const env = new MemoryEnv();
  const calls: string[] = [];
  let tokens = 0;
  const engine = new T.AutoRepairStrategy({
    fence: dataFence(),
    complete: async (m) => {
      calls.push(m);
      tokens += 700;
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
  });
  env.generator = draftGenerator();
  env.repair = new T.FirstOf([new T.RuleBasedRepair(), engine]);
  env.repairReport = () => (engine.last ? { ...engine.last } : null);
  env.takeRepairTokens = () => {
    const n = tokens;
    tokens = 0;
    return n;
  };
  env.modelBacked = { file_generation: true, repair: true };
  env.build = new TypeScriptTwinBuildPort(() => env.files, testsPass);
  return { host, env, calls, engine };
}

describe('the repair engine inside the lifecycle (real TypeScript compiler twin, scripted model)', () => {
  it('repairs a missing import, a type error and a failing test in three rounds, each by its own strategy, and finishes parked at the deployment approval', async () => {
    const { host, env, calls } = rig([FIX_TYPE, FIX_TEST]);
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status, JSON.stringify(out.state.failure)).toBe('waiting_approval');
    expect(out.state.repairRound).toBe(3);

    const recs = out.artifacts.repairRecords!;
    expect(recs.map((r) => r.strategy)).toEqual([
      'deterministic:add_missing_import',
      'model',
      'model',
    ]);
    expect(recs.map((r) => r.outcome)).toEqual(['partial', 'resolved', 'resolved']);
    expect(recs.map((r) => r.trigger)).toEqual(['build', 'build', 'tests']);
    // three different error classes were demonstrated
    const classes = new Set(
      recs.flatMap((r) =>
        Object.keys(r.targeted ? Object.fromEntries(r.targeted.map((k) => [k, 1])) : r.before),
      ),
    );
    expect(classes).toEqual(new Set(['undefined_name', 'type_mismatch', 'test_assertion']));
    expect(calls).toHaveLength(2); // the import needed no model

    // the repaired project really compiles and its test predicate passes
    expect(T.TSCONFIG).toContain('strict');
    expect(env.files.get('src/cart.ts')).toContain("import { formatMoney } from './format';");
    expect(env.files.get('src/count.ts')).toBe('export const items: number = 3;\n');
    // the test file was never touched, the repairs are validated changes on the AI path
    expect(env.files.get('src/discount.test.ts')).toBe(BROKEN['src/discount.test.ts']);
    expect(env.applied).toHaveLength(1 + 3);

    // the build log shows what failed and what passed (all MOCK origin: the twin is not the runtime)
    const builds = out.artifacts.builds!;
    expect(builds.every((b) => b.origin === 'MOCK')).toBe(true);
    const rebuilds = builds
      .filter((b) => b.phase === 'rebuild')
      .map((b) => `${b.profile}:${b.status}`);
    expect(rebuilds[0]).toBe('typecheck:failed');
    expect(rebuilds.at(-1)).toBe('build:completed');
    expect(builds.at(-1)).toMatchObject({
      phase: 'tests',
      status: 'completed',
      profile: 'unit-tests',
    });

    // project memory learned the classes (class names only, never error text), in the same change as the repair
    const memory = env.files.get('nuzm.memory.json') ?? '';
    expect(memory).toContain('undefined_name');
    expect(memory).toContain('type_mismatch');
    expect(memory).not.toContain('formatMoney');

    // metrics: per class and per origin, in integer basis points
    const m = T.summarizeRepairs(recs, 'MOCK');
    expect(m).toMatchObject({
      rounds: 3,
      greenAfterRepair: true,
      deterministicRounds: 1,
      modelRounds: 2,
      origin: 'MOCK',
    });
    expect(Object.values(m.byClass).every((c) => c!.rateBp === 10000)).toBe(true);
    // events carry the repair rounds for the screen
    expect(host.events.filter((e) => e.type === 'lifecycle_repair').length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('a second round does not repeat the first: the model is told what was tried and how it ended', async () => {
    const { host, env, calls } = rig([FIX_TYPE, FIX_TEST]);
    await new LifecycleRunner().run(host, env);
    expect(calls[1]).toContain('earlierRounds');
    expect(calls[1]).toContain('"strategy": "model"');
    expect(calls[1]).toContain('"outcome": "resolved"');
  });

  it('stops (no_progress or repair_exhausted) when the model never fixes it, with a record per round', async () => {
    const wrong = (n: number) => reply('src/count.ts', `export const items: number = 'v${n}';\n`);
    const { host, env } = rig([wrong(1), wrong(2), wrong(3)], { maxRepairRounds: 3 });
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('failed');
    // the same failure after a repair means the repair did not help: the loop stops there instead of burning the remaining rounds
    expect(['no_progress', 'repair_exhausted']).toContain(out.state.failure?.code);
    const recs = out.artifacts.repairRecords!;
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs.every((r) => r.outcome !== 'resolved')).toBe(true);
  });

  it('a model that cheats (skips the failing test) is refused and the round records the refusal; the honest answer then goes green', async () => {
    const cheat = reply(
      'src/discount.test.ts',
      BROKEN['src/discount.test.ts']!.replace("test('", "test.skip('"),
    );
    const { host, env } = rig([FIX_TYPE, cheat, FIX_TEST]);
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('waiting_approval');
    const last = out.artifacts.repairRecords!.at(-1)!;
    expect(last.refused).toContain('test_skipped');
    expect(last.asks).toBe(2);
    expect(env.files.get('src/discount.test.ts')).toBe(BROKEN['src/discount.test.ts']);
  });

  it('a model that answers nothing usable ends the round as gave_up, and the run fails with strategy_gave_up (no unchecked change is applied)', async () => {
    const { host, env } = rig(['not json at all']);
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('failed');
    expect(out.state.failure?.code).toBe('strategy_gave_up');
    expect(out.artifacts.repairRecords!.at(-1)).toMatchObject({ outcome: 'gave_up' });
    expect(out.artifacts.repairRecords!.at(-1)!.refused).toContain('invalid_reply');
  });

  it('crash safety: a crash at every checkpoint of a repairing run resumes to the same result, with one record per round', async () => {
    const base = rig([FIX_TYPE, FIX_TEST]);
    await new LifecycleRunner().run(base.host, base.env);
    const n = base.host.saves.length;
    expect(n).toBeGreaterThan(20);
    for (let k = 1; k <= n; k += 3) {
      const r = rig([FIX_TYPE, FIX_TEST]);
      r.host.crashAfterSaves = k;
      await expect(new LifecycleRunner().run(r.host, r.env), `crash at ${k}`).rejects.toThrow(
        'simulated crash',
      );
      r.host.crashAfterSaves = null;
      const out = await new LifecycleRunner().run(r.host, r.env);
      expect(out.status, `crash at ${k}`).toBe('waiting_approval');
      expect(
        out.artifacts.repairRecords!.map((x) => x.round),
        `crash at ${k}`,
      ).toEqual([1, 2, 3]);
      expect(out.artifacts.repairRecords!.at(-1)!.outcome, `crash at ${k}`).toBe('resolved');
    }
  });

  it('the token ceiling stops a repairing run before the model is asked, with budget_exceeded semantics (tokens_exceeded)', async () => {
    const { host, env, calls } = rig([FIX_TYPE, FIX_TEST]);
    host.budget = { maxTokens: 50 };
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('failed');
    expect(out.state.failure?.code).toBe('tokens_exceeded');
    expect(calls).toHaveLength(0);
  });
});
