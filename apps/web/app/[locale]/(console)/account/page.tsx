import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, ButtonLink, Ltr } from '@nuzm/ui';
import { requireSession } from '../../../../lib/server';

/** The profile area: who you are and everything about your own security, reached from the avatar. */
export default async function Profile({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const base = `/${locale}/account`;
  const mfaOn = s.me.mfaFactorId != null;
  return (
    <>
      <div className="nzc-pagehead">
        <div>
          <h1>{t(locale, 'acct.title')}</h1>
          <p>{t(locale, 'acct.sub')}</p>
        </div>
      </div>
      <div className="nz-grid">
        <section className="nz-card" aria-labelledby="a-details">
          <h2 className="nz-h2" id="a-details">
            {t(locale, 'acct.details')}
          </h2>
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
        </section>
        <section className="nz-card" aria-labelledby="a-security">
          <h2 className="nz-h2" id="a-security">
            {t(locale, 'acct.security')}
          </h2>
          <dl className="nzc-dl">
            <dt>{t(locale, 'acct.mfa')}</dt>
            <dd>
              <Badge tone={mfaOn ? 'success' : 'warn'}>
                {t(locale, mfaOn ? 'acct.mfa.on' : 'acct.mfa.off')}
              </Badge>
            </dd>
          </dl>
          <div className="nz-row">
            <ButtonLink variant="secondary" href={`${base}/security/mfa`}>
              {t(locale, 'acct.mfa.manage')}
            </ButtonLink>
            <ButtonLink variant="secondary" href={`${base}/security/password`}>
              {t(locale, 'acct.password.change')}
            </ButtonLink>
            <ButtonLink variant="secondary" href={`${base}/security/recovery-codes`}>
              {t(locale, 'acct.recovery')}
            </ButtonLink>
            <ButtonLink variant="secondary" href={`${base}/sessions`}>
              {t(locale, 'acct.sessions.manage')}
            </ButtonLink>
          </div>
        </section>
      </div>
      {s.me.memberships.length > 0 && (
        <section className="nz-card" aria-labelledby="a-orgs" style={{ marginBlockStart: 16 }}>
          <h2 className="nz-h2" id="a-orgs">
            {t(locale, 'acct.orgs')}
          </h2>
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
        </section>
      )}
    </>
  );
}
