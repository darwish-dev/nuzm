'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { browserApi } from '../lib/client';
import { creditRequest } from '../lib/admin-tools';
import { useStepUp } from './StepUp';

type Notice = { tone: 'ok' | 'error'; text: string } | null;
const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

function NoticeLine({ n }: { n: Notice }) {
  if (!n) return null;
  return (
    <p
      role={n.tone === 'error' ? 'alert' : 'status'}
      className={n.tone === 'error' ? 'nz-error-text' : undefined}
    >
      {n.text}
    </p>
  );
}

/** "Create a customer account": email, optional name, language and password. A generated temporary password is shown once. */
export function CreateUserForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const step = useStepUp(locale, mfaFactorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [temp, setTemp] = useState<string | null>(null);

  async function send(
    body: { email: string; displayName?: string; locale: 'ar' | 'en'; password?: string },
    form: HTMLFormElement,
  ) {
    setBusy(true);
    setNotice(null);
    setTemp(null);
    const r = await browserApi().POST('/v1/admin/users', { body });
    setBusy(false);
    if (!r.response.ok) {
      const code = codeOf(r.error);
      if (code === 'step_up_required' && mfaFactorId) return step.ask(() => void send(body, form));
      return setNotice({
        tone: 'error',
        text: t(
          locale,
          code === 'email_in_use'
            ? 'admin.users.create.inUse'
            : r.response.status === 422
              ? 'admin.users.create.invalid'
              : 'state.error.title',
        ),
      });
    }
    const d = r.data as { email: string; temporaryPassword?: string };
    form.reset();
    setNotice({ tone: 'ok', text: t(locale, 'admin.users.create.done', { email: d.email }) });
    setTemp(d.temporaryPassword ?? null);
    router.refresh();
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('displayName') ?? '').trim();
    const password = String(f.get('password') ?? '');
    void send(
      {
        email: String(f.get('email') ?? '').trim(),
        ...(name ? { displayName: name } : {}),
        locale: f.get('locale') === 'en' ? 'en' : 'ar',
        ...(password ? { password } : {}),
      },
      e.currentTarget,
    );
  }
  return (
    <section className="nz-card nz-admin-tool" aria-labelledby="cu-title">
      <h2 id="cu-title">{t(locale, 'admin.users.create.title')}</h2>
      <p className="nz-muted">{t(locale, 'admin.users.create.intro')}</p>
      <form onSubmit={submit} noValidate className="nzc-form-grid">
        <Field id="cu-email" label={t(locale, 'admin.users.create.email')}>
          {(a) => <Input name="email" type="email" required dir="ltr" autoComplete="off" {...a} />}
        </Field>
        <Field id="cu-name" label={t(locale, 'admin.users.create.name')}>
          {(a) => <Input name="displayName" maxLength={120} autoComplete="off" {...a} />}
        </Field>
        <Field id="cu-locale" label={t(locale, 'admin.users.create.locale')}>
          {(a) => (
            <Select name="locale" defaultValue={locale} {...a}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          )}
        </Field>
        <Field id="cu-password" label={t(locale, 'admin.users.create.password')}>
          {(a) => (
            <Input
              name="password"
              type="password"
              minLength={12}
              dir="ltr"
              autoComplete="new-password"
              {...a}
            />
          )}
        </Field>
        <div className="nz-row nzc-span-2">
          <Button type="submit" disabled={busy}>
            {t(locale, 'admin.users.create.submit')}
          </Button>
        </div>
      </form>
      <NoticeLine n={notice} />
      {temp && (
        <p className="nz-admin-secret">
          {t(locale, 'admin.users.create.temp')} <code dir="ltr">{temp}</code>
        </p>
      )}
      {step.panel}
    </section>
  );
}

