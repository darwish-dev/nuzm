'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Icon, Input } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  clientPasswordIssue,
  passwordIssueKey,
  problemCode,
  problemField,
  safeNext,
} from '../lib/auth';

const form = { maxInlineSize: 420 } as const;

/**
 * False until the page is interactive. Submit buttons stay disabled until then, and every form is `method="post"`,
 * so a submit before hydration (or with scripts blocked) can never put a password into the URL, the history or a server log.
 */
function useReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

function FormError({ text }: { text?: string }) {
  return text ? (
    <p role="alert" className="nz-error-text">
      {text}
    </p>
  ) : null;
}

/** Email + password sign-in (ADR-008). A failure never says which of the two was wrong. */
export function LoginForm({ locale, next }: { locale: Locale; next?: string }) {
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ready = useReady();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    const r = await browserApi().POST('/v1/auth/password/login', {
      body: { email: String(f.get('email')), password: String(f.get('password')) },
    });
    if (r.response.ok) return window.location.assign(safeNext(next, `/${locale}`));
    setBusy(false);
    setErr(
      t(
        locale,
        r.response.status === 401
          ? 'login.invalid'
          : r.response.status === 429
            ? 'login.rate'
            : 'state.error.title',
      ),
    );
  }
  return (
    <form method="post" onSubmit={submit} style={form} aria-label={t(locale, 'login.title')}>
      <Field id="email" label={t(locale, 'field.email')}>
        {(a) => (
          <Input name="email" type="email" required autoComplete="username" dir="ltr" {...a} />
        )}
      </Field>
      <Field id="password" label={t(locale, 'field.password')}>
        {(a) => (
          <Input
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
            dir="ltr"
            {...a}
          />
        )}
      </Field>
      <FormError text={err} />
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'action.signin')}
      </Button>
    </form>
  );
}

export function RegisterForm({ locale }: { locale: Locale }) {
  const [err, setErr] = useState<{ email?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const ready = useReady();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password'));
    const issue = clientPasswordIssue(password, email);
    if (issue) return setErr({ password: t(locale, passwordIssueKey(issue)) });
    setBusy(true);
    setErr({});
    const name = String(f.get('displayName') ?? '').trim();
    const r = await browserApi().POST('/v1/auth/register', {
      body: { email, password, locale, ...(name ? { displayName: name } : {}) },
    });
    if (r.response.ok) return window.location.assign(`/${locale}/orgs/new`);
    setBusy(false);
    const code = problemCode(r.error);
    if (code === 'email_in_use') return setErr({ email: t(locale, 'register.exists') });
    if (code === 'weak_password') return setErr({ password: t(locale, 'password.err.weak') });
    if (code === 'validation_failed' && problemField(r.error, 'email'))
      return setErr({ email: t(locale, 'register.email') });
    setErr({
      form: t(locale, r.response.status === 429 ? 'login.rate' : 'state.error.title'),
    });
  }
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      style={form}
      aria-label={t(locale, 'register.title')}
    >
      <Field id="displayName" label={t(locale, 'field.displayName')}>
        {(a) => <Input name="displayName" maxLength={120} autoComplete="name" {...a} />}
      </Field>
      <Field id="email" label={t(locale, 'field.email')} error={err.email}>
        {(a) => <Input name="email" type="email" required autoComplete="email" dir="ltr" {...a} />}
      </Field>
      <Field
        id="password"
        label={t(locale, 'field.password')}
        help={t(locale, 'password.help')}
        error={err.password}
      >
        {(a) => (
          <Input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            dir="ltr"
            {...a}
          />
        )}
      </Field>
      <FormError text={err.form} />
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'register.submit')}
      </Button>
    </form>
  );
}

export function ForgotForm({ locale }: { locale: Locale }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = useReady();
  const [err, setErr] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    const r = await browserApi().POST('/v1/auth/password/forgot', {
      body: { email: String(f.get('email')) },
    });
    setBusy(false);
    if (r.response.status === 202) return setDone(true);
    setErr(t(locale, r.response.status === 429 ? 'login.rate' : 'state.error.title'));
  }
  if (done)
    return (
      <p role="status" style={form}>
        {t(locale, 'forgot.done')}
      </p>
    );
  return (
    <form method="post" onSubmit={submit} style={form} aria-label={t(locale, 'forgot.title')}>
      <Field id="email" label={t(locale, 'field.email')}>
        {(a) => <Input name="email" type="email" required autoComplete="email" dir="ltr" {...a} />}
      </Field>
      <FormError text={err} />
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'forgot.submit')}
      </Button>
    </form>
  );
}

