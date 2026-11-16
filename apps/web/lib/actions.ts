'use client';
import { useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { useStepUp } from '../components/StepUp';

interface Res<T> {
  data?: T;
  error?: unknown;
  response: Response;
}
export type Notice = { tone: 'error' | 'ok'; text: string } | null;

/** Message for a failed call (status/code → localized text); `overrides` lets a screen name its own conflicts. */
export function errorText(
  locale: Locale,
  status: number,
  code: string | undefined,
  overrides: Partial<Record<number, string>> = {},
): string {
  if (overrides[status]) return overrides[status]!;
  if (status === 412) return t(locale, 'settings.conflict');
  if (status === 409) return t(locale, 'err.conflict');
  if (status === 422) return t(locale, 'err.validation');
  if (status === 403 && code === 'org_suspended') return t(locale, 'state.suspended.title');
  if (status === 403) return t(locale, 'state.forbidden.title');
  return t(locale, 'state.error.title');
}

/**
 * Run a mutation: busy state, localized error notice, and automatic MFA step-up (the call is retried after a
 * correct code). `panel` must be rendered by the caller.
 */
export function useAction(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function run<T>(
    call: () => Promise<Res<T>>,
    onOk: (data: T) => void,
    overrides: Partial<Record<number, string>> = {},
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    const r = await call();
    setBusy(false);
    if (r.response.ok) return onOk(r.data as T);
    const code = (r.error as { code?: string } | undefined)?.code;
    if (code === 'step_up_required' && factorId)
      return step.ask(() => void run(call, onOk, overrides));
    setNotice({ tone: 'error', text: errorText(locale, r.response.status, code, overrides) });
  }
  return { run, busy, notice, setNotice, panel: step.panel };
}
