'use client';
import { useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { isLocale, t, type Locale } from '@nuzm/i18n';
import { Ltr, Skeleton } from '@nuzm/ui';
import { useStepUp } from './StepUp';

/** Problem+json helpers (same shape as the API's problem responses). */
interface Problem {
  code?: string;
  detail?: string;
  traceId?: string;
}
const problemCode = (p: unknown): string | undefined => (p as Problem | null | undefined)?.code;
const problemDetail = (p: unknown): string | undefined => (p as Problem | null | undefined)?.detail;
const problemTrace = (p: unknown): string | undefined => (p as Problem | null | undefined)?.traceId;

export type Notice = { tone: 'error' | 'ok'; text: string } | null;
export interface Res {
  response: Response;
  data?: unknown;
  error?: unknown;
}
/** Messages for a failed call, looked up by problem `code` first, then by HTTP status. */
export type Overrides = Record<string, string>;

/**
 * Run a staff mutation: busy flag, localized error (by problem code, then status), the server's own explanation and trace id, and an MFA
 * step-up prompt when the API asks for one (the call is retried after a correct code).
 */
export function useStaffAction(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState<unknown>(null);
  async function run(
    call: () => Promise<Res>,
    onOk: (data?: unknown) => void,
    overrides: Overrides = {},
  ) {
    setBusy(true);
    setNotice(null);
    setProblem(null);
    const r = await call();
    setBusy(false);
    if (r.response.ok) return onOk(r.data);
    const code = problemCode(r.error);
    if (code === 'step_up_required' && factorId)
      return step.ask(() => void run(call, onOk, overrides));
    const s = r.response.status;
    setProblem(r.error ?? null);
    setNotice({
      tone: 'error',
      text:
        (code ? overrides[code] : undefined) ??
        overrides[String(s)] ??
        (s === 403
          ? t(locale, 'state.forbidden.title')
          : s === 404
            ? t(locale, 'state.error.title')
            : s === 409
              ? t(locale, 'err.conflict')
              : s === 422
                ? t(locale, 'err.validation')
                : t(locale, 'state.error.title')),
    });
  }
  return { run, busy, notice, setNotice, problem, panel: step.panel };
}

/** The outcome line of a mutation: localized text, then the server's explanation and the trace id for an error. */
export function Result(p: { n: Notice; problem?: unknown; locale: Locale }) {
  if (!p.n) return null;
  const detail = problemDetail(p.problem);
  const trace = problemTrace(p.problem);
  return (
    <div role={p.n.tone === 'error' ? 'alert' : 'status'}>
      <p className={p.n.tone === 'error' ? 'nz-error-text' : ''}>{p.n.text}</p>
      {p.n.tone === 'error' && detail && (
        <p className="nz-muted">
          <Ltr>{detail}</Ltr>
        </p>
      )}
      {p.n.tone === 'error' && trace && (
        <p className="nz-muted">{t(p.locale, 'state.error.trace', { traceId: trace })}</p>
      )}
    </div>
  );
}

export const Kv = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="nz-row">
    <dt className="nz-muted" style={{ minInlineSize: '12rem' }}>
      {label}
    </dt>
    <dd style={{ margin: 0 }}>{children}</dd>
  </div>
);

/** Loading state of the provider screens, announced in the page's own language. */
export function ProviderLoading() {
  const { locale } = useParams<{ locale: string }>();
  return <Skeleton lines={4} label={t(isLocale(locale) ? locale : 'ar', 'state.loading')} />;
}
