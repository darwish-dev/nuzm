import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { CheckoutForm } from '../../../../../components/DomainPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M07-03: quote → spend approval → contacts, consent and confirmation. The privacy/cross-border facts come from the search answer for this name. */
export default async function Checkout({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ name?: string; years?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:write'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.checkout.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  if (!sp.name) notFound();
  const name = sp.name.toLowerCase();
  const body = await view(
    locale,
    async () => {
      const found = await unwrap(
        s.api.GET('/v1/domains/search', { params: { query: { q: name } } }),
      );
      const policy = await unwrap(s.api.GET('/v1/compliance/residency-policy', {}));
      return {
        item: found.items.find((i) => i.name === name),
        crossBorder: policy.mode !== 'in_kingdom_only' || true,
      };
    },
    ({ item, crossBorder }) =>
      item && item.purchasable ? (
        <CheckoutForm
          locale={locale}
          name={name}
          years={Number(sp.years ?? 1) || 1}
          privacyAvailable={false}
          crossBorder={crossBorder}
        />
      ) : (
        <EmptyState
          title={t(locale, 'dom.search.blocked')}
          body={item ? t(locale, 'dom.search.reason.other') : t(locale, 'state.empty.body')}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.checkout.title')}</PageTitle>
      {body}
    </>
  );
}
