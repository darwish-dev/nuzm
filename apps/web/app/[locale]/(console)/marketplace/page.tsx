import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Ltr, PageTitle, Select } from '@nuzm/ui';
import { MarketplaceTabs } from '../../../../components/MarketplaceTabs';
import {
  FLAGS,
  LISTING_TYPES,
  itemsOf,
  listingDescription,
  listingTitle,
  moneyText,
  type ListingDto,
} from '../../../../lib/m11';
import { gateM11, m11View } from '../../../../lib/m11-server';

/** UI-M11-06: browse, search and filter the published listings (approved versions only). */
export default async function Marketplace({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; type?: string; cursor?: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'marketplace:read',
    title: 'm11.mkt.title',
    flag: FLAGS.marketplace,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { q, type, cursor } = await searchParams;
  const body = await m11View(
    locale,
    async () => {
      const page = await unwrap(
        s.api.GET('/v1/marketplace/listings', {
          params: {
            query: {
              limit: 24,
              q: q || undefined,
              type: LISTING_TYPES.includes(type as never) ? type : undefined,
              cursor: cursor || undefined,
            },
          },
        }),
      );
      return { items: itemsOf<ListingDto>(page), next: page.nextCursor ?? null };
    },
    ({ items, next }) =>
      items.length === 0 ? (
        <EmptyState
          title={t(locale, 'm11.mkt.empty')}
          body={t(locale, q || type ? 'm11.mkt.emptyFiltered' : 'm11.mkt.emptyBody')}
        />
      ) : (
        <>
          <ul
            className="nz-grid"
            style={{ listStyle: 'none', padding: 0 }}
            aria-label={t(locale, 'm11.mkt.title')}
          >
            {items.map((l) => (
              <li key={l.id}>
                <Card aria-label={listingTitle(l, locale)}>
                  <p>
                    <Badge>{t(locale, `m11.mkt.type.${l.type}`)}</Badge>
                  </p>
                  <h2 className="nz-h2">
                    <a href={`/marketplace/listings/${l.id}`}>
                      <bdi dir="auto">{listingTitle(l, locale)}</bdi>
                    </a>
                  </h2>
                  <p className="nz-muted">
                    <bdi dir="auto">{listingDescription(l, locale).slice(0, 140)}</bdi>
                  </p>
                  <p>
                    <strong>
                      <Ltr>{moneyText(l.price.amount, l.price.currency, locale)}</Ltr>
                    </strong>{' '}
                    <span className="nz-muted">{t(locale, `m11.mkt.licence.${l.licence}`)}</span>
                  </p>
                </Card>
              </li>
            ))}
          </ul>
          {next && (
            <p>
              <a
                href={`/marketplace?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}), cursor: next })}`}
              >
                {t(locale, 'm11.c.next')}
              </a>
            </p>
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.mkt.title')}</PageTitle>
      <MarketplaceTabs locale={locale} current="browse" publisher={s.can('marketplace:publish')} />
      <form method="get" className="nz-row" role="search" aria-label={t(locale, 'm11.mkt.search')}>
        <Field id="mkt-q" label={t(locale, 'field.search')}>
          {(a) => <Input name="q" defaultValue={q} {...a} />}
        </Field>
        <Field id="mkt-type" label={t(locale, 'field.type')}>
          {(a) => (
            <Select name="type" defaultValue={type ?? ''} {...a}>
              <option value="">{t(locale, 'm11.c.all')}</option>
              {LISTING_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(locale, `m11.mkt.type.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
