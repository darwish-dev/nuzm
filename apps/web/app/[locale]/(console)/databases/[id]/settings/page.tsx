import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { DatabaseSettings } from '../../../../../../components/DatabasePanels';
import { DatabaseTabs } from '../../../../../../components/DataParts';
import { gate } from '../../../../../../lib/gate';
import { view } from '../../../../../../lib/view';

/** UI-M08-05: backup policy (If-Match), credential rotation and deletion with the name typed. */
export default async function DatabaseSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'data:db:read', 'm8.dbs.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  return view(
    locale,
    async () => {
      try {
        return await unwrap(s.api.GET('/v1/databases/{id}', { params: { path: { id } } }));
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    (db) => (
      <>
        <PageTitle>{t(locale, 'm8.dbs.pageTitle', { name: db.name })}</PageTitle>
        <DatabaseTabs locale={locale} id={db.id} current="settings" />
        <DatabaseSettings
          key={db.etag}
          locale={locale}
          db={db}
          canAdmin={s.can('data:db:admin')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
