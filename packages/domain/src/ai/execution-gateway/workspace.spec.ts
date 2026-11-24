import { describe, expect, it } from 'vitest';
import { DEFAULT_CLEANUP_POLICY as P, WorkspaceRegistry } from './index';

let t = 0;
const reg = () => new WorkspaceRegistry(() => t);
const ok = async () => undefined;

describe('WorkspaceRegistry', () => {
  it('one workspace per run: never a second, even after the first was destroyed', async () => {
    t = 0;
    const r = reg();
    const a = r.create('o', 'run-1');
    expect(a).toMatchObject({ ok: true });
    expect(r.create('o', 'run-1')).toEqual({
      ok: false,
      reason: 'workspace_already_created_for_run',
    });
    if (!a.ok) throw new Error();
    r.move(a.id, 'o', 'destroying', 'x');
    r.move(a.id, 'o', 'destroyed', 'x');
    expect(r.create('o', 'run-1')).toMatchObject({ ok: false });
    // the same run id in another organization is another run
    expect(r.create('o2', 'run-1')).toMatchObject({ ok: true });
  });
  it('moves only along the lifecycle and only for the owning organization', () => {
    t = 0;
    const r = reg();
    const a = r.create('o', 'r');
    if (!a.ok) throw new Error();
    expect(r.move(a.id, 'o', 'in_use', 'x')).toEqual({
      ok: false,
      reason: 'illegal_transition_creating_to_in_use',
    });
    expect(r.move(a.id, 'o2', 'ready', 'x')).toEqual({ ok: false, reason: 'unknown_workspace' });
    expect(r.move(a.id, 'o', 'ready', 'x')).toEqual({ ok: true });
    expect(r.get(a.id, 'o2')).toBeUndefined();
    expect(r.get(a.id, 'o')!.state).toBe('ready');
  });
  it('reaps by the cleanup plan: ended job after the grace, then verifies destroyed is final', async () => {
    t = 0;
    const r = reg();
    const a = r.create('o', 'r');
    if (!a.ok) throw new Error();
    r.move(a.id, 'o', 'ready', 'x');
    r.setJob(a.id, 'o', 'j', 'succeeded', true);
    t = P.afterJobEndMs - 1;
    expect(await r.reap({ destroy: ok })).toEqual({ destroyed: 0, failed: 0 });
    t = P.afterJobEndMs;
    const audits: string[] = [];
    expect(
      await r.reap({ destroy: ok, audit: (e) => void audits.push(`${e.reason}:${e.ok}`) }),
    ).toEqual({ destroyed: 1, failed: 0 });
    expect(audits).toEqual(['job_ended:true']);
    expect(r.get(a.id, 'o')!.state).toBe('destroyed');
    expect(r.move(a.id, 'o', 'ready', 'x')).toMatchObject({ ok: false });
    expect(await r.reap({ destroy: ok })).toEqual({ destroyed: 0, failed: 0 });
  });
  it('a failing destroy leaves the workspace failed and the next pass retries it', async () => {
    t = 0;
    const r = reg();
    const a = r.create('o', 'r');
    if (!a.ok) throw new Error();
    r.move(a.id, 'o', 'ready', 'x');
    r.setJob(a.id, 'o', 'j', 'terminated', true);
    let calls = 0;
    const flaky = async () => {
      if (++calls === 1) throw new Error('device busy');
    };
    expect(await r.reap({ destroy: flaky })).toEqual({ destroyed: 0, failed: 1 });
    expect(r.get(a.id, 'o')!.state).toBe('failed');
    expect(await r.reap({ destroy: flaky })).toEqual({ destroyed: 1, failed: 0 });
    expect(r.get(a.id, 'o')!.state).toBe('destroyed');
  });
  it('reaps orphans and over-lifetime workspaces; keeps an in-use one', async () => {
    t = 0;
    const r = reg();
    const orphan = r.create('o', 'orphan');
    const live = r.create('o', 'live', 'j');
    if (!orphan.ok || !live.ok) throw new Error();
    r.move(live.id, 'o', 'ready', 'x');
    r.move(live.id, 'o', 'in_use', 'x');
    r.setJob(live.id, 'o', 'j', 'running', false);
    t = P.orphanGraceMs;
    expect(r.plan().map((a) => [a.runId, a.reason])).toEqual([['orphan', 'orphan']]);
    t = P.maxLifetimeMs;
    expect(
      r
        .plan()
        .map((a) => a.reason)
        .sort(),
    ).toEqual(['max_lifetime', 'orphan']);
  });
});
