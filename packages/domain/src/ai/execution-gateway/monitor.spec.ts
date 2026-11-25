import { describe, expect, it } from 'vitest';
import {
  EXEC_PROFILES,
  RuntimeHealthMonitor,
  ResourceMonitor,
  ZERO_USAGE,
  type HealthProbeResult,
} from './index';

const L = EXEC_PROFILES.typecheck!.limits;
let t = 0;
describe('ResourceMonitor', () => {
  it('ok, then warn at 80 %, then kill when a limit is crossed', () => {
    t = 0;
    const m = new ResourceMonitor(() => t);
    m.start('r', L);
    expect(m.observe('r', { ...ZERO_USAGE, memoryMb: 10 })).toEqual({ kind: 'ok' });
    expect(m.observe('r', { ...ZERO_USAGE, memoryMb: L.memoryMb * 0.85 })).toEqual({
      kind: 'warn',
      resources: ['memory'],
    });
    const k = m.observe('r', { ...ZERO_USAGE, memoryMb: L.memoryMb + 1 });
    expect(k).toMatchObject({ kind: 'kill', reason: 'limit' });
  });
  it('output over the cap only warns (it is truncated, not killed)', () => {
    t = 0;
    const m = new ResourceMonitor(() => t);
    m.start('r', L);
    expect(m.observe('r', { ...ZERO_USAGE, outputBytes: L.outputKb * 1024 + 1 })).toEqual({
      kind: 'warn',
      resources: ['output'],
    });
  });
  it('measures wall time itself: a runtime that under-reports wall time cannot extend the run', () => {
    t = 0;
    const m = new ResourceMonitor(() => t);
    m.start('r', L);
    t = (L.wallSeconds + 1) * 1000;
    expect(m.observe('r', { ...ZERO_USAGE, wallMs: 1 })).toMatchObject({
      kind: 'kill',
      reason: 'wall',
    });
  });
  it('kills a silent run and a run past wall time even without samples', () => {
    t = 0;
    const m = new ResourceMonitor(() => t, { warnRatio: 0.8, staleMs: 10_000 });
    m.start('a', L);
    m.start('b', L);
    t = 5_000;
    m.observe('b', ZERO_USAGE);
    t = 12_000;
    expect(m.tick()).toEqual([
      { runId: 'a', action: { kind: 'kill', reason: 'stale', violations: [] } },
    ]);
    m.observe('b', ZERO_USAGE);
    t = (L.wallSeconds + 5) * 1000;
    m.observe('a', ZERO_USAGE);
    expect(m.tick().map((x) => [x.runId, (x.action as { reason: string }).reason])).toEqual([
      ['a', 'wall'],
      ['b', 'wall'],
    ]);
  });
  it('NaN readings from a broken runtime are a kill, and unknown runs are ignored', () => {
    t = 0;
    const m = new ResourceMonitor(() => t);
    m.start('r', L);
    expect(m.observe('r', { ...ZERO_USAGE, pids: NaN })).toMatchObject({
      kind: 'kill',
      reason: 'limit',
    });
    expect(m.observe('nope', ZERO_USAGE)).toEqual({ kind: 'ok' });
  });
  it('tracks the peak and forgets stopped runs', () => {
    t = 0;
    const m = new ResourceMonitor(() => t);
    m.start('r', L);
    m.observe('r', { ...ZERO_USAGE, memoryMb: 100 });
    m.observe('r', { ...ZERO_USAGE, memoryMb: 50 });
    expect(m.peak('r')!.memoryMb).toBe(100);
    expect(m.stop('r')).toBe(true);
    expect(m.active()).toEqual([]);
  });
});

describe('RuntimeHealthMonitor', () => {
  const ok: HealthProbeResult = { ok: true, latencyMs: 20, freeSlots: 3 };
  const bad: HealthProbeResult = {
    ok: false,
    latencyMs: 20,
    freeSlots: 0,
    note: 'socket_unreachable',
  };
  it('unknown -> healthy on the first good probe', () => {
    const h = new RuntimeHealthMonitor();
    expect(h.state).toBe('unknown');
    expect(h.record(ok)).toBe('healthy');
  });
  it('degrades on one failure, becomes unhealthy after three, and needs two good probes to recover', () => {
    const h = new RuntimeHealthMonitor();
    h.record(ok);
    expect(h.record(bad)).toBe('degraded');
    expect(h.record(bad)).toBe('degraded');
    expect(h.record(bad)).toBe('unhealthy');
    expect(h.shouldTerminateRunning()).toBe(true);
    expect(h.record(ok)).toBe('unhealthy');
    expect(h.record(ok)).toBe('healthy');
    expect(h.transitions.map((x) => x.to)).toEqual(['healthy', 'degraded', 'unhealthy', 'healthy']);
  });
  it('a slow answer counts as a failure', () => {
    const h = new RuntimeHealthMonitor();
    h.record(ok);
    expect(h.record({ ...ok, latencyMs: 9_999 })).toBe('degraded');
  });
  it('admits only when healthy with free slots', () => {
    const h = new RuntimeHealthMonitor();
    expect(h.admits(null)).toBe(false);
    h.record(ok);
    expect(h.admits(ok)).toBe(true);
    expect(h.admits({ ...ok, freeSlots: 0 })).toBe(false);
    h.record(bad);
    expect(h.admits(ok)).toBe(false);
  });
});
