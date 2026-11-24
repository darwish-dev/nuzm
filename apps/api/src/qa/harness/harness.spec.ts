import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registryOf, type RecordedApproval } from '../evidence/approvals';
import { EXTERNAL_BLOCKERS, REQUIREMENTS } from '../evidence/matrix';
import { SIMULATED_DRIVERS, type Driver, type DriverMap, type DriverOutput } from './drivers';
import { blockersOf, runHarness } from './runner';
import { SCENARIOS, byId, isOfflineOnly, type Scenario } from './scenarios';

/**
 * P3-S08 harness: stops at the first missing approval with the exact blocker, never falls back to a simulated result in live mode, resumes, and never keeps a record the
 * evidence verifier rejects. Fake drivers stand in for other sessions' entry points; the real simulated drivers are exercised for two scenarios (the rest run in the CLI).
 */
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'p3s08-h-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const approved = (...ids: string[]) =>
  registryOf(
    ids.map((id): RecordedApproval => ({
      id,
      decision: 'x',
      reference: `REF-${id}`,
      date: '2026-12-01',
      by: 'owner',
    })),
  );
const sc = (id: string, over: Partial<Scenario> = {}): Scenario => ({
  id,
  title: id,
  track: 'codegen',
  targets: ['T3'],
  approvals: ['D9'],
  external: [],
  after: [],
  owner: 'test',
  entry: 'test entry',
  maxCostMicroUsd: 1000,
  ...over,
});
const liveOut = (over: Partial<DriverOutput> = {}): DriverOutput => ({
  result: 'PASS',
  checks: [{ id: 'c1', result: 'PASS' }],
  components: [{ name: 'real-entry', version: '1', origin: 'real' }],
  details: {
    track: 'C',
    model: 'claude-opus-5-5',
    briefId: 'b',
    usage: { requests: 1, tokensIn: 1, tokensOut: 1 },
    files: 2,
    filesTreeSha256: 'a'.repeat(64),
    passedChecks: ['codegen_slugify'],
    keyLeakScan: 'clean',
  },
  outputs: [{ name: 'o', sha256: 'b'.repeat(64) }],
  identity: { model: { provider: 'anthropic', id: 'claude-opus-5-5' } },
  durationMs: 1234,
  usedMicroUsd: 10,
  ...over,
});
const base = {
  root: undefined as string | undefined,
  commit: 'abcdef1234567',
  now: () => new Date('2026-12-01T10:00:00Z'),
};

describe('scenario list', () => {
  it('has unique ids, known predecessors that come earlier, a simulated driver each, and matrix-consistent approvals', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    SCENARIOS.forEach((s, i) => {
      for (const a of s.after)
        expect(ids.indexOf(a), `${s.id} after ${a}`).toBeGreaterThanOrEqual(0);
      for (const a of s.after) expect(ids.indexOf(a)).toBeLessThan(i);
      for (const k of s.external)
        expect(EXTERNAL_BLOCKERS[k], `${s.id} external ${k}`).toBeTruthy();
      expect(SIMULATED_DRIVERS[s.id], `${s.id} has a simulated driver`).toBeTruthy();
    });
  });
  it('covers every real matrix row: each live track a requirement needs has a scenario with the same track', () => {
    const tracks = new Set(SCENARIOS.map((s) => s.track));
    for (const r of REQUIREMENTS) expect(tracks.has(r.track), `${r.id} -> ${r.track}`).toBe(true);
  });
  it('the five Phase 2 synthetic projects are present and offline only', () => {
    expect(SCENARIOS.filter(isOfflineOnly).map((s) => s.id)).toEqual([
      'S01-synthetic-business-website',
      'S02-synthetic-ecommerce',
      'S03-synthetic-fullstack',
      'S04-synthetic-crm',
      'S05-synthetic-flutter',
    ]);
  });
});