export function ResetForm({ locale, token }: { locale: Locale; token: string }) {
  const [state, setState] = useState<'form' | 'done'>('form');
  const [err, setErr] = useState<{ password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const ready = useReady();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password'));
    const issue = clientPasswordIssue(password);
    if (issue) return setErr({ password: t(locale, passwordIssueKey(issue)) });
    setBusy(true);
    setErr({});
    const r = await browserApi().POST('/v1/auth/password/reset', {
      body: { token, newPassword: password },
    });
    setBusy(false);
    if (r.response.status === 204) return setState('done');
    const code = problemCode(r.error);
    if (code === 'weak_password') return setErr({ password: t(locale, 'password.err.weak') });
    setErr({ form: t(locale, code === 'invalid_token' ? 'reset.invalid' : 'state.error.title') });
  }
  if (state === 'done')
    return (
      <div style={form}>
        <p role="status">{t(locale, 'reset.done')}</p>
        <a className="nz-btn" data-variant="primary" href={`/${locale}/login`}>
          {t(locale, 'action.signin')}
        </a>
      </div>
    );
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      style={form}
      aria-label={t(locale, 'reset.title')}
    >
      <Field
        id="password"
        label={t(locale, 'field.passwordNew')}
        help={t(locale, 'password.help')}
        error={err.password}
      >
        {(a) => (
          <Input
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="new-password"
            dir="ltr"
            {...a}
          />
        )}
      </Field>
      <FormError text={err.form} />
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'reset.submit')}
      </Button>
    </form>
  );
}

/** Confirms the address from the emailed link. A token is single use, so it runs once (guarded against double effects). */
export function VerifyEmail({ locale, token }: { locale: Locale; token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'invalid'>('working');
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void browserApi()
      .POST('/v1/auth/email/verification', { body: { token } })
      .then((r) => setState(r.response.status === 204 ? 'done' : 'invalid'));
  }, [token]);
  return (
    <div style={form} role="status" aria-live="polite">
      {state === 'working' && <p>{t(locale, 'verify.working')}</p>}
      {state === 'done' && (
        <>
          <p>{t(locale, 'verify.done')}</p>
          <a className="nz-btn" data-variant="primary" href={`/${locale}`}>
            {t(locale, 'verify.continue')}
          </a>
        </>
      )}
      {state === 'invalid' && <p className="nz-error-text">{t(locale, 'verify.invalid')}</p>}
    </div>
  );
}

/** Shown in the console's top bar while the signed-in address is unconfirmed (one row with the rest of the bar). */
export function VerifyEmailPill({ locale }: { locale: Locale }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function resend() {
    setBusy(true);
    const r = await browserApi().POST('/v1/auth/email/verification/resend', {});
    setBusy(false);
    if (r.response.status === 202) setSent(true);
    if (r.response.status === 204) window.location.reload();
  }
  return (
    <div className="nzc-pill" role="status">
      <Icon name="email" size={18} />
      <span className="nzc-pill-text">
        {sent ? t(locale, 'verify.resent') : t(locale, 'verify.banner')}
      </span>
      {!sent && (
        <button type="button" onClick={resend} disabled={busy}>
          {t(locale, 'verify.resend')}
        </button>
      )}
    </div>
  );
}

export function ChangePasswordForm({ locale, email }: { locale: Locale; email: string }) {
  const [err, setErr] = useState<{ current?: string; next?: string; form?: string }>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = useReady();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = String(f.get('next'));
    const issue = clientPasswordIssue(next, email);
    if (issue) return setErr({ next: t(locale, passwordIssueKey(issue)) });
    setBusy(true);
    setErr({});
    setDone(false);
    const r = await browserApi().POST('/v1/auth/password/change', {
      body: { currentPassword: String(f.get('current')), newPassword: next },
    });
    setBusy(false);
    if (r.response.status === 204) {
      (e.target as HTMLFormElement).reset?.();
      return setDone(true);
    }
    const code = problemCode(r.error);
    if (code === 'invalid_credentials') return setErr({ current: t(locale, 'pw.change.wrong') });
    if (code === 'weak_password') return setErr({ next: t(locale, 'password.err.weak') });
    if (r.response.status === 403) return setErr({ form: t(locale, 'pw.change.noPassword') });
    setErr({ form: t(locale, 'state.error.title') });
  }
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      style={form}
      aria-label={t(locale, 'pw.change.title')}
    >
      <Field id="current" label={t(locale, 'field.passwordCurrent')} error={err.current}>
        {(a) => (
          <Input
            name="current"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
            dir="ltr"
            {...a}
          />
        )}
      </Field>
      <Field
        id="next"
        label={t(locale, 'field.passwordNew')}
        help={t(locale, 'password.help')}
        error={err.next}
      >
        {(a) => (
          <Input
            name="next"
            type="password"
            required
            maxLength={128}
            autoComplete="new-password"
            dir="ltr"
            {...a}
          />
        )}
      </Field>
      <FormError text={err.form} />
      {done && <p role="status">{t(locale, 'pw.change.done')}</p>}
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'pw.change.submit')}
      </Button>
    </form>
  );
}
