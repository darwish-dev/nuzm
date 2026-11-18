'use client';
import { useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import {
  approvalsOf,
  builderError,
  fieldProblems,
  problemOf,
  settle,
  type ApprovalRef,
  type FieldProblem,
  type Res,
} from '../lib/builder';
import { newKey, type ProblemInfo } from '../lib/data';
import type { DataNotice } from './DataUi';
import { useStepUp } from './StepUp';

export { newKey };

/** What the last failed call said, beyond the plain message: the problem, the approvals it asked for and its field errors. */
export interface Failure {
  problem: ProblemInfo;
  approvals: ApprovalRef[];
  fields: FieldProblem[];
}

/**
 * Run a mutation of the app-builder screens: busy flag, plain-language error in the user's language (`builderError`), offline detection (a network failure is
 * status 0, never an unhandled rejection) and MFA step-up (the call is retried after a correct code). `onError` may claim a failure for the screen.
 */
export function useBuilderCall(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DataNotice>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function run<T>(
    call: () => Promise<Res<T>>,
    onOk: (data: T) => void,
    onError?: (f: Failure) => boolean | void,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    const r = await settle(call);
    setBusy(false);
    if (r.response.ok) return onOk(r.data as T);
    const problem = problemOf(r);
    const f: Failure = { problem, approvals: approvalsOf(r.error), fields: fieldProblems(r.error) };
    setFailure(f);
    if (problem.code === 'step_up_required') {
      if (factorId) return step.ask(() => void run(call, onOk, onError));
      return setNotice({ tone: 'error', text: t(locale, 'm8.err.stepUpNoFactor') });
    }
    if (onError?.(f) === true) return;
    const e = builderError(locale, problem);
    setNotice({ tone: 'error', text: e.text, detail: e.detail });
  }
  return { run, busy, notice, setNotice, failure, setFailure, panel: step.panel };
}
