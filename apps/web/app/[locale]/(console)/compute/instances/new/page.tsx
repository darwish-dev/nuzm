import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { ComputeTabs } from '../../../../../../components/ComputeBits';
import { ComputeWizard } from '../../../../../../components/ComputeWizard';
import { one, unwrapCall, type Offer, type Paged } from '../../../../../../lib/compute';
import { computeView } from '../../../../../../lib/compute-view';
import { serverCompute } from '../../../../../../lib/compute-server';
import { requireSession } from '../../../../../../lib/server';

/** UI-M05-02: create-instance wizard (offer → image → keys → quote review → confirm). */
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
  const title = <PageTitle>{t(locale, 'm05.web.wiz.title')}</PageTitle>;
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
  const c = await serverCompute(s.org.orgId);
  const body = await computeView(
    locale,
    () => unwrapCall(c.get<Paged<Offer>>('/v1/offers', { query: { kind: 'compute', limit: 50 } })),
    (page) => (
      <ComputeWizard
        locale={locale}
        offers={page.items}
        initialOfferId={one(sp.offerId) || undefined}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      {title}
      <ComputeTabs locale={locale} current="new" can={s.can} />
      {body}
    </>
  );
}
