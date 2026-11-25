import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_STEP_IDS,
  beginStep,
  cancelNow,
  ceilingReached,
  completeStep,
  failStep,
  newLifecycle,
  nextAction,
  progress,
  recordUsage,
  requestCancel,
  resolveApproval,
  stopRun,
  suspendForApproval,
  type LifecycleState,
  type StepId,
} from './index';

const T0 = '2026-11-24T00:00:00.000Z';
const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();

/** drives the machine: runs whatever `nextAction` says, with a per-step script */
function drive(
  s0: LifecycleState,
  script: (id: StepId, attempt: number) => { passed?: boolean; fail?: string } | void,
  max = 100,
): { s: LifecycleState; ran: StepId[] } {
  let s = s0;
  const ran: StepId[] = [];
  for (let i = 0; i < max; i++) {
    const a = nextAction(s, at(1));
    if (a.kind !== 'run') break;
    ran.push(a.step);
    s = beginStep(s, a.step, at(1));
    const r = script(a.step, a.attempt) ?? {};
    if (r.fail) s = failStep(s, a.step, r.fail, at(1));
    else if (a.step === 'deployment_approval') s = suspendForApproval(s, a.step, at(1));
    else
      s = completeStep(
        s,
        a.step,
        { ...(r.passed === undefined ? {} : { passed: r.passed }) },
        at(1),
      );
  }
  return { s, ran };
}

describe('the lifecycle has the 18 steps in order', () => {
  it('lists them', () => {
    expect(LIFECYCLE_STEP_IDS).toHaveLength(18);
    expect(LIFECYCLE_STEP_IDS[0]).toBe('requirements');
    expect(LIFECYCLE_STEP_IDS[17]).toBe('deployment_approval');
  });
});

describe('a clean run', () => {
  it('skips the repair steps, waits for the deployment approval and finishes when it is decided', () => {
    const { s, ran } = drive(newLifecycle(T0), () => ({ passed: true }));
    expect(ran).toEqual([
      'requirements',
      'project_analysis',
      'architecture',
      'plan',
      'tasks',
      'file_generation',
      'change_apply',
      'review',
      'execution_request',
      'build',
      'tests',
      'preview',
      'deployment_preparation',
      'deployment_approval',
    ]);
    expect(s.status).toBe('waiting_approval');
    expect(s.steps.repair.status).toBe('skipped');
    expect(nextAction(s, at(2))).toEqual({ kind: 'wait', step: 'deployment_approval' });
    const done = resolveApproval(s, 'deployment_approval', 'approved', at(3));
    expect(done.status).toBe('succeeded');
    expect(progress(done).percent).toBe(100);
    expect(nextAction(done, at(4))).toMatchObject({ kind: 'done', status: 'succeeded' });
  });
  it('a denied deployment is an outcome, not a failure', () => {
    const { s } = drive(newLifecycle(T0), () => ({ passed: true }));
    const d = resolveApproval(s, 'deployment_approval', 'denied', at(3));
    expect(d.status).toBe('succeeded');
    expect(d.steps.deployment_approval).toMatchObject({
      status: 'denied',
      code: 'approval_denied',
    });
  });
  it('progress never reports a hole for repair steps that may never run', () => {
    const s = newLifecycle(T0);
    expect(progress(s).total).toBe(14);
    expect(progress(s).percent).toBe(0);
  });
});

describe('the repair loop', () => {
  it('a failed build opens a round; the rebuild passing goes on to the tests', () => {
    let builds = 0;
    const { s, ran } = drive(newLifecycle(T0), (id) => {
      if (id === 'build') return { passed: false };
      if (id === 'rebuild') builds += 1;
      return { passed: true };
    });
    expect(ran.slice(ran.indexOf('build'), ran.indexOf('tests') + 1)).toEqual([
      'build',
      'error_analysis',
      'repair',
      'repair_apply',
      'rebuild',
      'tests',
    ]);
    expect(builds).toBe(1);
    expect(s.repairRound).toBe(1);
    expect(s.status).toBe('waiting_approval');
  });
  it('stops after the maximum number of rounds with repair_exhausted', () => {
    const { s } = drive(newLifecycle(T0), (id) =>
      id === 'build' || id === 'rebuild' ? { passed: false } : {},
    );
    expect(s.status).toBe('failed');
    expect(s.failure).toEqual({ step: 'rebuild', code: 'repair_exhausted' });
    expect(s.repairRound).toBe(3);
    expect(nextAction(s, at(2))).toMatchObject({
      kind: 'done',
      status: 'failed',
      code: 'repair_exhausted',
    });
  });
  it('failing tests re-enter the repair loop and the tests run again afterwards', () => {
    let tests = 0;
    const { s, ran } = drive(newLifecycle(T0), (id) => {
      if (id === 'tests') return { passed: ++tests > 1 };
      return { passed: true };
    });
    expect(tests).toBe(2);
    expect(ran.filter((x) => x === 'repair')).toHaveLength(1);
    expect(s.status).toBe('waiting_approval');
  });
  it('a round limit set by the run only lowers the default', () => {
    expect(newLifecycle(T0, { maxRepairRounds: 1 }).limits.maxRepairRounds).toBe(1);
    expect(newLifecycle(T0, { maxRepairRounds: 99 }).limits.maxRepairRounds).toBe(3);
    const { s } = drive(newLifecycle(T0, { maxRepairRounds: 1 }), (id) =>
      id === 'build' || id === 'rebuild' ? { passed: false } : {},
    );
    expect(s.failure?.code).toBe('repair_exhausted');
    expect(s.repairRound).toBe(1);
  });
});

