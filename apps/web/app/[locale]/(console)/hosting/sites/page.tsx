import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  ButtonLink,
  EmptyState,
  ForbiddenState,
  Icon,
  Ltr,
  PageTitle,
  Table,
} from '@nuzm/ui';
import { StartHero } from '../../../../../components/StartHero';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

const TONE = { active: 'success', failed: 'danger', suspended: 'warn' } as const;

/** UI-M06-03: the site list with status chips. */
export default async function Sites({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.can('hosting:site:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'host.none.sites')}
          body={t(locale, 'state.empty.body')}
          action={
            s.can('hosting:site:create') ? (
              <ButtonLink href={`/${locale}/hosting/sites/new`}>{t(locale, 'host.add')}</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Table
          caption={t(locale, 'host.title.sites')}
          rows={data.items}
          rowKey={(x) => x.id}
          cardIcon="hosting"
          rowHref={(x) => `/${locale}/hosting/sites/${x.id}`}
          manageLabel={t(locale, 'action.manage')}
          columns={[
            {
              key: 'n',
              card: 'title',
              header: t(locale, 'host.col.name'),
              render: (x) => <a href={`/${locale}/hosting/sites/${x.id}`}>{x.name}</a>,
            },
            {
              key: 'p',
              card: 'subtitle',
              header: t(locale, 'host.col.plan'),
              icon: 'tag',
              render: (x) => (locale === 'ar' ? x.plan.name.ar : x.plan.name.en),
            },
            {
              key: 'r',
              card: 'chip',
              header: t(locale, 'host.col.runtime'),
              icon: 'calendar',
              render: (x) => <Ltr>{x.runtime}</Ltr>,
            },
            {
              key: 'g',
              card: 'chip',
              header: t(locale, 'host.col.region'),
              icon: 'pin',
              render: (x) => <Ltr>{x.dataRegion}</Ltr>,
            },
            {
              key: 'd',
              card: 'footer',
              header: t(locale, 'host.col.domain'),
              icon: 'globe',
              render: (x) => (x.primaryDomain ? <Ltr>{x.primaryDomain}</Ltr> : '—'),
            },
            {
              key: 's',
              card: 'badge',
              header: t(locale, 'host.col.status'),
              icon: 'pulse',
              render: (x) => (
                <Badge tone={TONE[x.status as keyof typeof TONE]}>
                  {tDynamic(locale, `host.status.${x.status}`, x.status)}
                </Badge>
              ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
      {s.can('hosting:site:create') && (
        <StartHero
          id="host-hero"
          art="hosting"
          title={t(locale, 'host.hero.title')}
          body={t(locale, 'host.hero.body')}
        >
          {s.can('hosting:plan:read') && (
            <ButtonLink variant="secondary" href={`/${locale}/hosting/plans`}>
              <Icon name="tag" size={18} />
              {t(locale, 'host.hero.new')}
            </ButtonLink>
          )}
          <ButtonLink href={`/${locale}/hosting/sites/new`}>
            <Icon name="plus" size={18} />
            {t(locale, 'host.hero.addSite')}
          </ButtonLink>
        </StartHero>
      )}
      {body}
    </>
  );
}