describe('live mode stops at the first missing approval with the exact blocker', () => {
  it('calls no driver, writes no evidence record, and names every missing approval', async () => {
    const live = vi.fn();
    const sim = vi.fn();
    const out = tmp();
    const r = await runHarness({
      ...base,
      mode: 'live',
      outDir: out,
      approvals: approved(),
      scenarios: [sc('AA1'), sc('AA2', { after: ['AA1'] })],
      live: { AA1: { run: live }, AA2: { run: live } },
      simulated: { AA1: { run: sim }, AA2: { run: sim } },
    });
    expect(live).not.toHaveBeenCalled();
    expect(sim).not.toHaveBeenCalled(); // no fallback to a simulated result
    expect(r.exitCode).toBe(3);
    expect(r.stoppedAt).toEqual({
      id: 'AA1',
      blocker: expect.stringContaining('approvals not recorded: D9'),
    });
    expect(r.outcomes.map((o) => o.id)).toEqual(['AA1']); // AA2 was never reached
    expect(readdirSync(out)).toEqual(['state.json']);
  });
  it('a scenario with approvals but no registered live driver stops and says so', () => {
    const b = blockersOf(sc('AA1'), approved('D9'), new Set(), {});
    expect(b).toHaveLength(1);
    expect(b[0]).toContain('no live driver is registered for AA1');
  });
  it('an unmet external fact and an unmet predecessor are blockers too', () => {
    const b = blockersOf(
      sc('AA2', { external: ['B-iOS-XCODE'], after: ['AA1'] }),
      approved('D9'),
      new Set(),
      { AA2: { run: vi.fn() } },
    );
    expect(b.join(' | ')).toContain('no macOS host with full Xcode');
    expect(b.join(' | ')).toContain('needs LIVE-VERIFIED evidence first from: AA1');
  });
  it('the real scenario list stops at its first scenario today (nothing is recorded by the owner)', async () => {
    const out = tmp();
    const r = await runHarness({
      mode: 'live',
      outDir: out,
      approvals: approved(),
      commit: base.commit,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stoppedAt?.id).toBe('P01-provider-connection');
    expect(r.stoppedAt?.blocker).toContain('D2, D5, D6, D4, D3, D9');
    expect(r.outcomes.filter((o) => o.status === 'stopped')).toHaveLength(1);
  });
});

describe('live mode with approvals and a registered driver', () => {
  it('runs in order, writes a verified LIVE-VERIFIED record with the owner references, and unlocks the dependent scenario', async () => {
    const out = tmp();
    const calls: string[] = [];
    const d = (id: string): Driver => ({ run: async () => (calls.push(id), liveOut()) });
    const r = await runHarness({
      ...base,
      mode: 'live',
      outDir: out,
      approvals: approved('D9'),
      scenarios: [
        sc('AA1'),
        sc('AA2', { after: ['AA1'] }),
        sc('S01-synthetic-x', { approvals: [] }),
      ],
      live: { AA1: d('AA1'), AA2: d('AA2') },
    });
    expect(calls).toEqual(['AA1', 'AA2']);
    expect(r.exitCode).toBe(0);
    expect(r.outcomes.map((o) => o.status)).toEqual(['ran', 'ran', 'skipped-offline-only']);
    const rec = JSON.parse(readFileSync(join(out, 'codegen/2026-12-01-aa1.json'), 'utf8'));
    expect(rec.label).toBe('LIVE-VERIFIED');
    expect(rec.approvals).toEqual([
      { id: 'D9', ref: 'REF-D9', recordedIn: 'docs/parallel/OWNER-APPROVAL-PACK.md#6' },
    ]);
  });
  it('a live driver whose output looks like a stand-in is rejected by the verifier and NO record is written', async () => {
    const out = tmp();
    const r = await runHarness({
      ...base,
      mode: 'live',
      outDir: out,
      approvals: approved('D9'),
      scenarios: [sc('AA1')],
      live: {
        AA1: {
          run: async () =>
            liveOut({ identity: { model: { provider: 'anthropic', id: 'mock-model' } } }),
        },
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]!.problems?.join(' ')).toContain('[live]');
    expect(existsSync(join(out, 'codegen'))).toBe(false);
  });
  it('a live driver that mixes a simulated component is rejected', async () => {
    const out = tmp();
    const r = await runHarness({
      ...base,
      mode: 'live',
      outDir: out,
      approvals: approved('D9'),
      scenarios: [sc('AA1')],
      live: {
        AA1: {
          run: async () =>
            liveOut({ components: [{ name: 'gateway', version: '1', origin: 'simulated' }] }),
        },
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]!.problems?.join(' ')).toContain('mixed-labels');
  });
  it('a cost above the scenario maximum is rejected', async () => {
    const out = tmp();
    const r = await runHarness({
      ...base,
      mode: 'live',
      outDir: out,
      approvals: approved('D9'),
      scenarios: [sc('AA1')],
      live: { AA1: { run: async () => liveOut({ usedMicroUsd: 1001 }) } },
    });
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]!.problems?.join(' ')).toContain('cost');
  });
});

describe('simulated mode', () => {
  it('labels every record SIMULATED (or NOT VERIFIED when only planned), never LIVE-VERIFIED, and the records verify', async () => {
    const out = tmp();
    const calls: string[] = [];
    const sim: DriverMap = {
      AA1: {
        run: async () => (
          calls.push('AA1'),
          {
            ...liveOut(),
            identity: undefined,
            components: [{ name: 'twin', version: '1', origin: 'simulated' }],
          }
        ),
      },
      AA2: {
        run: async () => ({
          result: 'NOT_VERIFIED',
          checks: [{ id: 'e', result: 'NOT_VERIFIED' }],
          components: [{ name: 'x', version: '1', origin: 'offline' }],
          details: { planned: true },
          blockers: [{ id: 'b', text: 'not wired' }],
        }),
      },
    };
    const r = await runHarness({
      ...base,
      mode: 'simulated',
      outDir: out,
      approvals: approved(),
      scenarios: [sc('AA1'), sc('AA2', { id: 'AA2' })],
      simulated: sim,
    });
    expect(r.outcomes.flatMap((o) => o.problems ?? [])).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.outcomes.map((o) => o.label)).toEqual(['SIMULATED', 'NOT VERIFIED']);
    const rec = JSON.parse(readFileSync(join(out, 'codegen/2026-12-01-aa1.json'), 'utf8'));
    expect(rec.approvals).toEqual([]);
    expect(JSON.stringify(rec)).not.toContain('LIVE-VERIFIED');
  });
  it('is resumable: a finished scenario is not run again while its record is intact, and is re-run if the record is altered', async () => {
    const out = tmp();
    const run = vi.fn(async () => ({
      ...liveOut(),
      identity: undefined,
      components: [{ name: 'twin', version: '1', origin: 'simulated' as const }],
    }));
    const o = {
      ...base,
      mode: 'simulated' as const,
      outDir: out,
      approvals: approved(),
      scenarios: [sc('AA1')],
      simulated: { AA1: { run } },
    };
    await runHarness(o);
    expect((await runHarness(o)).outcomes[0]!.status).toBe('resumed');
    expect(run).toHaveBeenCalledTimes(1);
    const f = join(out, 'codegen/2026-12-01-aa1.json');
    writeFileSyncAlter(f);
    expect((await runHarness(o)).outcomes[0]!.status).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('the real simulated drivers: provider twin track A and a synthetic lifecycle project produce verified SIMULATED records', async () => {
    const out = tmp();
    const r = await runHarness({
      ...base,
      mode: 'simulated',
      outDir: out,
      approvals: approved(),
      only: ['P01-provider-connection', 'S01-synthetic-business-website'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.outcomes.map((o) => [o.id, o.label, o.result])).toEqual([
      ['P01-provider-connection', 'SIMULATED', 'PASS'],
      ['S01-synthetic-business-website', 'SIMULATED', 'PASS'],
    ]);
    expect(byId('P01-provider-connection')!.approvals).toContain('D9');
  }, 120_000);
});

function writeFileSyncAlter(f: string) {
  const o = JSON.parse(readFileSync(f, 'utf8'));
  o.cost.usedMinor = '1';
  writeFileSync(f, JSON.stringify(o));
}
