'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button } from '@nuzm/ui';
import { dataError, problemOf, type ProblemInfo } from '../lib/data';
import { useStepUp } from './StepUp';

/** A message for the user plus, for an unsupported option, the service's own reason. */
export type DataNotice = { tone: 'error' | 'ok'; text: string; detail?: string } | null;

export function Note({ n }: { n: DataNotice }) {
  if (!n) return null;
  return (
    <div role={n.tone === 'error' ? 'alert' : 'status'}>
      <p className={n.tone === 'error' ? 'nz-error-text' : ''}>{n.text}</p>
      {n.detail && (
        <p className="nz-muted">
          <bdi dir="auto">{n.detail}</bdi>
        </p>
      )}
    </div>
  );
}

interface Res<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Run a mutation of the data and email screens: busy flag, plain-language error (with the service's reason for an unsupported option), and MFA step-up
 * (the call is retried after a correct code; a user with no enrolled factor is told to enrol one). `onError` may claim a failure for the screen.
 */
export function useCall(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DataNotice>(null);
  const [last, setLast] = useState<ProblemInfo | null>(null);

  async function run<T>(
    call: () => Promise<Res<T>>,
    onOk: (data: T) => void,
    onError?: (p: ProblemInfo) => boolean | void,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    setLast(null);
    const r = await call();
    setBusy(false);
    if (r.response.ok) return onOk(r.data as T);
    const p = problemOf(r);
    setLast(p);
    if (p.code === 'step_up_required') {
      if (factorId) return step.ask(() => void run(call, onOk, onError));
      return setNotice({ tone: 'error', text: t(locale, 'm8.err.stepUpNoFactor') });
    }
    if (onError?.(p) === true) return;
    const e = dataError(locale, p);
    setNotice({ tone: 'error', text: e.text, detail: e.detail });
  }
  return { run, busy, notice, setNotice, last, panel: step.panel };
}

/**
 * Modal confirmation on the native `<dialog>` element (focus is trapped and Escape closes it, no custom keyboard code). Content is rendered only
 * while open so a typed confirmation never lingers.
 */
export function ConfirmDialog(p: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (p.open && !d.open) d.showModal();
    if (!p.open && d.open) d.close();
  }, [p.open]);
  return (
    <dialog
      ref={ref}
      aria-label={p.title}
      onClose={p.onClose}
      onCancel={p.onClose}
      className="nz-card"
      style={{ maxInlineSize: 520, inlineSize: '92vw' }}
    >
      {p.open && (
        <>
          <h2 className="nz-h2">{p.title}</h2>
          {p.children}
        </>
      )}
    </dialog>
  );
}

/** Copy text to the clipboard and say so (nothing is stored). */
export function CopyButton({
  locale,
  text,
  label,
}: {
  locale: Locale;
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setDone(true))
            .catch(() => setDone(false));
        }}
      >
        {t(locale, 'action.copy')}
      </Button>
      <span role="status" className="nz-muted">
        {done ? t(locale, 'm8.c.copied') : ''}
      </span>
    </>
  );
}
