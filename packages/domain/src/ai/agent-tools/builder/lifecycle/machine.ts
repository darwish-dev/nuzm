import type { ToolInvocation } from './tool-registry';
import {
  LIFECYCLE_LIMITS,
  LIFECYCLE_STEP_IDS,
  REPAIR_STEPS,
  STEP_DEFS,
  TRANSIENT_CODES,
  type LifecycleLimits,
  type StepId,
} from './steps';

/**
 * The lifecycle state machine (PHASE-2 S05): a PURE reducer over a JSON state that the runner keeps in the run checkpoint after every step. It never reads a clock (callers pass `now`),
 * never calls anything and never throws for a business outcome: the runner asks `nextAction`, performs it, and reports with `beginStep` / `completeStep` / `failStep`. Because the
 * whole state is in the checkpoint, a crash resumes at the step that was running (its attempt count survives), a cancel stops between steps, and every ceiling is enforced here, once.
 */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting_approval'
  | 'denied'
  | 'cancelled';
export type RunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export interface StepRecord {
  id: StepId;
  status: StepStatus;
  attempts: number;
  /** the repair round this record belongs to (0 = the first pass) */
  round: number;
  startedAt?: string;
  finishedAt?: string;
  /** failure or skip reason */
  code?: string;
  /** one short line for the customer (data, never an instruction) */
  summary?: string;
  tokensIn: number;
  tokensOut: number;
  /** credits of THIS step's model calls, a decimal string (integer minor units) */
  credits: string;
}

export type LifecycleEventType =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'retry'
  | 'skipped'
  | 'repair_round'
  | 'suspended'
  | 'resolved'
  | 'cancelled'
  | 'stopped';
export interface LifecycleEvent {
  at: string;
  step: StepId | null;
  type: LifecycleEventType;
  code?: string;
}

export interface LifecycleState {
  version: 1;
  status: RunStatus;
  steps: Record<StepId, StepRecord>;
  current: StepId | null;
  repairRound: number;
  /** step executions so far, repeats included */
  stepRuns: number;
  executionRequests: number;
  tokensIn: number;
  tokensOut: number;
  credits: string;
  startedAt: string;
  cancelRequested: boolean;
  failure: { step: StepId | null; code: string } | null;
  limits: LifecycleLimits;
  events: LifecycleEvent[];
  invocations: ToolInvocation[];
}

const MAX_EVENTS = 300;
const MAX_INVOCATIONS = 150;

const fresh = (id: StepId): StepRecord => ({
  id,
  status: 'pending',
  attempts: 0,
  round: 0,
  tokensIn: 0,
  tokensOut: 0,
  credits: '0',
});

export function newLifecycle(now: string, limits: Partial<LifecycleLimits> = {}): LifecycleState {
  const l = { ...LIFECYCLE_LIMITS };
  // a run's own limits can only LOWER the defaults
  for (const k of Object.keys(l) as (keyof LifecycleLimits)[]) {
    const v = limits[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) l[k] = Math.min(l[k], v);
  }
  return {
    version: 1,
    status: 'running',
    steps: Object.fromEntries(LIFECYCLE_STEP_IDS.map((id) => [id, fresh(id)])) as Record<
      StepId,
      StepRecord
    >,
    current: null,
    repairRound: 0,
    stepRuns: 0,
    executionRequests: 0,
    tokensIn: 0,
    tokensOut: 0,
    credits: '0',
    startedAt: now,
    cancelRequested: false,
    failure: null,
    limits: l,
    events: [],
    invocations: [],
  };
}

const copy = (s: LifecycleState): LifecycleState => JSON.parse(JSON.stringify(s)) as LifecycleState;
const ev = (s: LifecycleState, e: LifecycleEvent) => {
  s.events.push(e);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
};
const terminal = (s: LifecycleState) => ['succeeded', 'failed', 'cancelled'].includes(s.status);

export type Action =
  | { kind: 'run'; step: StepId; attempt: number }
  | { kind: 'wait'; step: StepId }
  | { kind: 'done'; status: RunStatus; code?: string };

