import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { HostingShop } from '../../../../../components/HostingShop';
import { HOSTING_TYPES, type HostingType } from '../../../../../lib/hosting-catalog';
import { money } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-01: get new hosting: the hosting types, the plans of each, and a comparison (plans without capacity are never listed). */
export default async function Plans({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const type = (await searchParams).type;
  const initialType = (HOSTING_TYPES as readonly string[]).includes(type ?? '')
    ? (type as HostingType)
    : undefined;
  const s = await requireSession(locale);
  if (!s.can('hosting:plan:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.title.plans')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/plans', {})),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.plans')} body={t(locale, 'state.empty.body')} />
      ) : (
        <HostingShop
          locale={locale}
          orgId={s.org?.orgId ?? ''}
          plans={data.items}
          initialType={initialType}
          // a placeholder price is not a price: it is quoted at checkout instead
          prices={Object.fromEntries(
            data.items.map((p) => [
              p.id,
              p.price?.amountMinor && p.price.currency && !p.price.placeholder
                ? money(p.price.amountMinor, p.price.currency)
                : null,
            ]),
          )}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.title.plans')}</PageTitle>
      {body}
    </>
  );
}
