'use client';
import { useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Ltr } from '@nuzm/ui';
import { problemOf, type ProblemInfo } from '../lib/data';
import { issuesOf, m11Error, type Issue } from '../lib/m11';
import { CopyButton, type DataNotice } from './DataUi';
import { useStepUp } from './StepUp';

interface Res<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Run a mutation of the M11 screens: busy flag, plain-language error in the user's language (with the API's own reason for an unsupported capability), the 422 `errors[]` list
 * for inline display, and automatic MFA step-up (the call is retried after a correct code). `onError` may claim a failure for the screen by returning true.
 */
export function useM11Call(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DataNotice>(null);
  const [last, setLast] = useState<ProblemInfo | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);

  async function run<T>(
    call: () => Promise<Res<T>>,
    onOk: (data: T) => void,
    onError?: (p: ProblemInfo) => boolean | void,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    setLast(null);
    setIssues([]);
    let r: Res<T>;
    try {
      r = await call();
    } catch {
      setBusy(false);
      return setNotice({ tone: 'error', text: t(locale, 'state.error.title') });
    }
    setBusy(false);
    if (r.response.ok) return onOk(r.data as T);
    const p = problemOf(r);
    setLast(p);
    setIssues(issuesOf(r.error));
    if (p.code === 'step_up_required') {
      if (factorId) return step.ask(() => void run(call, onOk, onError));
      return setNotice({ tone: 'error', text: t(locale, 'm8.err.stepUpNoFactor') });
    }
    if (onError?.(p) === true) return;
    const e = m11Error(locale, p);
    setNotice({ tone: 'error', text: e.text, detail: e.detail });
  }
  return { run, busy, notice, setNotice, last, issues, panel: step.panel };
}

/** The server's 422 `errors[]`, shown next to the form that was refused (code, path, message). */
export function IssueList({
  locale,
  issues,
  title,
}: {
  locale: Locale;
  issues: Issue[];
  title?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <div role="alert">
      <p className="nz-error-text">{title ?? t(locale, 'm11.issues.title')}</p>
      <ul>
        {issues.map((i, n) => (
          <li key={`${i.code}|${i.path}|${n}`}>
            <Ltr>{i.path}</Ltr> <strong>{i.code}</strong>{' '}
            {i.message && <bdi dir="auto">{i.message}</bdi>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A secret the API returns exactly once: shown with a copy button until the person confirms they stored it, then removed from the screen (and from memory). */
export function SecretOnce({
  locale,
  label,
  value,
  extra,
  onDone,
}: {
  locale: Locale;
  label: string;
  value: string;
  extra?: ReactNode;
  onDone: () => void;
}) {
  return (
    <section className="nz-card" role="alert" aria-label={label}>
      <h3 className="nz-h2">{label}</h3>
      <p className="nz-error-text">{t(locale, 'm11.secret.once')}</p>
      {extra}
      <p className="nz-row">
        <code dir="ltr" data-testid="secret-value" style={{ wordBreak: 'break-all' }}>
          {value}
        </code>
        <CopyButton locale={locale} text={value} label={t(locale, 'm11.secret.copy')} />
      </p>
      <Button onClick={onDone}>{t(locale, 'm11.secret.stored')}</Button>
    </section>
  );
}

/** A pretty-printed JSON value in a scrollable, focusable block (so keyboard users can scroll it). Always left-to-right. */
export function JsonBlock({ value, label }: { value: string; label: string }) {
  return (
    <pre
      dir="ltr"
      tabIndex={0}
      aria-label={label}
      className="nz-card"
      style={{
        overflow: 'auto',
        maxBlockSize: 320,
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '.85rem',
      }}
    >
      {value}
    </pre>
  );
}
