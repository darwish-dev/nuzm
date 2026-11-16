import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { EnvironmentsPanel } from '../../../../../../components/ProjectPanels';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

export default async function Environments({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(s.api.GET('/v1/projects/{id}/environments', { params: { path: { id } } })),
    (page) => (
      <EnvironmentsPanel
        locale={locale}
        projectId={id}
        items={page.items}
        canWrite={s.can('project:create')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'environments.title')}</PageTitle>
      {body}
    </>
  );
}
