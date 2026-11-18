import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr } from '@nuzm/ui';
import { RecoveryCodes, SessionsTable } from '../../../../components/AccountPanels';
import { ChangePasswordForm } from '../../../../components/AuthForms';
import { MfaSetup } from '../../../../components/MfaSetup';
import { StackPage, StackSection as Section } from '../../../../components/StackSection';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/** The account: profile, sessions and every security setting on one page, one section under the other. */
export default async function Account({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const mfaOn = s.me.mfaFactorId != null;
  const sessions = await view(
    locale,
    async () => (await unwrap(s.api.GET('/v1/auth/sessions', {}))).items,
    (items) =>
      items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <SessionsTable
          locale={locale}
          items={items}
          fmt={Object.fromEntries(items.map((i) => [i.id, formatDateTime(i.lastSeenAt, locale)]))}
        />
      ),
  );
  return (
    <StackPage title={t(locale, 'acct.title')} sub={t(locale, 'acct.sub')}>
      <Section id="profile" title={t(locale, 'acct.details')}>
        <dl className="nzc-dl">
          <dt>{t(locale, 'acct.name')}</dt>
          <dd>{s.me.displayName ?? '—'}</dd>
          <dt>{t(locale, 'acct.email')}</dt>
          <dd>
            <Ltr>{s.me.email}</Ltr>{' '}
            <Badge tone={s.me.emailVerified ? 'success' : 'warn'}>
              {t(locale, s.me.emailVerified ? 'acct.verified' : 'acct.unverified')}
            </Badge>
          </dd>
          <dt>{t(locale, 'acct.language')}</dt>
          <dd>{s.me.locale === 'ar' ? 'العربية' : 'English'}</dd>
        </dl>
        {s.me.memberships.length > 0 && (
          <>
            <h3 className="nzc-stack-sub">{t(locale, 'acct.orgs')}</h3>
            <ul className="nzc-list">
              {s.me.memberships.map((m) => (
                <li key={m.orgId}>
                  <strong>{m.name}</strong>
                  <span className="nz-muted">
                    {t(locale, 'acct.role')}: {m.role}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="sessions" title={t(locale, 'sessions.title')}>
        {sessions}
      </Section>

      <Section
        id="mfa"
        title={t(locale, 'mfa.title')}
        aside={
          <Badge tone={mfaOn ? 'success' : 'warn'}>
            {t(locale, mfaOn ? 'acct.mfa.on' : 'acct.mfa.off')}
          </Badge>
        }
      >
        <MfaSetup locale={locale} />
      </Section>

      <Section id="password" title={t(locale, 'pw.change.title')}>
        <p className="nz-muted">{t(locale, 'pw.change.help')}</p>
        <ChangePasswordForm locale={locale} email={s.me.email} />
      </Section>

      <Section id="recovery" title={t(locale, 'recovery.title')}>
        <RecoveryCodes locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      </Section>
    </StackPage>
  );
}
