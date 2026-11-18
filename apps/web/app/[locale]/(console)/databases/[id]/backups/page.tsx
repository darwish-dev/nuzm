import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BackupsPanel } from '../../../../../../components/DatabasePanels';
import { DatabaseTabs } from '../../../../../../components/DataParts';
import { gate } from '../../../../../../lib/gate';
import { view } from '../../../../../../lib/view';

/** UI-M08-04: backups, restores (new database by default) and the verification history, all from GET /backups. */
export default async function DatabaseBackups({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'data:db:read', 'm8.bk.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  return view(
    locale,
    async () => {
      try {
        const db = await unwrap(s.api.GET('/v1/databases/{id}', { params: { path: { id } } }));
        const backups = await unwrap(
          s.api.GET('/v1/databases/{id}/backups', {
            params: { path: { id }, query: { limit: 100 } },
          }),
        );
        return { db, backups };
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    ({ db, backups }) => (
      <>
        <PageTitle>{t(locale, 'm8.bk.pageTitle', { name: db.name })}</PageTitle>
        <DatabaseTabs locale={locale} id={db.id} current="backups" />
        <BackupsPanel
          locale={locale}
          db={db}
          backups={backups.items}
          canWrite={s.can('data:db:write')}
          canAdmin={s.can('data:db:admin')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
