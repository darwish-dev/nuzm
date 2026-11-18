'use client';
import { useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Ltr } from '@nuzm/ui';
import { problemCode, problemDetail, problemTrace, isPlaceholderText } from '../lib/compliance';
import { useStepUp } from './StepUp';

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
export function useCompliance(locale: Locale, factorId: string | null) {
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
            ? t(locale, 'compliance.err.notFound')
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

/** Marks counsel-owned text that is still a placeholder: visible, never hidden. */
export const PendingReview = ({ locale }: { locale: Locale }) => (
  <Badge tone="warn">{t(locale, 'compliance.pendingReview')}</Badge>
);
/** The PROPOSAL marker of values awaiting owner sign-off (HG-04-01). */
export const Proposal = ({ locale }: { locale: Locale }) => (
  <Badge tone="warn">{t(locale, 'compliance.proposal')}</Badge>
);

/** A localized text from the API (`{code, en, ar}` or a plain placeholder string): shown, with the marker when it is a counsel placeholder. */
export function CounselText(p: { locale: Locale; en?: string; ar?: string }) {
  const own = (p.locale === 'ar' ? p.ar : p.en) ?? '';
  const pending = isPlaceholderText(own);
  const shown = pending ? (p.en ?? own) : own;
  return (
    <span>
      <span lang={pending ? 'en' : p.locale} dir={pending ? 'ltr' : undefined}>
        {shown}
      </span>{' '}
      {(pending || isPlaceholderText(p.en)) && <PendingReview locale={p.locale} />}
    </span>
  );
}

/** A SHA-256 digest, complete (never truncated: it is evidence) and wrap-safe. */
export const Hash = ({ value }: { value: string }) => (
  <code dir="ltr" style={{ overflowWrap: 'anywhere', fontSize: '0.85em' }}>
    {value}
  </code>
);

export const Kv = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="nz-row">
    <dt className="nz-muted" style={{ minInlineSize: '12rem' }}>
      {label}
    </dt>
    <dd style={{ margin: 0 }}>{children}</dd>
  </div>
);

/** A pretty-printed JSON value (LTR), for evidence summaries and packs whose shape the API leaves open. */
export const Json = ({ value, label }: { value: unknown; label: string }) => (
  <pre
    dir="ltr"
    tabIndex={0}
    aria-label={label}
    style={{
      overflow: 'auto',
      maxBlockSize: '20rem',
      background: 'var(--nuzm-color-surface)',
      padding: 'var(--nuzm-space-3)',
      borderRadius: 'var(--nuzm-radius-sm)',
    }}
  >
    {JSON.stringify(value, null, 2)}
  </pre>
);
