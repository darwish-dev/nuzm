import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { TerminalScreen } from '../../../../../../../../../components/BuilderTerminal';
import { isUuid } from '../../../../../../../../../lib/appbuilder';
import { bgate, bview } from '../../../../../../../../../lib/builder-gate';

/** UI-M10-04: full-screen terminal layout. The terminal transport (WebSocket + ticket route) needs owner approval PA-M10-01 and is not enabled. */
export default async function Terminal({
  params,
}: {
  params: Promise<{ locale: string; id: string; sid: string }>;
}) {
  const g = await bgate(params, 'sandbox:use', 'm10.term.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id, sid } = await params;
  if (!isUuid(id) || !isUuid(sid)) notFound();
  return bview(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/builder/projects/{projectId}/sandboxes/{sid}', {
          params: { path: { projectId: id, sid } },
        }),
      ),
    (sandbox) => (
      <>
        <PageTitle>{t(locale, 'm10.term.title')}</PageTitle>
        <TerminalScreen locale={locale} projectId={id} sandbox={sandbox} />
      </>
    ),
  );
}
