import { describe, expect, it } from 'vitest';
import {
  ExecutionKillSwitch,
  terminate,
  type RunningExecution,
  type TerminationPorts,
  type TerminationScope,
} from './index';

const R = (orgId: string, runId: string): RunningExecution => ({
  orgId,
  runId,
  jobId: `j-${runId}`,
  handle: `h-${runId}`,
});
const mkPorts = (
  running: RunningExecution[],
  opts: { stubborn?: string[]; failDestroy?: string[] } = {},
) => {
  const log: string[] = [];
  const alive = new Set(running.map((r) => r.runId));
  const ports: TerminationPorts = {
    listRunning: async () => running,
    signal: async (h, how) => {
      log.push(`${how}:${h.runId}`);
      if (how === 'hard' || !opts.stubborn?.includes(h.runId)) alive.delete(h.runId);
    },
    isGone: async (h) => !alive.has(h.runId),
    destroyWorkspace: async (h) => {
      log.push(`destroy:${h.runId}`);
      if (opts.failDestroy?.includes(h.runId)) throw new Error('boom');
    },
    drainQueue: async () => 3,
    revokeApprovals: async () => 2,
    markTerminated: async (h, cause) => {
      log.push(`mark:${h.runId}:${cause}`);
    },
    audit: (e) => {
      log.push(`audit:${e.step}:${e.ok}`);
    },
  };
  return { ports, log, alive };
};

describe('ExecutionKillSwitch', () => {
  it('global and per-organization, released only deliberately', () => {
    const k = new ExecutionKillSwitch();
    expect(k.isEngaged('o1')).toBe(false);
    k.engageOrg('o1', 'abuse');
    expect(k.isEngaged('o1')).toBe(true);
    expect(k.isEngaged('o2')).toBe(false);
    k.engageGlobal('incident');
    expect(k.isEngaged('o2')).toBe(true);
    k.releaseGlobal();
    expect(k.isEngaged('o2')).toBe(false);
    expect(k.isEngaged('o1')).toBe(true);
    k.releaseOrg('o1');
    expect(k.isEngaged('o1')).toBe(false);
  });
  it('bounds the stored reason', () => {
    const k = new ExecutionKillSwitch();
    k.engageGlobal('x'.repeat(1000));
    expect(k.state().reason).toHaveLength(120);
  });
});

describe('terminate (emergency termination plan)', () => {
  it('kills only the runs in scope: one run, one organization, or all', async () => {
    const all = [R('o1', 'a'), R('o1', 'b'), R('o2', 'c')];
    const scopes: [TerminationScope, string[]][] = [
      [{ kind: 'run', orgId: 'o1', runId: 'a' }, ['a']],
      [{ kind: 'run', orgId: 'o2', runId: 'a' }, []], // a run id of another organization does not match
      [{ kind: 'org', orgId: 'o1' }, ['a', 'b']],
      [{ kind: 'all' }, ['a', 'b', 'c']],
    ];
    for (const [scope, expected] of scopes) {
      const { ports, log } = mkPorts(all);
      const rep = await terminate(scope, ports, { cause: 'test' });
      expect(log.filter((l) => l.startsWith('mark:')).map((l) => l.split(':')[1])).toEqual(
        expected,
      );
      expect(rep.killed).toBe(expected.length);
    }
  });
  it('revokes approvals and drains the queue first, then terminates softly, then destroys the workspace', async () => {
    const { ports, log } = mkPorts([R('o', 'a')]);
    const rep = await terminate({ kind: 'org', orgId: 'o' }, ports, { cause: 'kill_switch' });
    expect(rep).toMatchObject({
      approvalsRevoked: 2,
      queuedDrained: 3,
      killed: 1,
      hardKilled: 0,
      failed: [],
    });
    const order = log.filter((l) => !l.startsWith('audit'));
    expect(order).toEqual(['soft:a', 'destroy:a', 'mark:a:kill_switch']);
    expect(log.indexOf('audit:revoke_approvals:true')).toBeLessThan(log.indexOf('soft:a'));
  });
  it('escalates to SIGKILL when the soft stop is ignored', async () => {
    const { ports, log } = mkPorts([R('o', 'a')], { stubborn: ['a'] });
    const rep = await terminate({ kind: 'all' }, ports, { cause: 'x', graceChecks: 2 });
    expect(rep.hardKilled).toBe(1);
    expect(rep.killed).toBe(1);
    expect(log).toContain('hard:a');
  });
  it('a failing step is recorded and the plan continues with the other runs', async () => {
    const { ports, log } = mkPorts([R('o', 'a'), R('o', 'b')], { failDestroy: ['a'] });
    const rep = await terminate({ kind: 'all' }, ports, { cause: 'x' });
    expect(rep.failed).toEqual([{ runId: 'a', step: 'destroy_workspace' }]);
    expect(log).toContain('mark:a:x');
    expect(log).toContain('mark:b:x');
    expect(rep.killed).toBe(2);
  });
  it('reports a zombie that survives SIGKILL but still destroys its workspace and marks it', async () => {
    const { ports, log, alive } = mkPorts([R('o', 'z')]);
    ports.signal = async (h, how) => {
      log.push(`${how}:${h.runId}`);
    };
    alive.add('z');
    const rep = await terminate({ kind: 'all' }, ports, { cause: 'x' });
    expect(rep.killed).toBe(0);
    expect(rep.failed).toContainEqual({ runId: 'z', step: 'still_running' });
    expect(log).toContain('destroy:z');
    expect(log).toContain('mark:z:x');
  });
  it('survives a failing listRunning (reports it, still drained and revoked)', async () => {
    const { ports } = mkPorts([]);
    ports.listRunning = async () => {
      throw new Error('down');
    };
    const rep = await terminate({ kind: 'all' }, ports);
    expect(rep.failed).toEqual([{ runId: '*', step: 'list_running' }]);
    expect(rep.queuedDrained).toBe(3);
  });
});
