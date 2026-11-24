import { describe, expect, it } from 'vitest';
import {
  JOB_TERMINAL,
  StateTrack,
  isJobTerminal,
  transitionJob,
  transitionWorkspace,
  type JobState,
  type WorkspaceState,
} from './index';

const JOBS: JobState[] = [
  'requested',
  'refused',
  'awaiting_approval',
  'rejected',
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'terminated',
  'cancelled',
  'expired',
];
describe('job state machine', () => {
  it('walks the happy paths', () => {
    const t = new StateTrack<JobState>('requested', transitionJob);
    for (const s of ['awaiting_approval', 'queued', 'running', 'succeeded'] as JobState[])
      expect(t.move(s, 'test').ok).toBe(true);
    expect(t.state).toBe('succeeded');
    expect(t.history.map((h) => h.to)).toEqual([
      'awaiting_approval',
      'queued',
      'running',
      'succeeded',
    ]);
  });
  it('terminal states are final: nothing leaves them, not even terminated', () => {
    for (const from of JOB_TERMINAL)
      for (const to of JOBS)
        expect(transitionJob(from, to), `${from}->${to}`).toMatchObject({ ok: false });
  });
  it('cannot skip approval, start from the wrong state or run twice', () => {
    expect(transitionJob('awaiting_approval', 'running')).toMatchObject({ ok: false });
    expect(transitionJob('requested', 'running')).toMatchObject({ ok: false });
    expect(transitionJob('queued', 'succeeded')).toMatchObject({ ok: false });
    expect(transitionJob('running', 'running')).toMatchObject({ ok: false });
    expect(transitionJob('running', 'cancelled')).toMatchObject({ ok: false });
  });
  it('emergency termination is reachable from every non-terminal state', () => {
    for (const from of JOBS.filter((s) => !isJobTerminal(s)))
      expect(transitionJob(from, 'terminated'), from).toMatchObject({ ok: true });
  });
  it('a refused move leaves the state and the history unchanged', () => {
    const t = new StateTrack<JobState>('queued', transitionJob);
    expect(t.move('succeeded', 'bad')).toMatchObject({ ok: false });
    expect(t.state).toBe('queued');
    expect(t.history).toEqual([]);
  });
});

describe('workspace state machine', () => {
  const WS: WorkspaceState[] = ['creating', 'ready', 'in_use', 'failed', 'destroying', 'destroyed'];
  it('create, use, release, destroy', () => {
    const t = new StateTrack<WorkspaceState>('creating', transitionWorkspace);
    for (const s of [
      'ready',
      'in_use',
      'ready',
      'in_use',
      'destroying',
      'destroyed',
    ] as WorkspaceState[])
      expect(t.move(s, 'x').ok).toBe(true);
  });
  it('destroyed is final: a workspace is never revived or reused', () => {
    for (const to of WS) expect(transitionWorkspace('destroyed', to)).toMatchObject({ ok: false });
  });
  it('every state can reach destroyed (cleanup always possible)', () => {
    for (const from of WS.filter((s) => s !== 'destroyed')) {
      const path = from === 'destroying' ? ['destroyed'] : ['destroying', 'destroyed'];
      let cur: WorkspaceState = from;
      for (const s of path as WorkspaceState[]) {
        const r = transitionWorkspace(cur, s);
        expect(r.ok, `${from} via ${s}`).toBe(true);
        if (r.ok) cur = r.state;
      }
      expect(cur).toBe('destroyed');
    }
  });
  it('cannot go straight from creating to in_use', () => {
    expect(transitionWorkspace('creating', 'in_use')).toMatchObject({ ok: false });
  });
});
