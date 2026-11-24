import { builderTools } from '@nuzm/domain';
import { ProblemException } from '../../../../common/errors';
import { STEP_FNS, type StepCtx } from './lifecycle.steps';
import {
  StepFailure,
  type LifecycleArtifacts,
  type LifecycleEnv,
  type LifecycleHost,
  type LifecycleState,
  type StepId,
} from './lifecycle.types';

const L = builderTools.lifecycle;

export interface LifecycleOutcome {
  status: builderTools.lifecycle.RunStatus;
  state: LifecycleState;
  artifacts: LifecycleArtifacts;
}

const codeOf = (e: unknown): string =>
  e instanceof StepFailure
    ? e.code
    : e instanceof ProblemException
      ? e.code
      : e instanceof Error && e.name === 'AbortError'
        ? 'cancelled'
        : 'internal_error';

/**
 * The lifecycle runner (PHASE-2 S05): drives the 18 steps of the pure state machine. For every step it (1) checks the run's ceilings and cancellation, (2) records the step
 * (`ai.run_steps`), (3) runs it with every tool use authorized through the registry, (4) accounts its tokens and credits, (5) saves the state to the checkpoint, (6) emits a run event
 * and an audit event. A crash at any point resumes from the checkpoint: the step that was running is re-run, a finished step never is. It ends when the run succeeded, failed or was
 * cancelled, or PARKS at the deployment approval (nothing is deployed from here).
 */
export class LifecycleRunner {
  /** a test can tighten the loop; production never touches it */
  maxLoops = 400;

  async run(
    host: LifecycleHost,
    env: LifecycleEnv,
    signal?: AbortSignal,
  ): Promise<LifecycleOutcome> {
    const saved = await host.load();
    let state =
      saved?.state ??
      L.newLifecycle(host.now(), {
        ...(host.input.maxRepairRounds ? { maxRepairRounds: host.input.maxRepairRounds } : {}),
        ...(host.input.maxMinutes ? { maxMinutes: host.input.maxMinutes } : {}),
      });
    const art: LifecycleArtifacts = saved?.artifacts ?? {};
    if (!saved) {
      await host.save(state, art, 'lifecycle_started');
      await host.emit('lifecycle_started', { steps: L.LIFECYCLE_STEP_IDS.length });
      await host.audit('builder.lifecycle.started', 'success', { projectId: host.projectId });
    }
    const persist = (step: string) => host.save(state, art, step);

    for (let loop = 0; loop < this.maxLoops; loop++) {
      if (await host.cancelled()) state = L.requestCancel(state);
      if (state.cancelRequested && !['succeeded', 'failed', 'cancelled'].includes(state.status)) {
        state = L.cancelNow(state, host.now());
        return this.finish(host, state, art, persist);
      }
      // a parked run: only the approval's decision moves it
      if (state.status === 'waiting_approval') {
        const r = await this.settleApproval(host, env, state, art);
        if (r === null) return { status: 'waiting_approval', state, artifacts: art };
        state = r;
        await host.setRunState('running');
        await persist('deployment_decided');
        continue;
      }

      const act = L.nextAction(state, host.now(), host.budget);
      if (act.kind === 'wait') return { status: 'waiting_approval', state, artifacts: art };
      if (act.kind === 'done') {
        if (act.status === 'cancelled') state = L.cancelNow(state, host.now());
        else if (act.status === 'failed' && state.status === 'running')
          state = L.stopRun(state, act.code ?? 'stopped', host.now());
        return this.finish(host, state, art, persist);
      }

      const step = act.step;
      // a model step reserves its estimated tokens BEFORE it calls anything
      const est =
        (step === 'file_generation' && env.modelBacked.file_generation) ||
        (step === 'repair' && env.modelBacked.repair)
          ? L.STEP_DEFS[step].estTokens
          : 0;
      const cap = Math.min(state.limits.maxTokens, host.budget.maxTokens ?? Infinity);
      if (est > 0 && state.tokensIn + state.tokensOut + est > cap) {
        state = L.stopRun(state, 'tokens_exceeded', host.now());
        return this.finish(host, state, art, persist);
      }

      state = L.beginStep(state, step, host.now());
      const stepId = await host.stepBegin(step, state.repairRound, act.attempt);
      await persist(`${step}:begin`);
      await host.emit('lifecycle_step', {
        step,
        status: 'started',
        round: state.repairRound,
        attempt: act.attempt,
      });

      const box = { state };
      let n = 0;
      const ctx: StepCtx = {
        host,
        env,
        state,
        art,
        step,
        ...(signal ? { signal } : {}),
        invoke: async (tool, args, fn) => {
          n += 1;
          const id = `${step}:r${state.repairRound}:a${act.attempt}:${n}`;
          const { invocation, authorization } = L.beginInvocation(
            id,
            { tool, step, caller: 'runner', actor: { permissions: host.permissions }, args },
            host.now(),
          );
          box.state = L.recordInvocation(box.state, invocation);
          if (!authorization.allowed)
            throw new StepFailure(authorization.code, authorization.reason);
          try {
            const r = await fn();
            let bytes = 0;
            try {
              bytes = JSON.stringify(r)?.length ?? 0;
            } catch {
              bytes = 0;
            }
            box.state = L.recordInvocation(
              box.state,
              L.finishInvocation(invocation, host.now(), { ok: true, resultBytes: bytes }),
            );
            return r;
          } catch (e) {
            box.state = L.recordInvocation(
              box.state,
              L.finishInvocation(invocation, host.now(), { ok: false, code: codeOf(e) }),
            );
            throw e;
          }
        },
      };

      let result: Awaited<ReturnType<(typeof STEP_FNS)[StepId]>> | null = null;
      let failure: string | null = null;
      let failureDetail: string | null = null;
      try {
        result = await STEP_FNS[step](ctx);
      } catch (e) {
        failure = codeOf(e);
        failureDetail = e instanceof StepFailure ? (e.detail ?? null) : null;
        if (!(e instanceof StepFailure) && !(e instanceof ProblemException))
          await host.audit('builder.lifecycle.step_error', 'failure', {
            step,
            name: e instanceof Error ? e.name : 'unknown',
          });
      }
      const usage = env.takeUsage();
      state = box.state;

      if (failure === 'cancelled') {
        await host.stepEnd(stepId, 'failed', { usage, code: 'cancelled' });
        state = L.cancelNow(L.recordUsage(state, step, usage), host.now());
        return this.finish(host, state, art, persist);
      }
      if (failure !== null) {
        await host.stepEnd(stepId, 'failed', { usage, code: failure });
        state = L.failStep(state, step, failure, host.now(), usage);
        const retry = state.steps[step].status === 'pending';
        await host.audit('builder.lifecycle.step_finished', 'failure', {
          step,
          code: failure,
          // fixed code names only (a preview error is a code, never file content)
          detail: failureDetail,
          attempt: act.attempt,
          retry,
          tokens: (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0),
        });
        await host.emit('lifecycle_step', {
          step,
          status: retry ? 'retry' : 'failed',
          code: failure,
          round: state.repairRound,
        });
        await persist(`${step}:${retry ? 'retry' : 'failed'}`);
        continue;
      }

      await host.stepEnd(stepId, 'succeeded', { usage });
      if (step === 'deployment_approval') {
        state = L.suspendForApproval(state, step, host.now());
        state = L.recordUsage(state, step, usage);
        await host.setRunState('waiting_approval');
        await host.audit('builder.lifecycle.step_finished', 'success', {
          step,
          attempt: act.attempt,
          approvalId: art.approvalId ?? null,
        });
        await host.emit('lifecycle_step', {
          step,
          status: 'waiting_approval',
          approvalId: art.approvalId ?? null,
        });
        await persist(`${step}:waiting`);
        continue;
      }
      state = L.completeStep(
        state,
        step,
        {
          ...(result!.passed === undefined ? {} : { passed: result!.passed }),
          summary: result!.summary,
          usage,
        },
        host.now(),
      );
      await host.audit('builder.lifecycle.step_finished', 'success', {
        step,
        attempt: act.attempt,
        round: state.repairRound,
        passed: result!.passed ?? null,
        tokens: (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0),
      });
      await host.emit('lifecycle_step', {
        step,
        status: 'succeeded',
        summary: result!.summary,
        passed: result!.passed ?? null,
        round: state.repairRound,
        progress: L.progress(state),
      });
      await persist(`${step}:done`);
    }
    state = L.stopRun(state, 'steps_exceeded', host.now());
    return this.finish(host, state, art, (s) => host.save(state, art, s));
  }

