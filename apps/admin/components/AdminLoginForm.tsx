'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input } from '@nuzm/ui';
import { browserApi } from '../lib/client';

/**
 * Staff sign-in with email and password (ADR-008 amendment). A failure never says which part was wrong. Success goes to the console,
 * whose gate then asks for two-factor verification before anything opens. The submit button stays disabled until the page is
 * interactive and the form is `method="post"`, so a submit without scripts can never put the password in the URL.
 */
export function AdminLoginForm({ locale, next }: { locale: Locale; next: string }) {
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    const r = await browserApi().POST('/v1/auth/password/login', {
      body: { email: String(f.get('email')), password: String(f.get('password')), realm: 'admin' },
    });
    if (r.response.ok) return window.location.assign(next);
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
    <form method="post" onSubmit={submit} aria-label={t(locale, 'login.admin.title')}>
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
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <Button type="submit" disabled={busy || !ready}>
        {t(locale, 'action.signin')}
      </Button>
    </form>
  );
}