export type CeilingCode =
  | 'steps_exceeded'
  | 'time_exceeded'
  | 'tokens_exceeded'
  | 'credits_exceeded'
  | 'execution_requests_exceeded';
export interface RunBudget {
  maxTokens?: number;
  maxCredits?: number;
}
const minutes = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000; // the pure reducer only parses the strings it was given

/** The ceilings of the whole run, checked before every step. `null` = within all of them. */
export function ceilingReached(
  s: LifecycleState,
  now: string,
  budget: RunBudget = {},
  step?: StepId,
): CeilingCode | null {
  if (s.stepRuns >= s.limits.maxStepRuns) return 'steps_exceeded';
  if (minutes(s.startedAt, now) >= s.limits.maxMinutes) return 'time_exceeded';
  const maxTokens = Math.min(s.limits.maxTokens, budget.maxTokens ?? Infinity);
  if (s.tokensIn + s.tokensOut >= maxTokens) return 'tokens_exceeded';
  if (budget.maxCredits !== undefined && BigInt(s.credits) >= BigInt(budget.maxCredits))
    return 'credits_exceeded';
  if (
    (!step || STEP_DEFS[step].kind === 'execution') &&
    s.executionRequests >= s.limits.maxExecutionRequests
  )
    return 'execution_requests_exceeded';
  return null;
}

/** What to do next. Cancellation wins over everything; a ceiling stops the run with its code; otherwise the first pending step in lifecycle order. */
export function nextAction(s: LifecycleState, now: string, budget: RunBudget = {}): Action {
  if (terminal(s))
    return { kind: 'done', status: s.status, ...(s.failure ? { code: s.failure.code } : {}) };
  if (s.cancelRequested) return { kind: 'done', status: 'cancelled', code: 'cancelled' };
  const waiting = LIFECYCLE_STEP_IDS.find((id) => s.steps[id].status === 'waiting_approval');
  if (waiting) return { kind: 'wait', step: waiting };
  const running = LIFECYCLE_STEP_IDS.find((id) => s.steps[id].status === 'running');
  const step = running ?? LIFECYCLE_STEP_IDS.find((id) => s.steps[id].status === 'pending');
  if (!step) return { kind: 'done', status: 'succeeded' };
  // a step that was running when the process died is re-run without counting against the ceilings twice
  if (!running) {
    const c = ceilingReached(s, now, budget, step);
    if (c) return { kind: 'done', status: 'failed', code: c };
  }
  return { kind: 'run', step, attempt: s.steps[step].attempts + (running ? 0 : 1) };
}

/** Marks the step running. Only the step `nextAction` named may begin. */
export function beginStep(s0: LifecycleState, id: StepId, now: string): LifecycleState {
  const s = copy(s0);
  const r = s.steps[id];
  if (terminal(s) || (r.status !== 'pending' && r.status !== 'running'))
    throw new Error(`step ${id} cannot begin from ${r.status} in a ${s.status} run`);
  const resumed = r.status === 'running';
  r.status = 'running';
  r.startedAt = now;
  delete r.finishedAt;
  delete r.code;
  if (!resumed) {
    r.attempts += 1;
    s.stepRuns += 1;
    if (STEP_DEFS[id].kind === 'execution') s.executionRequests += 1;
  }
  s.current = id;
  ev(s, { at: now, step: id, type: resumed ? 'retry' : 'started' });
  return s;
}

export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  /** integer minor units, a decimal string */
  credits?: string;
}
export type StepOutcome = {
  /** an execution step whose BUILD or TESTS failed is a successful step with `passed: false` (the loop reacts to it); omit for other steps */
  passed?: boolean;
  summary?: string;
  usage?: Usage;
};

function addUsage(s: LifecycleState, r: StepRecord, u: Usage | undefined) {
  if (!u) return;
  const i = Math.max(0, Math.trunc(u.tokensIn ?? 0));
  const o = Math.max(0, Math.trunc(u.tokensOut ?? 0));
  r.tokensIn += i;
  r.tokensOut += o;
  s.tokensIn += i;
  s.tokensOut += o;
  if (u.credits && /^\d{1,30}$/.test(u.credits)) {
    r.credits = (BigInt(r.credits) + BigInt(u.credits)).toString();
    s.credits = (BigInt(s.credits) + BigInt(u.credits)).toString();
  }
}

