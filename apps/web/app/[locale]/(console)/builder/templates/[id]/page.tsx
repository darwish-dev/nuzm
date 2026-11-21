import { notFound } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { TemplateStart } from '../../../../../../components/TemplateStart';
import { TemplateDetail } from '../../../../../../components/Templates';
import { APP_BUILDER_FLAG } from '../../../../../../lib/appbuilder';
import { builderGuard, builderView, NotAvailable } from '../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../lib/compute';
import { flagEnabled } from '../../../../../../lib/services';
import { TEMPLATES_FLAG, type Template } from '../../../../../../lib/templates';

/**
 * S-K7: one template and "start a project from it". A template that is not published, or that this organization may not use, is "not available" (the API answers 404 for both,
 * so the page cannot tell them apart either). Copying needs `builder:write` and `app_builder.enabled`.
 */
export default async function TemplatePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'tpl.title');
  if (!g.ok) return g.denied;
  if (!flagEnabled(g.s.me.featureFlags, TEMPLATES_FLAG)) return <NotAvailable locale={locale} />;
  return builderView(
    locale,
    () => unwrapCall(g.c.get<Template>(`/v1/builder/templates/${id}`)),
    (x) => (
      <>
        <TemplateDetail locale={locale} x={x} />
        {x.id && x.versionId && (
          <TemplateStart
            locale={locale}
            resourceId={x.id}
            versionId={x.versionId}
            versionSeq={x.versionSeq}
            templateName={x.name ?? ''}
            canWrite={g.s.can('builder:write')}
            appsEnabled={flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG)}
          />
        )}
      </>
    ),
  );
}
