import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockTarget,
  createSimulatedNodeTarget,
  runPortConformance,
  type ConformanceTarget,
} from './conformance';
import { SYNTHETIC_FIXTURES } from './fixtures';
import { checkWorkspaceFiles } from '../env-guard';
import { scanForSecrets } from '../../secret-scan';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('port conformance suite (S-AG6 phase 2): the same assertions, simulated targets today', () => {
  it('MockExecutionPort passes every case it can exercise and skips (never passes) the rest', async () => {
    const r = await runPortConformance(createMockTarget());
    expect(r.fail, JSON.stringify(r.results.filter((x) => x.status === 'FAIL'))).toBe(0);
    expect(r.target).toEqual({ name: 'MockExecutionPort', origin: 'MOCK', label: 'SIMULATED' });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.isolationEvidence).toBe(false);
    expect(r.results.filter((x) => x.status === 'SKIPPED').every((x) => x.note.length > 10)).toBe(
      true,
    );
    expect(r.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the real-runtime port over the simulated node passes every case, SIMULATED, and is not isolation evidence', async () => {
    const r = await runPortConformance(
      createSimulatedNodeTarget({
        pump: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
      }),
    );
    expect(r.fail, JSON.stringify(r.results.filter((x) => x.status === 'FAIL'))).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.pass).toBe(r.total);
    expect(r.target.label).toBe('SIMULATED');
    expect(r.isolationEvidence).toBe(false);
    expect(r.total).toBe(6 + SYNTHETIC_FIXTURES.length);
  });
  it('the report digest is deterministic for the same results', async () => {
    const a = await runPortConformance(createMockTarget());
    const b = await runPortConformance(createMockTarget());
    expect(a.reportSha256).toBe(b.reportSha256);
  });
  it('detects a port that is wrong: a target that never enforces approval fails CP-3', async () => {
    const t = createMockTarget();
    const bad: ConformanceTarget = {
      ...t,
      async portFor(ctx, f) {
        const p = await t.portFor(ctx, f);
        const run = p.run.bind(p);
        p.run = (d, c) => run(d, { ...c, approvalId: 'forged' });
        return p;
      },
    };
    const r = await runPortConformance(bad);
    expect(r.results.find((x) => x.id === 'CP-3')?.status).toBe('FAIL');
    expect(r.fail).toBeGreaterThan(0);
  });
  it('detects a leaking target and a lying origin', async () => {
    const t = createMockTarget();
    const leak = await runPortConformance({ ...t, leftovers: async () => ['ws-1'] });
    expect(leak.results.find((x) => x.id === 'FX-OK-TYPECHECK')?.status).toBe('FAIL');
    const lie = await runPortConformance({ ...t, origin: 'REAL' });
    expect(lie.results.find((x) => x.id === 'CP-6')?.status).toBe('FAIL');
    expect(lie.isolationEvidence).toBe(false);
  });
});

describe('synthetic fixtures are safe text', () => {
  it('have unique ids, bounded size, no hostnames, no secrets, no traversal', () => {
    const ids = new Set(SYNTHETIC_FIXTURES.map((f) => f.id));
    expect(ids.size).toBe(SYNTHETIC_FIXTURES.length);
    for (const f of SYNTHETIC_FIXTURES) {
      const files = f.files();
      let bytes = 0;
      for (const [p, c] of Object.entries(files)) {
        bytes += Buffer.byteLength(c);
        expect(p.startsWith('/') || p.split('/').includes('..'), `${f.id}:${p}`).toBe(false);
        expect(
          /https?:\/\/(?!registry\.npmjs\.org|mirror\.invalid|example\.invalid)/.test(c),
          `${f.id}:${p} names a host`,
        ).toBe(false);
        expect(
          /rm\s+-rf|mkfs|curl |wget |:\(\)\s*\{/.test(c),
          `${f.id}:${p} dangerous command text`,
        ).toBe(false);
        expect(scanForSecrets(c, []).length, `${f.id}:${p} looks like a secret`).toBe(0);
      }
      expect(bytes).toBeLessThan(8_000);
    }
  });
  it('seed screening refuses exactly the workspace-layer fixtures and passes the rest', () => {
    for (const f of SYNTHETIC_FIXTURES) {
      const r = checkWorkspaceFiles(
        Object.entries(f.files()).map(([path, content]) => ({ path, content })),
        [],
      );
      expect(r.ok, f.id).toBe(f.layer !== 'workspace');
    }
  });
  it('every refusal fixture names its reason and every ran fixture states a status', () => {
    for (const f of SYNTHETIC_FIXTURES) {
      if (f.expect.kind === 'refused') expect(f.expect.reason).toMatch(/^[a-z_]+$/);
      else expect(f.expect.status.length).toBeGreaterThan(0);
    }
  });
});
