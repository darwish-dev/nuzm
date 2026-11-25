import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, type MessageKey } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { HostingMethods } from '../../../../../../components/HostingMethods';
import { HostingNewSite } from '../../../../../../components/HostingNewSite';
import {
  gbText,
  isSiteMethod,
  methodInfo,
  runtimesFor,
  typeOfPlan,
  typesWithPlans,
  type CatalogPlan,
} from '../../../../../../lib/hosting-catalog';
import { money } from '../../../../../../lib/domains';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/**
 * UI-M06-02: add a website. First how to build it (AI agent, WordPress, static, PHP or Node.js); then the plan (the ones that can host that method)
 * and the name, project, runtime and an optional domain. A plan chosen on the plans page (`?plan=`) is preselected.
 */
/** "Web Hosting · Start"; a plan whose own name already carries the type ("Cloud Startup") is shown as it is. */
const planLabel = (locale: 'ar' | 'en', p: CatalogPlan): string => {
  const type = t(locale, `host.type.${typeOfPlan(p.key)}` as MessageKey);
  const own = p.name[locale];
  const word = type.split(' ')[0] ?? '';
  return own.toLowerCase().includes(word.toLowerCase()) ? own : `${type} · ${own}`;
};

export default async function NewSite({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ domain?: string; method?: string; plan?: string }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const domain = (sp.domain ?? '').trim().toLowerCase().slice(0, 253);
  if (!isLocale(locale)) notFound();
  const method =
    isSiteMethod(sp.method) && methodInfo(sp.method).available ? methodInfo(sp.method) : null;
  const s = await requireSession(locale);
  const head = (
    <>
      <a className="nzc-back" href={`/hosting/sites`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'host.title.sites')}
      </a>
      <PageTitle>{t(locale, method ? 'host.new.title' : 'host.method.title')}</PageTitle>
    </>
  );
  if (!s.org || !s.can('hosting:site:create'))
    return (
      <>
        {head}
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  // step 1: how do you want to build it?
  if (!method || method.id === 'ai')
    return (
      <>
        {head}
        <p className="nz-muted">{t(locale, 'host.method.sub')}</p>
        <HostingMethods
          locale={locale}
          query={{
            ...(domain ? { domain } : {}),
            ...(sp.plan ? { plan: sp.plan.slice(0, 40) } : {}),
          }}
        />
      </>
    );
  // step 2: the plan and the details, for the chosen method
  const body = await view(
    locale,
    async () => {
      const [plans, projects] = await Promise.all([
        unwrap(s.api.GET('/v1/hosting/plans', {})),
        unwrap(s.api.GET('/v1/projects', { params: { query: { limit: 100 } } })),
      ]);
      return { plans: plans.items, projects: projects.items };
    },
    ({ plans, projects }) => {
      // grouped by hosting type (the order of the plans page), smallest plan first inside each
      const fit = typesWithPlans(
        (plans as CatalogPlan[]).filter((p) => runtimesFor(method, p).length > 0),
      ).flatMap((g) => g.plans);
      return fit.length === 0 ? (
        <EmptyState
          title={t(locale, plans.length === 0 ? 'host.new.noPlans' : 'host.method.noPlan')}
          body={t(locale, 'state.empty.body')}
        />
      ) : projects.length === 0 ? (
        <EmptyState title={t(locale, 'host.new.noProjects')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          <div className="nzc-method-bar">
            <span>
              <span className="nz-muted">{t(locale, 'host.method.chosen')}: </span>
              <strong>{t(locale, `host.method.${method.id}` as MessageKey)}</strong>
            </span>
            <a
              href={`/hosting/sites/new${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`}
            >
              {t(locale, 'host.method.change')}
            </a>
          </div>
          <section className="nzc-dsearch" aria-labelledby="ns-h">
            <div className="nzc-dsearch-inner">
              <h2 id="ns-h">{t(locale, 'host.new.title')}</h2>
              <p className="nzc-dsearch-sub">{t(locale, 'host.new.body')}</p>
              <HostingNewSite
                locale={locale}
                defaultDomain={domain}
                initialPlanId={sp.plan}
                projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                plans={fit.map((p) => ({
                  id: p.id,
                  name: planLabel(locale, p),
                  runtimes: runtimesFor(method, p),
                  summary: t(locale, 'host.plan.card', {
                    disk: gbText(p.quotas.diskMb),
                    traffic: p.quotas.bandwidthGb,
                    dbs: p.quotas.dbCount,
                  }),
                  // a placeholder price is not a price: it is quoted at checkout instead
                  price:
                    p.price?.amountMinor && p.price.currency && !p.price.placeholder
                      ? money(p.price.amountMinor, p.price.currency)
                      : null,
                }))}
              />
            </div>
          </section>
        </>
      );
    },
  );
  return (
    <>
      {head}
      {body}
    </>
  );
}
