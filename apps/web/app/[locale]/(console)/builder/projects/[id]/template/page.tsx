import { notFound } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { TemplateWorkspace } from '../../../../../../../components/TemplateWorkspace';
import { builderGuard, builderView, NotAvailable } from '../../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../../lib/compute';
import { GENERATION_FLAG, type Workspace } from '../../../../../../../lib/generation';
import { flagEnabled } from '../../../../../../../lib/services';

/**
 * S-K6: the template workspace of a project: its comparison with the template copy, the plan, the context preview and the adaptation run. Needs `builder:read` and the
 * organization flag `knowledge.generation` (default off: "not available", and the API answers 404). Never shows a template's own files.
 */
export default async function TemplateWorkspacePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'gen.title');
  if (!g.ok) return g.denied;
  if (!flagEnabled(g.s.me.featureFlags, GENERATION_FLAG)) return <NotAvailable locale={locale} />;
  return builderView(
    locale,
    () => unwrapCall(g.c.get<Workspace>(`/v1/builder/projects/${id}/template-workspace`)),
    (w) => (
      <TemplateWorkspace
        locale={locale}
        projectId={id}
        workspace={w}
        canWrite={g.s.can('builder:write')}
        canRun={g.s.can('ai:write')}
      />
    ),
  );
}
