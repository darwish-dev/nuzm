import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { TemplateRecommend } from '../../../../../components/TemplateRecommend';
import { TemplateCards, TemplateFilters } from '../../../../../components/Templates';
import { builderGuard, builderView, NotAvailable } from '../../../../../lib/builder-view';
import { unwrapCall } from '../../../../../lib/compute';
import { flagEnabled } from '../../../../../lib/services';
import {
  TEMPLATES_FLAG,
  filtersOf,
  listQuery,
  nextHref,
  type TemplatePage,
} from '../../../../../lib/templates';

/**
 * S-K7: the template gallery. Published templates (the platform's and the organization's own) with their compatibility facts, the reuse they allow, the licence and a safe
 * design summary; a box that suggests templates for a description; filters in the URL. Needs `builder:read` and the organization flag `knowledge.customer_templates`
 * (default off: the page then says "not available" and the API answers 404). Never a file, a path or a key.
 */
export default async function Templates({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'tpl.title');
  if (!g.ok) return g.denied;
  const heading = <PageTitle>{t(locale, 'tpl.title')}</PageTitle>;
  if (!flagEnabled(g.s.me.featureFlags, TEMPLATES_FLAG))
    return (
      <>
        {heading}
        <NotAvailable locale={locale} />
      </>
    );
  const f = filtersOf(sp);
  const body = await builderView(
    locale,
    () => unwrapCall(g.c.get<TemplatePage>('/v1/builder/templates', { query: listQuery(f) })),
    (page) => (
      <TemplateCards
        locale={locale}
        items={page.items ?? []}
        next={page.nextCursor ? nextHref(locale, f, page.nextCursor) : null}
        filtered={Boolean(f.q || f.platform || f.framework)}
      />
    ),
  );
  return (
    <>
      {heading}
      <p className="nz-muted">{t(locale, 'tpl.intro')}</p>
      <TemplateRecommend locale={locale} />
      <TemplateFilters locale={locale} f={f} />
      {body}
    </>
  );
}
