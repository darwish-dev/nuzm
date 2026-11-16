import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { WorkspacesPanel } from '../../../../components/ProjectPanels';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Workspaces({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      (await unwrap(s.api.GET('/v1/workspaces', { params: { query: { limit: 100 } } }))).items,
    (items) => (
      <WorkspacesPanel
        locale={locale}
        items={items}
        canWrite={s.can('workspace:create')}
        canDelete={s.can('workspace:delete')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'workspaces.title')}</PageTitle>
      {body}
    </>
  );
}
