import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, ForbiddenState, PageTitle } from '@nuzm/ui';
import {
  AuditedReadNotice,
  JobLookup,
  ResourcesTable,
} from '../../../../../components/CloudResources';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import { loose, classifyResource, type CloudResourceDto } from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Page = { items: CloudResourceDto[]; nextCursor: string | null };

/**
 * UI-M05-13: operations monitor. GAP: the API has no admin list of `platform.operations`, so this screen derives from what resources say:
 * UNKNOWN (outcome uncertain = needs_reconcile) and PROVISIONING / DELETING that have not moved for a long time (stuck). A job can also
 * be looked up by id. A real operations list needs an admin endpoint (recorded in the S23 report).
 */
export default async function Operations({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const now = new Date();
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      async () => {
        const get = (state: string) =>
          unwrap(
            loose(s.api).GET<Page>('/v1/admin/resources', {
              params: { query: { state, limit: 50 } },
            }),
          );
        const [unknown, provisioning, deleting] = await Promise.all([
          get('UNKNOWN'),
          get('PROVISIONING'),
          get('DELETING'),
        ]);
        return [...unknown.items, ...provisioning.items, ...deleting.items];
      },
      (rows) => {
        const watched = rows.filter((r) => classifyResource(r, now) !== 'in_progress');
        return (
          <ResourcesTable
            locale={locale}
            rows={watched}
            canManage={s.can('admin:provider:manage')}
            mfaFactorId={s.me.mfaFactorId ?? null}
            caption={t(locale, 'm05.adm.ops.title')}
            now={now}
          />
        );
      },
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.ops.title')}</PageTitle>
      <ProviderTabs locale={locale} current="operations" can={s.can} />
      <AuditedReadNotice locale={locale} />
      <Banner tone="warn">{t(locale, 'm05.adm.ops.gap')}</Banner>
      {body}
      <JobLookup locale={locale} />
    </>
  );
}
