import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { Exports } from '../../../../../../../components/BuilderExports';
import { isUuid } from '../../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';

/** UI-M10-10: request an export, see its checksum and SBOM reference, download while the signed URL is valid, and the reasons of a blocked export. */
export default async function ExportsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await bgate(params, 'builder:export', 'm10.exp.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => ({
      project: await unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
      list: await unwrap(
        s.api.GET('/v1/builder/projects/{projectId}/exports', {
          params: { path: { projectId: id } },
        }),
      ),
    }),
    ({ project, list }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="exports" />
        <h2 className="nz-h2">{t(locale, 'm10.exp.title')}</h2>
        <Exports
          locale={locale}
          projectId={id}
          initial={list.items}
          canExport={s.can('builder:export')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
