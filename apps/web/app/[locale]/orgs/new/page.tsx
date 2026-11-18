import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Card, PageTitle } from '@nuzm/ui';
import { AuthLogo } from '../../../../components/BrandLogo';
import { CreateOrgForm } from '../../../../components/CreateOrgForm';
import { OnboardingSteps } from '../../../../components/OnboardingSteps';
import { requireSession } from '../../../../lib/server';

/**
 * Step 2 of sign-up: create the organization. A standalone page (no dashboard shell). A member who already has an organization and
 * comes here to add another sees a way back instead of the sign-up steps.
 */
export default async function NewOrg({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale, `/${locale}/orgs/new`);
  const onboarding = !s.org;
  return (
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <AuthLogo href={`/${locale}`} />
      {onboarding && <OnboardingSteps locale={locale} current={2} />}
      <PageTitle>{t(locale, 'org.new.title')}</PageTitle>
      <Card>
        <p>{t(locale, onboarding ? 'onb.org.sub' : 'org.new.help')}</p>
        {onboarding && <p className="nz-muted">{t(locale, 'org.new.help')}</p>}
        <CreateOrgForm locale={locale} />
      </Card>
      <p className="nz-muted">
        {onboarding ? (
          <>{t(locale, 'onb.signedAs', { email: s.me.email })}</>
        ) : (
          <a href={`/${locale}`}>{t(locale, 'onb.back')}</a>
        )}
      </p>
    </main>
  );
}
