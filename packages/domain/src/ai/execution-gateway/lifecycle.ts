/**
 * S-AG6 (OFFLINE): the two state machines of an execution, as data plus a pure transition function. Illegal transitions are REFUSED (never coerced); terminal states are final;
 * every transition names its cause so the audit trail can say why.
 *
 * Job (one execution request):
 *   requested -> refused                                    (gateway refusal; terminal)
 *   requested -> awaiting_approval | queued                 (approval first when the decision needs a human)
 *   awaiting_approval -> queued | rejected | expired        (a human decides, or the approval times out)
 *   queued -> running | cancelled | expired                 (a worker takes it; caller cancels; it waited too long)
 *   running -> succeeded | failed | timed_out | terminated  (the process group ended; the kill switch / an operator; a limit)
 *   running -> queued                                       (ONLY when the worker's lease expired and attempts remain: the run is reconciled, then retried)
 *   any non-terminal -> terminated                          (emergency termination)
 *
 * Workspace (the per-run sandbox directory): creating -> ready -> in_use <-> ready -> destroying -> destroyed; any state -> failed -> destroying. `destroyed` is final and a
 * workspace is never reused for another run or organization.
 */
export type JobState =
  | 'requested'
  | 'refused'
  | 'awaiting_approval'
  | 'rejected'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'terminated'
  | 'cancelled'
  | 'expired';
export const JOB_TERMINAL: readonly JobState[] = [
  'refused',
  'rejected',
  'succeeded',
  'failed',
  'timed_out',
  'terminated',
  'cancelled',
  'expired',
];
const JOB_NEXT: Readonly<Record<JobState, readonly JobState[]>> = {
  requested: ['refused', 'awaiting_approval', 'queued', 'terminated'],
  awaiting_approval: ['queued', 'rejected', 'expired', 'cancelled', 'terminated'],
  queued: ['running', 'cancelled', 'expired', 'terminated'],
  running: ['succeeded', 'failed', 'timed_out', 'terminated', 'queued'],
  refused: [],
  rejected: [],
  succeeded: [],
  failed: [],
  timed_out: [],
  terminated: [],
  cancelled: [],
  expired: [],
};
export type WorkspaceState =
  'creating' | 'ready' | 'in_use' | 'failed' | 'destroying' | 'destroyed';
const WS_NEXT: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  creating: ['ready', 'failed', 'destroying'],
  ready: ['in_use', 'failed', 'destroying'],
  in_use: ['ready', 'failed', 'destroying'],
  failed: ['destroying'],
  destroying: ['destroyed', 'failed'],
  destroyed: [],
};
export const WORKSPACE_TERMINAL: readonly WorkspaceState[] = ['destroyed'];

export type TransitionResult<S> = { ok: true; state: S } | { ok: false; reason: string };
export function transitionJob(from: JobState, to: JobState): TransitionResult<JobState> {
  if (JOB_TERMINAL.includes(from)) return { ok: false, reason: `terminal_state_${from}` };
  return JOB_NEXT[from].includes(to)
    ? { ok: true, state: to }
    : { ok: false, reason: `illegal_transition_${from}_to_${to}` };
}
export function transitionWorkspace(
  from: WorkspaceState,
  to: WorkspaceState,
): TransitionResult<WorkspaceState> {
  if (from === 'destroyed') return { ok: false, reason: 'terminal_state_destroyed' };
  return WS_NEXT[from].includes(to)
    ? { ok: true, state: to }
    : { ok: false, reason: `illegal_transition_${from}_to_${to}` };
}
export const isJobTerminal = (s: JobState) => JOB_TERMINAL.includes(s);

export interface TransitionRecord<S> {
  from: S;
  to: S;
  at: string;
  cause: string;
}
/** A tiny stateful holder that records the history and refuses illegal moves by throwing nothing: it returns the refusal. */
export class StateTrack<S extends string> {
  readonly history: TransitionRecord<S>[] = [];
  constructor(
    private current: S,
    private readonly next: (from: S, to: S) => TransitionResult<S>,
    private readonly now: () => Date = () => new Date(),
    /** called after every ACCEPTED move (P3-S02 durable journal); it must not throw, and a throw is swallowed so it can never change the state machine's result */
    private readonly onMove?: (m: TransitionRecord<S>) => void,
  ) {}
  get state(): S {
    return this.current;
  }
  move(to: S, cause: string): TransitionResult<S> {
    const r = this.next(this.current, to);
    if (!r.ok) return r;
    const rec = { from: this.current, to, at: this.now().toISOString(), cause };
    this.history.push(rec);
    this.current = to;
    try {
      this.onMove?.(rec);
    } catch {
      /* observation only */
    }
    return r;
  }
}