/** "Create an organization" for an existing customer (by email), who becomes its first owner. */
export function CreateOrgForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const step = useStepUp(locale, mfaFactorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  type Body = {
    name: string;
    ownerEmail: string;
    type: 'customer' | 'agency' | 'reseller';
    defaultLocale: 'ar' | 'en';
  };
  async function send(body: Body, form: HTMLFormElement) {
    setBusy(true);
    setNotice(null);
    const r = await browserApi().POST('/v1/admin/organizations', { body });
    setBusy(false);
    if (!r.response.ok) {
      const code = codeOf(r.error);
      if (code === 'step_up_required' && mfaFactorId) return step.ask(() => void send(body, form));
      const key =
        r.response.status === 404
          ? 'admin.orgs.create.noOwner'
          : r.response.status === 403
            ? 'admin.orgs.create.staffOwner'
            : r.response.status === 409
              ? 'admin.orgs.create.taken'
              : 'state.error.title';
      return setNotice({ tone: 'error', text: t(locale, key) });
    }
    form.reset();
    setNotice({ tone: 'ok', text: t(locale, 'admin.orgs.create.done', { name: body.name }) });
    router.refresh();
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const type = String(f.get('type'));
    void send(
      {
        name: String(f.get('name') ?? '').trim(),
        ownerEmail: String(f.get('ownerEmail') ?? '').trim(),
        type: type === 'agency' || type === 'reseller' ? type : 'customer',
        defaultLocale: f.get('defaultLocale') === 'en' ? 'en' : 'ar',
      },
      e.currentTarget,
    );
  }
  return (
    <section className="nz-card nz-admin-tool" aria-labelledby="co-title">
      <h2 id="co-title">{t(locale, 'admin.orgs.create.title')}</h2>
      <p className="nz-muted">{t(locale, 'admin.orgs.create.intro')}</p>
      <form onSubmit={submit} noValidate className="nzc-form-grid">
        <Field id="co-name" label={t(locale, 'admin.orgs.create.name')}>
          {(a) => <Input name="name" required maxLength={200} autoComplete="off" {...a} />}
        </Field>
        <Field id="co-owner" label={t(locale, 'admin.orgs.create.owner')}>
          {(a) => (
            <Input name="ownerEmail" type="email" required dir="ltr" autoComplete="off" {...a} />
          )}
        </Field>
        <Field id="co-type" label={t(locale, 'admin.orgs.create.type')}>
          {(a) => (
            <Select name="type" defaultValue="customer" {...a}>
              <option value="customer">{t(locale, 'org.type.customer')}</option>
              <option value="agency">{t(locale, 'org.type.agency')}</option>
              <option value="reseller">{t(locale, 'org.type.reseller')}</option>
            </Select>
          )}
        </Field>
        <Field id="co-locale" label={t(locale, 'admin.orgs.create.locale')}>
          {(a) => (
            <Select name="defaultLocale" defaultValue={locale} {...a}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          )}
        </Field>
        <div className="nz-row nzc-span-2">
          <Button type="submit" disabled={busy}>
            {t(locale, 'admin.orgs.create.submit')}
          </Button>
        </div>
      </form>
      <NoticeLine n={notice} />
      {step.panel}
    </section>
  );
}

/** "Add credit" on an organization: files a promotional-credit adjustment that a DIFFERENT staff member approves in Billing → Adjustments. */
export function AddCreditAction(p: {
  locale: Locale;
  mfaFactorId: string | null;
  orgId: string;
  orgName: string;
}) {
  const { locale } = p;
  const step = useStepUp(locale, p.mfaFactorId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function send(
    body: NonNullable<Extract<ReturnType<typeof creditRequest>, { body: unknown }>['body']>,
    key: string,
  ) {
    setBusy(true);
    setNotice(null);
    const r = await browserApi().POST('/v1/admin/billing/adjustments', {
      params: { header: { 'Idempotency-Key': key } },
      body,
    });
    setBusy(false);
    if (!r.response.ok) {
      if (codeOf(r.error) === 'step_up_required' && p.mfaFactorId)
        return step.ask(() => void send(body, key));
      return setNotice({
        tone: 'error',
        text: t(locale, r.response.status === 422 ? 'admin.credit.invalid' : 'state.error.title'),
      });
    }
    setNotice({
      tone: 'ok',
      text: t(locale, 'admin.credit.done', {
        id: (r.data as { id?: string } | undefined)?.id ?? '',
      }),
    });
    setOpen(false);
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const x = creditRequest(p.orgId, {
      amount: String(f.get('amount') ?? ''),
      reason: String(f.get('reason') ?? ''),
    });
    if ('error' in x) return setNotice({ tone: 'error', text: t(locale, 'admin.credit.invalid') });
    // one key per request: a retry after a timeout (same form, same key) returns the same request instead of filing a second one
    void send(x.body, crypto.randomUUID());
  }
  if (!open)
    return (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
            setNotice(null);
          }}
        >
          {t(locale, 'admin.credit.open')}
        </Button>
        <NoticeLine n={notice} />
      </>
    );
  return (
    <>
      <form
        onSubmit={submit}
        noValidate
        aria-label={t(locale, 'admin.credit.title', { name: p.orgName })}
        className="nz-admin-credit"
      >
        <p className="nz-muted">{t(locale, 'admin.credit.notice')}</p>
        <Field id={`cr-amount-${p.orgId}`} label={t(locale, 'admin.credit.amount')}>
          {(a) => (
            <Input name="amount" inputMode="decimal" required dir="ltr" autoComplete="off" {...a} />
          )}
        </Field>
        <Field id={`cr-reason-${p.orgId}`} label={t(locale, 'admin.credit.reason')}>
          {(a) => <Input name="reason" required minLength={3} maxLength={500} {...a} />}
        </Field>
        <NoticeLine n={notice} />
        <div className="nz-row">
          <Button type="submit" disabled={busy}>
            {t(locale, 'admin.credit.submit')}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
      </form>
      {step.panel}
    </>
  );
}
