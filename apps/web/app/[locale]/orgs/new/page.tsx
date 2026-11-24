import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthShell } from '../../../../components/AuthShell';
import { CreateOrgForm } from '../../../../components/CreateOrgForm';
import { requireSession } from '../../../../lib/server';

/**
 * Step 2 of sign-up: create the organization. A standalone page (no dashboard shell). A member who already has an organization and
 * comes here to add another sees a way back instead of the sign-up steps.
 */
export default async function NewOrg({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale, `/orgs/new`);
  const onboarding = !s.org;
  const body = (
    <>
      <p className="nz-muted">{t(locale, onboarding ? 'onb.org.sub' : 'org.new.help')}</p>
      {onboarding && <p className="nz-muted">{t(locale, 'org.new.help')}</p>}
      <CreateOrgForm locale={locale} />
      <p className="nzc-split-links">
        {onboarding ? (
          <>{t(locale, 'onb.signedAs', { email: s.me.email })}</>
        ) : (
          <a href={`/console`}>{t(locale, 'onb.back')}</a>
        )}
      </p>
    </>
  );
  return (
    <AuthShell
      locale={locale}
      variant={onboarding ? 'register' : 'help'}
      step={onboarding ? 2 : undefined}
      title={t(locale, 'org.new.title')}
    >
      {body}
    </AuthShell>
  );
}
