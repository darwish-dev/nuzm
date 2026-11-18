import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { FileBrowser, RunPanel } from '../../../../../../../components/BuilderIde';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { isUuid } from '../../../../../../../lib/appbuilder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';

/** UI-M10-03: browser IDE: file tree, READ-ONLY viewer, preview placeholder (isolated origin: not implemented in M10A) and the run panel. */
export default async function Ide({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const g = await bgate(params, 'sandbox:use', 'm10.ide.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => {
      const [project, files, sandboxes] = await Promise.all([
        unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
        unwrap(s.api.GET('/v1/builder/projects/{id}/files', { params: { path: { id } } })),
        unwrap(
          s.api.GET('/v1/builder/projects/{projectId}/sandboxes', {
            params: { path: { projectId: id } },
          }),
        ),
      ]);
      return { project, files, sandboxes };
    },
    ({ project, files, sandboxes }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="ide" />
        <h2 className="nz-h2">{t(locale, 'm10.ide.title')}</h2>
        <FileBrowser
          locale={locale}
          projectId={id}
          files={files.items}
          canWrite={s.can('builder:write')}
        />
        <RunPanel
          locale={locale}
          projectId={id}
          initial={sandboxes.items}
          canUse={s.can('sandbox:use')}
          canTest={s.can('builder:test')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
