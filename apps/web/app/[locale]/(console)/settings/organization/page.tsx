import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { OrgSettingsForm } from '../../../../../components/AccountPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function OrgSettings({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const orgId = s.org?.orgId;
  if (!orgId)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const body = await view(
    locale,
    async () =>
      await unwrap(s.api.GET('/v1/organizations/{orgId}', { params: { path: { orgId } } })),
    (o) => (
      <OrgSettingsForm
        locale={locale}
        orgId={o.id}
        name={o.name}
        defaultLocale={o.defaultLocale}
        version={o.version}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'settings.org.title')}</PageTitle>
      {body}
    </>
  );
}
