import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { AdminSandboxNodes } from '../../../../components/BuilderAdminPanels';
import { isSandboxKind } from '../../../../lib/builder-admin';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/**
 * UI-M10-19: sandbox fleet oversight, read only, from the cloud resource inventory (`GET /v1/admin/resources`, an audited read). Sandbox-node inventory depends on
 * M05; the force-kill action has no endpoint (spec change pending) and is not rendered.
 */
export default async function AdminSandboxes({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      async () =>
        (
          await unwrap(s.api.GET('/v1/admin/resources', { params: { query: { limit: 100 } } }))
        ).items.filter((r) => isSandboxKind(r.kind)),
      (rows) => <AdminSandboxNodes locale={locale} rows={rows} />,
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm10.adm.sbx.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm10.adm.sbx.help')}</p>
      {body}
    </>
  );
}