/** Token and credit usage of a call that happened but whose step did not finish (the cost is real either way). */
export function recordUsage(s0: LifecycleState, id: StepId, u: Usage): LifecycleState {
  const s = copy(s0);
  addUsage(s, s.steps[id], u);
  return s;
}

export function recordInvocation(s0: LifecycleState, inv: ToolInvocation): LifecycleState {
  const s = copy(s0);
  const i = s.invocations.findIndex((x) => x.id === inv.id);
  if (i >= 0) s.invocations[i] = inv;
  else s.invocations.push(inv);
  if (s.invocations.length > MAX_INVOCATIONS)
    s.invocations.splice(0, s.invocations.length - MAX_INVOCATIONS);
  return s;
}

const resetRepairRound = (s: LifecycleState, now: string) => {
  s.repairRound += 1;
  for (const id of REPAIR_STEPS) {
    s.steps[id] = { ...fresh(id), round: s.repairRound };
  }
  ev(s, { at: now, step: null, type: 'repair_round' });
};
const failRun = (s: LifecycleState, step: StepId | null, code: string, now: string) => {
  s.status = 'failed';
  s.failure = { step, code };
  s.current = null;
  ev(s, { at: now, step, type: 'stopped', code });
};

/**
 * A step finished. For the two execution phases the OUTCOME decides the route: a failed build or test run opens a repair round while one is left, or ends the run with
 * `repair_exhausted`; a passed one skips the repair steps that were never needed.
 */
export function completeStep(
  s0: LifecycleState,
  id: StepId,
  o: StepOutcome,
  now: string,
): LifecycleState {
  const s = copy(s0);
  const r = s.steps[id];
  if (r.status !== 'running') throw new Error(`step ${id} is not running (${r.status})`);
  r.status = 'succeeded';
  r.finishedAt = now;
  if (o.summary) r.summary = o.summary.slice(0, 300);
  addUsage(s, r, o.usage);
  s.current = null;
  ev(s, { at: now, step: id, type: 'succeeded' });

  const phase = id === 'build' || id === 'rebuild' || id === 'tests';
  if (phase && o.passed === false) {
    if (s.repairRound >= s.limits.maxRepairRounds) {
      r.status = 'failed';
      r.code = 'repair_exhausted';
      failRun(s, id, 'repair_exhausted', now);
      return s;
    }
    resetRepairRound(s, now);
    // a failing test run is re-run after the repair; the build itself already passed
    if (id === 'tests') s.steps.tests = { ...fresh('tests'), round: s.repairRound };
  }
  if (id === 'build' && o.passed !== false) {
    for (const sid of REPAIR_STEPS) {
      const x = s.steps[sid];
      if (x.status === 'pending') {
        x.status = 'skipped';
        x.code = 'build_passed';
        ev(s, { at: now, step: sid, type: 'skipped', code: 'build_passed' });
      }
    }
  }
  if (
    !LIFECYCLE_STEP_IDS.some((x) =>
      ['pending', 'running', 'waiting_approval'].includes(s.steps[x].status),
    )
  )
    s.status = 'succeeded';
  return s;
}

/**
 * A step failed (an error, not a failed build). A transient code gets another attempt up to `maxStepAttempts`; anything else ends the step and the run, with the code kept for
 * the customer. An execution the gateway refused is never retried: retrying a refusal is how a policy gets worn down.
 */
