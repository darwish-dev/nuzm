import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MobileStart } from '../../../../../components/MobileStart';
import { mobileGuard } from '../../../../../lib/mobile-view';

/** UI-M10-12: start a mobile app (name, languages, description → project, AI session and a `mobile` run). Behind the `mobile_builder.enabled` flag. */
export default async function NewMobileApp({ params }: { params: Promise<{ locale: string }> }) {
  const m = await mobileGuard(params, 'builder:read', 'mobile.title.new');
  if (!m.ok) return m.node;
  const { locale, g } = m;
  return (
    <>
      <PageTitle>{t(locale, 'mobile.title.new')}</PageTitle>
      <MobileStart locale={locale} canRun={g.s.can('builder:write') && g.s.can('ai:write')} />
    </>
  );
}