  /** The decision of the deployment approval, as the inbox has it: `null` = still open. A denied or expired approval ends the lifecycle without a failure (the project was built). */
  private async settleApproval(
    host: LifecycleHost,
    env: LifecycleEnv,
    state: LifecycleState,
    art: LifecycleArtifacts,
  ): Promise<LifecycleState | null> {
    const id = art.approvalId;
    if (!id) return L.resolveApproval(state, 'deployment_approval', 'denied', host.now());
    const st = await env.deployApprovalStatus(id);
    if (st === 'pending') return null;
    await host.audit('builder.lifecycle.deployment_decided', 'success', {
      approvalId: id,
      decision: st,
    });
    await host.emit('lifecycle_step', {
      step: 'deployment_approval',
      status: st === 'approved' ? 'succeeded' : 'denied',
      decision: st,
    });
    return L.resolveApproval(
      state,
      'deployment_approval',
      st === 'approved' ? 'approved' : 'denied',
      host.now(),
    );
  }

  private async finish(
    host: LifecycleHost,
    state: LifecycleState,
    art: LifecycleArtifacts,
    persist: (step: string) => Promise<void>,
  ): Promise<LifecycleOutcome> {
    await persist(`lifecycle:${state.status}`);
    await host.emit('lifecycle_finished', {
      status: state.status,
      code: state.failure?.code ?? null,
      progress: L.progress(state),
    });
    await host.audit(
      'builder.lifecycle.finished',
      state.status === 'succeeded' ? 'success' : 'failure',
      {
        status: state.status,
        code: state.failure?.code ?? null,
        step: state.failure?.step ?? null,
        repairRounds: state.repairRound,
        steps: state.stepRuns,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        credits: state.credits,
      },
    );
    return { status: state.status, state, artifacts: art };
  }
}
