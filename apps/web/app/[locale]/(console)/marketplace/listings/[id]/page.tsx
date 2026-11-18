import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BuyPanel } from '../../../../../../components/MarketplacePanels';
import { MarketplaceTabs } from '../../../../../../components/MarketplaceTabs';
import { Fact } from '../../../../../../components/DataParts';
import {
  FLAGS,
  isUuid,
  itemsOf,
  latestApproved,
  listingDescription,
  listingTitle,
  moneyText,
  type ListingDto,
} from '../../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../../lib/m11-server';

/** UI-M11-07: one listing (through `?filter[id]=`): description, versions, price with the provisional VAT estimate, and buy (quote, then purchase, then the invoice). */
export default async function ListingDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'marketplace:read',
    title: 'm11.mkt.detail',
    flag: FLAGS.marketplace,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const body = await m11View(
    locale,
    async () =>
      itemsOf<ListingDto>(
        await unwrap(
          s.api.GET('/v1/marketplace/listings', {
            params: { query: { 'filter[id]': id, limit: 1 } },
          }),
        ),
      )[0] ?? null,
    (l) => {
      if (!l)
        return (
          <EmptyState
            title={t(locale, 'm11.state.notFound.title')}
            body={t(locale, 'm11.state.notFound.body')}
          />
        );
      const version = latestApproved(l);
      const money = (m: string) => <Ltr>{moneyText(m, l.price.currency, locale)}</Ltr>;
      return (
        <>
          <h2 className="nz-h2">
            <bdi dir="auto">{listingTitle(l, locale)}</bdi>
          </h2>
          <p className="nz-row">
            <Badge>{t(locale, `m11.mkt.type.${l.type}`)}</Badge>
            <Badge>{t(locale, `m11.mkt.licence.${l.licence}`)}</Badge>
            {l.licence === 'multi_seat' && (
              <span className="nz-muted">{t(locale, 'm11.mkt.seats', { n: l.seats })}</span>
            )}
          </p>
          <p>
            <bdi dir="auto">{listingDescription(l, locale)}</bdi>
          </p>
          <Card aria-label={t(locale, 'm11.mkt.price')}>
            <dl>
              <Fact label={t(locale, 'm11.mkt.price')}>
                <strong>{money(l.price.amount)}</strong>
              </Fact>
              {l.priceWithTax && (
                <>
                  <Fact label={t(locale, 'm11.buy.vat', { rate: l.priceWithTax.rateBps / 100 })}>
                    {money(l.priceWithTax.taxMinor)}
                  </Fact>
                  <Fact label={t(locale, 'm11.buy.total')}>
                    <strong>{money(l.priceWithTax.totalMinor)}</strong>
                  </Fact>
                </>
              )}
            </dl>
            <p className="nz-muted">{t(locale, 'm11.buy.vatNote')}</p>
          </Card>
          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm11.mkt.versions')}
          </h2>
          {l.versions.length === 0 ? (
            <Banner tone="warn">{t(locale, 'm11.mkt.noVersion')}</Banner>
          ) : (
            <Table
              caption={t(locale, 'm11.mkt.versions')}
              rows={l.versions}
              rowKey={(v) => v.id}
              columns={[
                {
                  key: 'v',
                  header: t(locale, 'm11.pub.version'),
                  render: (v) => <Ltr>{v.version}</Ltr>,
                },
                {
                  key: 'c',
                  header: t(locale, 'm11.pub.changelog'),
                  render: (v) => (v.changelog ? <bdi dir="auto">{v.changelog}</bdi> : '—'),
                },
                {
                  key: 'd',
                  header: t(locale, 'field.created'),
                  render: (v) => formatDateTime(v.createdAt, locale),
                },
              ]}
            />
          )}
          <div style={{ marginBlockStart: 16 }}>
            {l.mine ? (
              <p className="nz-muted">{t(locale, 'm11.mkt.own')}</p>
            ) : s.can('marketplace:buy') && version ? (
              <BuyPanel
                locale={locale}
                listing={l}
                version={version}
                mfaFactorId={s.me.mfaFactorId ?? null}
              />
            ) : (
              <p className="nz-muted">{t(locale, 'm11.mkt.cannotBuy')}</p>
            )}
          </div>
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.mkt.detail')}</PageTitle>
      <MarketplaceTabs locale={locale} current="browse" publisher={s.can('marketplace:publish')} />
      {body}
    </>
  );
}
