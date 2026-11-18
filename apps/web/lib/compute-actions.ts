'use client';
import { useState } from 'react';
import type { Locale } from '@nuzm/i18n';
import { useAction } from './actions';
import { problemOf, type CallResult, type ComputeProblem } from './compute';

/**
 * `useAction` (busy state, MFA step-up retry) plus the problem+json of the last failure, so a screen can map the CODE
 * (quote_expired, residency_denied, ...) to its own message. The generic notice of `useAction` stays for unmapped statuses.
 */
export function useComputeAction(locale: Locale, factorId: string | null) {
  const a = useAction(locale, factorId);
  const [problem, setProblem] = useState<ComputeProblem | null>(null);
  async function run<T>(call: () => Promise<CallResult<T>>, onOk: (data: T) => void) {
    setProblem(null);
    await a.run(async () => {
      const r = await call();
      // a step-up challenge is answered by `useAction` (the call is retried); every other failure is shown by its code
      if (r.response.ok || r.error?.code === 'step_up_required') setProblem(null);
      else setProblem(problemOf(r));
      return r;
    }, onOk);
  }
  return { ...a, run, problem, clearProblem: () => setProblem(null) };
}
