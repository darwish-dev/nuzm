import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, EmptyState, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { InstancesPanel } from '../../../../../components/ComputeInstances';
import { StartHero } from '../../../../../components/StartHero';
import { one, unwrapCall, type Instance, type Paged } from '../../../../../lib/compute';
import { computeView } from '../../../../../lib/compute-view';
import { serverCompute } from '../../../../../lib/compute-server';
import { requireSession } from '../../../../../lib/server';

/** UI-M05-03: the organization's compute instances. */
export default async function Instances({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const title = <PageTitle>{t(locale, 'm05.web.instances.title')}</PageTitle>;
  if (!s.can('compute:instance:read'))
    return (
      <>
        {title}
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const c = await serverCompute(s.org.orgId);
  const body = await computeView(
    locale,
    () =>
      unwrapCall(
        c.get<Paged<Instance>>('/v1/compute/instances', {
          query: { limit: 50, cursor: one(sp.cursor) || undefined },
        }),
      ),
    (page) => (
      <InstancesPanel
        locale={locale}
        items={page.items}
        nextCursor={page.nextCursor}
        canCreate={s.can('compute:instance:create')}
      />
    ),
  );
  return (
    <>
      {title}
      {s.can('compute:instance:create') && (
        <StartHero
          id="cloud-hero"
          art="cloud"
          title={t(locale, 'cloud.hero.title')}
          body={t(locale, 'cloud.hero.body')}
        >
          <ButtonLink href={`/${locale}/compute/instances/new`}>
            <Icon name="cloud" size={18} />
            {t(locale, 'cloud.hero.new')}
          </ButtonLink>
        </StartHero>
      )}
      {body}
    </>
  );
}