export function failStep(
  s0: LifecycleState,
  id: StepId,
  code: string,
  now: string,
  usage?: Usage,
): LifecycleState {
  const s = copy(s0);
  const r = s.steps[id];
  if (r.status !== 'running') throw new Error(`step ${id} is not running (${r.status})`);
  addUsage(s, r, usage);
  s.current = null;
  const retry = TRANSIENT_CODES.includes(code) && r.attempts < s.limits.maxStepAttempts;
  if (retry) {
    r.status = 'pending';
    r.code = code;
    ev(s, { at: now, step: id, type: 'retry', code });
    return s;
  }
  r.status = 'failed';
  r.code = code.slice(0, 60);
  r.finishedAt = now;
  ev(s, { at: now, step: id, type: 'failed', code });
  failRun(s, id, code.slice(0, 60), now);
  return s;
}

/** The deployment approval is requested: the step and the run wait for a person. Nothing is deployed by the lifecycle. */
export function suspendForApproval(s0: LifecycleState, id: StepId, now: string): LifecycleState {
  const s = copy(s0);
  const r = s.steps[id];
  if (r.status !== 'running') throw new Error(`step ${id} is not running (${r.status})`);
  r.status = 'waiting_approval';
  s.status = 'waiting_approval';
  s.current = id;
  ev(s, { at: now, step: id, type: 'suspended' });
  return s;
}

export function resolveApproval(
  s0: LifecycleState,
  id: StepId,
  decision: 'approved' | 'denied',
  now: string,
): LifecycleState {
  const s = copy(s0);
  const r = s.steps[id];
  if (r.status !== 'waiting_approval') throw new Error(`step ${id} is not waiting for a decision`);
  r.status = decision === 'approved' ? 'succeeded' : 'denied';
  r.finishedAt = now;
  if (decision === 'denied') r.code = 'approval_denied';
  s.status = 'succeeded'; // the project was built either way; a denied deployment is an outcome, not a failure
  s.current = null;
  ev(s, { at: now, step: id, type: 'resolved', code: decision });
  return s;
}

/** A cancel request (idempotent): honoured before the next step begins, or by `cancelNow` when the runner is between steps. */
export function requestCancel(s0: LifecycleState): LifecycleState {
  if (terminal(s0) || s0.cancelRequested) return s0;
  const s = copy(s0);
  s.cancelRequested = true;
  return s;
}

export function cancelNow(s0: LifecycleState, now: string): LifecycleState {
  if (terminal(s0)) return s0;
  const s = copy(s0);
  s.status = 'cancelled';
  s.cancelRequested = true;
  s.current = null;
  for (const id of LIFECYCLE_STEP_IDS) {
    const r = s.steps[id];
    if (r.status === 'pending' || r.status === 'running' || r.status === 'waiting_approval')
      r.status = 'cancelled';
  }
  ev(s, { at: now, step: null, type: 'cancelled' });
  return s;
}

/** Ends the run with a ceiling code (the runner calls it when `nextAction` said so). */
export function stopRun(s0: LifecycleState, code: string, now: string): LifecycleState {
  if (terminal(s0)) return s0;
  const s = copy(s0);
  const cur = LIFECYCLE_STEP_IDS.find((id) => s.steps[id].status === 'pending') ?? null;
  failRun(s, cur, code, now);
  return s;
}

export interface Progress {
  status: RunStatus;
  /** 0..100 */
  percent: number;
  done: number;
  total: number;
  current: StepId | null;
  repairRound: number;
  tokens: number;
  credits: string;
}

/** Progress for the customer. Repair steps that may never be needed do not count until a repair round opens, so a clean run reaches 100 % without a hole. */
export function progress(s: LifecycleState): Progress {
  const counted = LIFECYCLE_STEP_IDS.filter((id) => {
    const r = s.steps[id];
    if (r.status === 'skipped') return false;
    return !(STEP_DEFS[id].repairOnly && r.status === 'pending' && s.repairRound === 0);
  });
  const done = counted.filter((id) => ['succeeded', 'denied'].includes(s.steps[id].status)).length;
  const total = counted.length;
  const percent =
    s.status === 'succeeded' ? 100 : Math.min(99, Math.floor((done / Math.max(1, total)) * 100));
  return {
    status: s.status,
    percent,
    done,
    total,
    current: s.current,
    repairRound: s.repairRound,
    tokens: s.tokensIn + s.tokensOut,
    credits: s.credits,
  };
}
