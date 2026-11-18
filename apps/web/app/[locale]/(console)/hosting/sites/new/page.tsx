import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { HostingNewSite } from '../../../../../../components/HostingNewSite';
import { money } from '../../../../../../lib/domains';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

const gb = (mb: number) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);

/** UI-M06-02: add a website (plan cards, then name, project, runtime and an optional domain). */
export default async function NewSite({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ domain?: string }>;
}) {
  const { locale } = await params;
  const domain = ((await searchParams).domain ?? '').trim().toLowerCase().slice(0, 253);
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const head = (
    <>
      <a className="nzc-back" href={`/${locale}/hosting/sites`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'host.title.sites')}
      </a>
      <PageTitle>{t(locale, 'host.new.title')}</PageTitle>
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
  const body = await view(
    locale,
    async () => {
      const [plans, projects] = await Promise.all([
        unwrap(s.api.GET('/v1/hosting/plans', {})),
        unwrap(s.api.GET('/v1/projects', { params: { query: { limit: 100 } } })),
      ]);
      return { plans: plans.items, projects: projects.items };
    },
    ({ plans, projects }) =>
      plans.length === 0 ? (
        <EmptyState title={t(locale, 'host.new.noPlans')} body={t(locale, 'state.empty.body')} />
      ) : projects.length === 0 ? (
        <EmptyState title={t(locale, 'host.new.noProjects')} body={t(locale, 'state.empty.body')} />
      ) : (
        <section className="nzc-dsearch" aria-labelledby="ns-h">
          <div className="nzc-dsearch-inner">
            <h2 id="ns-h">{t(locale, 'host.new.title')}</h2>
            <p className="nzc-dsearch-sub">{t(locale, 'host.new.body')}</p>
            <HostingNewSite
              locale={locale}
              defaultDomain={domain}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              plans={plans.map((p) => ({
                id: p.id,
                name: p.name[locale],
                runtimes: p.runtimes,
                summary: [
                  `${gb(p.quotas.diskMb)} · ${p.quotas.bandwidthGb} GB`,
                  `${p.quotas.dbCount} ${t(locale, 'host.tab.databases')}`,
                ].join(' · '),
                // a placeholder price is not a price: it is quoted at checkout instead
                price:
                  p.price?.amountMinor && p.price.currency && !p.price.placeholder
                    ? money(p.price.amountMinor, p.price.currency)
                    : null,
              }))}
            />
          </div>
        </section>
      ),
  );
  return (
    <>
      {head}
      {body}
    </>
  );
}
