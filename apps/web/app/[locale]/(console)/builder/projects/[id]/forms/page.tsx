import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import { FormsPanel } from '../../../../../../../components/BuilderForms';
import type { BuilderForm, Page_, Submission } from '../../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../../lib/builder-view';
import { isUuid, one, unwrapCall } from '../../../../../../../lib/compute';

/** UI-M09-06: forms, submissions (masked for viewers) and form creation. */
export default async function Forms({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  const sp = await searchParams;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.tab.forms');
  if (!g.ok) return g.denied;
  const formId = isUuid(one(sp.formId)) ? one(sp.formId) : '';
  const body = await builderView(
    locale,
    async () => ({
      forms: await unwrapCall(
        g.c.get<{ items: BuilderForm[] }>(`/v1/builder/projects/${id}/forms`),
      ),
      subs: await unwrapCall(
        g.c.get<Page_<Submission>>(`/v1/builder/projects/${id}/form-submissions`, {
          query: { limit: 50, formId: formId || undefined, cursor: one(sp.cursor) || undefined },
        }),
      ),
    }),
    (d) => (
      <FormsPanel
        locale={locale}
        projectId={id}
        forms={d.forms.items}
        submissions={d.subs.items}
        nextCursor={d.subs.nextCursor}
        formId={formId}
        canWrite={g.s.can('builder:write')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.forms')}</PageTitle>
      <BuilderTabs locale={locale} projectId={id} current="forms" can={g.s.can} />
      {body}
    </>
  );
}