describe('retries', () => {
  it('a transient failure gets one more attempt and then ends the run', () => {
    const once = drive(newLifecycle(T0), (id, attempt) =>
      id === 'file_generation' && attempt === 1 ? { fail: 'timeout' } : {},
    );
    expect(once.ran.filter((x) => x === 'file_generation')).toHaveLength(2);
    expect(once.s.steps.file_generation.attempts).toBe(2);
    const always = drive(newLifecycle(T0), (id) =>
      id === 'file_generation' ? { fail: 'timeout' } : {},
    );
    expect(always.s.status).toBe('failed');
    expect(always.s.failure).toEqual({ step: 'file_generation', code: 'timeout' });
    expect(always.s.steps.file_generation.attempts).toBe(2);
  });
  it('a refusal is never retried', () => {
    const r = drive(newLifecycle(T0), (id) => (id === 'build' ? { fail: 'build_refused' } : {}));
    expect(r.s.failure).toEqual({ step: 'build', code: 'build_refused' });
    expect(r.ran.filter((x) => x === 'build')).toHaveLength(1);
  });
  it('a step that was running when the process died resumes without counting twice', () => {
    let s = beginStep(newLifecycle(T0), 'requirements', at(0));
    expect(s.stepRuns).toBe(1);
    const a = nextAction(s, at(5));
    expect(a).toEqual({ kind: 'run', step: 'requirements', attempt: 1 });
    s = beginStep(s, 'requirements', at(5));
    expect(s.stepRuns).toBe(1);
    expect(s.steps.requirements.attempts).toBe(1);
  });
});

describe('ceilings and cancellation', () => {
  it('stops at the step ceiling', () => {
    const { s } = drive(newLifecycle(T0, { maxStepRuns: 5 }), () => ({ passed: true }));
    expect(s.stepRuns).toBe(5);
    expect(nextAction(s, at(1))).toMatchObject({
      kind: 'done',
      status: 'failed',
      code: 'steps_exceeded',
    });
  });
  it('stops at the time ceiling, the token ceiling and the run budget', () => {
    const s = newLifecycle(T0, { maxMinutes: 10, maxTokens: 1000 });
    expect(ceilingReached(s, at(9))).toBeNull();
    expect(ceilingReached(s, at(10))).toBe('time_exceeded');
    const used = recordUsage(s, 'file_generation', { tokensIn: 600, tokensOut: 400 });
    expect(ceilingReached(used, at(1))).toBe('tokens_exceeded');
    expect(ceilingReached(s, at(1), { maxTokens: 1 })).toBeNull();
    expect(ceilingReached(recordUsage(s, 'repair', { tokensIn: 5 }), at(1), { maxTokens: 5 })).toBe(
      'tokens_exceeded',
    );
    const c = recordUsage(s, 'repair', { credits: '50' });
    expect(ceilingReached(c, at(1), { maxCredits: 50 })).toBe('credits_exceeded');
    expect(ceilingReached(c, at(1), { maxCredits: 51 })).toBeNull();
  });
  it('the execution-request ceiling stops only execution steps', () => {
    let s = newLifecycle(T0, { maxExecutionRequests: 1 });
    s = { ...s, executionRequests: 1 };
    expect(ceilingReached(s, at(1), {}, 'build')).toBe('execution_requests_exceeded');
    expect(ceilingReached(s, at(1), {}, 'preview')).toBeNull();
  });
  it('a cancel request is honoured before the next step and is idempotent', () => {
    const { s } = drive(newLifecycle(T0), () => ({ passed: true }), 3);
    const c = requestCancel(requestCancel(s));
    expect(nextAction(c, at(1))).toEqual({ kind: 'done', status: 'cancelled', code: 'cancelled' });
    const n = cancelNow(c, at(2));
    expect(n.status).toBe('cancelled');
    expect(
      Object.values(n.steps).some((x) => x.status === 'pending' || x.status === 'running'),
    ).toBe(false);
    expect(cancelNow(n, at(3))).toBe(n);
    expect(requestCancel(n)).toBe(n);
  });
  it('a terminal run cannot begin another step', () => {
    const n = cancelNow(newLifecycle(T0), at(1));
    expect(() => beginStep(n, 'requirements', at(2))).toThrow();
  });
  it('stopRun ends the run with the ceiling code', () => {
    const s = stopRun(newLifecycle(T0), 'tokens_exceeded', at(1));
    expect(s.status).toBe('failed');
    expect(s.failure?.code).toBe('tokens_exceeded');
  });
});

describe('accounting', () => {
  it('adds the usage of every step and of a failed step, in integers and decimal-string credits', () => {
    let s = beginStep(newLifecycle(T0), 'requirements', at(0));
    s = completeStep(
      s,
      'requirements',
      { usage: { tokensIn: 10, tokensOut: 5, credits: '7' } },
      at(1),
    );
    s = beginStep(s, 'project_analysis', at(1));
    s = failStep(s, 'project_analysis', 'invalid', at(2), {
      tokensIn: 1.9,
      tokensOut: -4,
      credits: '3',
    });
    expect(s.tokensIn).toBe(11);
    expect(s.tokensOut).toBe(5);
    expect(s.credits).toBe('10');
    expect(s.steps.project_analysis.tokensOut).toBe(0);
  });
  it('a malformed credit string is ignored, never added', () => {
    const s = recordUsage(newLifecycle(T0), 'repair', { credits: '1e9' });
    expect(s.credits).toBe('0');
  });
  it('the state is JSON and survives a round trip unchanged', () => {
    const { s } = drive(newLifecycle(T0), (id) =>
      id === 'build' ? { passed: false } : { passed: true },
    );
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
  it('the machine does not mutate the state it is given', () => {
    const s = newLifecycle(T0);
    const frozen = JSON.stringify(s);
    beginStep(s, 'requirements', at(1));
    cancelNow(s, at(1));
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
