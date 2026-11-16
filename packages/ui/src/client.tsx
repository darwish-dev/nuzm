'use client';
import QRCode from 'qrcode';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input, Ltr } from './components';

/** Client-side widgets. They receive strings and callbacks, never fetch on their own. */

export function LocaleSwitch({
  current,
  locales,
  labels,
}: {
  current: string;
  locales: string[];
  labels: Record<string, string>;
}) {
  const path = usePathname() ?? `/${current}`;
  return (
    <span>
      {locales
        .filter((l) => l !== current)
        .map((l) => (
          <a
            key={l}
            href={path.replace(new RegExp(`^/${current}(?=/|$)`), `/${l}`)}
            lang={l}
            hrefLang={l}
          >
            {labels[l]}
          </a>
        ))}
    </span>
  );
}

export interface MfaEnrolProps {
  labels: {
    intro: string;
    start: string;
    qr: string;
    manualKey: string;
    code: string;
    verify: string;
    done: string;
    errorCode: string;
    errorGeneric: string;
  };
  start: () => Promise<{ id: string; secret: string; otpauthUri: string }>;
  verify: (id: string, code: string) => Promise<'ok' | 'bad_code' | 'locked'>;
  onDone?: () => void;
  lockedMessage: string;
}

/** TOTP enrolment: the secret is shown once (QR + manual key); nothing is stored in the browser. */
export function MfaEnrol(p: MfaEnrolProps): ReactNode {
  const [pending, setPending] = useState<{ id: string; secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending) void QRCode.toDataURL(pending.uri, { margin: 1, width: 192 }).then(setQr);
  }, [pending]);

  async function begin() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await p.start();
      setPending({ id: r.id, secret: r.secret, uri: r.otpauthUri });
    } catch {
      setMsg({ kind: 'error', text: p.labels.errorGeneric });
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    try {
      const r = await p.verify(pending!.id, code);
      if (r === 'ok') {
        setPending(null);
        setMsg({ kind: 'ok', text: p.labels.done });
        p.onDone?.();
      } else setMsg({ kind: 'error', text: r === 'locked' ? p.lockedMessage : p.labels.errorCode });
    } catch {
      setMsg({ kind: 'error', text: p.labels.errorGeneric });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>{p.labels.intro}</p>
      {!pending && !(msg?.kind === 'ok') && (
        <Button onClick={begin} disabled={busy}>
          {p.labels.start}
        </Button>
      )}
      {pending && (
        <form onSubmit={submit} noValidate>
          {qr && <img src={qr} width={192} height={192} alt={p.labels.qr} />}
          <p>
            {p.labels.manualKey}: <Ltr>{pending.secret}</Ltr>
          </p>
          <Field
            id="code"
            label={p.labels.code}
            error={msg?.kind === 'error' ? msg.text : undefined}
          >
            {(a) => (
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                {...a}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy}>
            {p.labels.verify}
          </Button>
        </form>
      )}
      {!pending && msg && (
        <p
          role={msg.kind === 'error' ? 'alert' : 'status'}
          className={msg.kind === 'error' ? 'nz-error-text' : ''}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

export interface MfaChallengeProps {
  labels: { code: string; verify: string; errorCode: string; errorGeneric: string; locked: string };
  verify: (code: string) => Promise<'ok' | 'bad_code' | 'locked'>;
  onDone: () => void;
}

/** Answer an MFA challenge (admin sign-in, or a step-up) with a code from the enrolled factor. */
export function MfaChallenge(p: MfaChallengeProps): ReactNode {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    setError('');
    try {
      const r = await p.verify(code);
      if (r === 'ok') return p.onDone();
      setError(r === 'locked' ? p.labels.locked : p.labels.errorCode);
    } catch {
      setError(p.labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      <Field id="challenge-code" label={p.labels.code} error={error || undefined}>
        {(a) => (
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            {...a}
          />
        )}
      </Field>
      <Button type="submit" disabled={busy}>
        {p.labels.verify}
      </Button>
    </form>
  );
}

export interface StepUpLabels {
  title: string;
  body: string;
  challenge: MfaChallengeProps['labels'];
}

/**
 * Step-up gate for sensitive actions. `ask(retry)` shows the MFA challenge; after a correct code the original action
 * is retried. `verify` answers the challenge with the caller's enrolled factor (the app supplies the SDK call).
 */
export function useStepUp(
  labels: StepUpLabels,
  factorId: string | null,
  verify: (factorId: string, code: string) => Promise<'ok' | 'bad_code' | 'locked'>,
) {
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const panel: ReactNode = retry && factorId && (
    <section aria-label={labels.title} className="nz-card">
      <h3>{labels.title}</h3>
      <p>{labels.body}</p>
      <MfaChallenge
        labels={labels.challenge}
        verify={(code) => verify(factorId, code)}
        onDone={() => {
          const go = retry;
          setRetry(null);
          go();
        }}
      />
    </section>
  );
  return { panel, ask: (fn: () => void) => setRetry(() => fn), available: factorId !== null };
}
