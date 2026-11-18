import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BudgetView } from '../../../../../../../../components/BuilderBudget';
import { BuilderTabs } from '../../../../../../../../components/BuilderParts';
import { isUuid } from '../../../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../../../lib/builder-gate';

/** UI-M10-11: budgets (read only): org credit, ceilings, defaults and the approval policy. Editing org budgets is the M09 budgets endpoint. */
export default async function BudgetPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await bgate(params, 'ai:budget', 'm10.bud.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => ({
      project: await unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
      budgets: await unwrap(s.api.GET('/v1/ai/budgets', {})),
    }),
    ({ project, budgets }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="budget" />
        <h2 className="nz-h2">{t(locale, 'm10.bud.title')}</h2>
        <BudgetView locale={locale} budgets={budgets} />
      </>
    ),
  );
}
