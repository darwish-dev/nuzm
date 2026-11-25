import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { ComputeWizard } from '../../../../../../components/ComputeWizard';
import { one, unwrapCall, type Offer, type Paged } from '../../../../../../lib/compute';
import { computeView } from '../../../../../../lib/compute-view';
import { serverCompute } from '../../../../../../lib/compute-server';
import { requireSession } from '../../../../../../lib/server';

/** UI-M05-02: get a new cloud server (configure region, Nuzm Cloud line, size and OS → SSH keys → quote review → confirm). */
export default async function NewInstance({
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
  const title = (
    <>
      <a className="nzc-back" href={`/compute/instances`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'm05.web.instances.title')}
      </a>
      <PageTitle>{t(locale, 'cloud.new.title')}</PageTitle>
    </>
  );
  if (!s.can('compute:instance:create') || !s.can('offers:read'))
    return (
      <>
        {title}
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const orgId = s.org.orgId;
  const c = await serverCompute(orgId);
  const body = await computeView(
    locale,
    async () => {
      // every eligible offer: the configurator groups them by region, line and size itself
      const items: Offer[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 8; i++) {
        const page = await unwrapCall(
          c.get<Paged<Offer>>('/v1/offers', { query: { kind: 'compute', limit: 50, cursor } }),
        );
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return items;
    },
    (offers) => (
      <ComputeWizard
        locale={locale}
        offers={offers}
        orgId={orgId}
        basketLineId={one(sp.cart) || undefined}
        initialImageId={one(sp.image) || undefined}
        initialOfferId={one(sp.offerId) || undefined}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      {title}
      <p className="nz-muted">{t(locale, 'cloud.new.sub')}</p>
      {body}
    </>
  );
}
