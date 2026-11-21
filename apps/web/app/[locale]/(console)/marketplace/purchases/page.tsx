import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { InstallForm } from '../../../../../components/MarketplacePanels';
import { MarketplaceTabs } from '../../../../../components/MarketplaceTabs';
import { Section } from '../../../../../components/M11Parts';
import {
  FLAGS,
  entitlementTitle,
  itemsOf,
  moderationTone,
  moneyText,
  type InstallationDto,
  type ListingDto,
  type MarketEntitlementDto,
  type PurchaseDto,
} from '../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../lib/m11-server';

/**
 * UI-M11-08: purchases, invoices, installations and the install action. There is NO purchases-list endpoint, so the list is built from the organization's marketplace entitlements
 * (`GET /v1/billing/entitlements` → `marketplace[]`) and each purchase is read by its id; installations come from `GET /v1/marketplace/installations`.
 */
export default async function Purchases({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'marketplace:read',
    title: 'm11.pur.title',
    flag: FLAGS.marketplace,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const factor = s.me.mfaFactorId ?? null;
  const body = await m11View(
    locale,
    async () => {
      const ent = await unwrap(s.api.GET('/v1/billing/entitlements', {}));
      const list = (ent.marketplace as unknown as MarketEntitlementDto[]).slice(0, 50);
      const inst = itemsOf<InstallationDto>(
        await unwrap(
          s.api.GET('/v1/marketplace/installations', { params: { query: { limit: 100 } } }),
        ),
      );
      const purchases = new Map<string, PurchaseDto | null>();
      const listings = new Map<string, ListingDto | null>();
      await Promise.all(
        list.map(async (e) => {
          const [p, l] = await Promise.all([
            unwrap(
              s.api.GET('/v1/marketplace/purchases/{id}', {
                params: { path: { id: e.purchaseId } },
              }),
            )
              .then((x) => x as unknown as PurchaseDto)
              .catch(() => null),
            listings.has(e.listingId)
              ? Promise.resolve(listings.get(e.listingId) ?? null)
              : unwrap(
                  s.api.GET('/v1/marketplace/listings', {
                    params: { query: { 'filter[id]': e.listingId, limit: 1 } },
                  }),
                )
                  .then((x) => itemsOf<ListingDto>(x)[0] ?? null)
                  .catch(() => null),
          ]);
          purchases.set(e.entitlementId, p);
          listings.set(e.listingId, l);
        }),
      );
      const ws = s.can('workspace:read')
        ? await unwrap(s.api.GET('/v1/workspaces', { params: { query: { limit: 100 } } }))
            .then((x) => x.items.map((w) => ({ id: w.id, name: w.name })))
            .catch(() => [])
        : [];
      return { list, inst, purchases, listings, ws };
    },
    ({ list, inst, purchases, listings, ws }) => (
      <>
        {list.length === 0 ? (
          <EmptyState title={t(locale, 'm11.pur.empty')} body={t(locale, 'm11.pur.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm11.pur.title')}
            rows={list}
            rowKey={(e) => e.entitlementId}
            columns={[
              {
                key: 'l',
                header: t(locale, 'm11.pur.listing'),
                render: (e) => (
                  <a href={`/marketplace/listings/${e.listingId}`}>
                    <bdi dir="auto">{entitlementTitle(e, locale)}</bdi>
                  </a>
                ),
              },
              {
                key: 'p',
                header: t(locale, 'm11.pur.payment'),
                render: (e) => {
                  const p = purchases.get(e.entitlementId);
                  return p ? (
                    <>
                      <Badge tone={moderationTone(p.status)}>
                        {tDynamic(locale, `m11.pur.status.${p.status}`, p.status)}
                      </Badge>
                      <p>
                        <Ltr>{moneyText(p.amount.amount, p.amount.currency, locale)}</Ltr>
                      </p>
                    </>
                  ) : (
                    '—'
                  );
                },
              },
              {
                key: 'e',
                header: t(locale, 'm11.pur.entitlement'),
                render: (e) => (
                  <>
                    <Badge tone={moderationTone(e.status)}>
                      {tDynamic(locale, `m11.pur.ent.${e.status}`, e.status)}
                    </Badge>
                    <p className="nz-muted">
                      {t(locale, `m11.mkt.licence.${e.licence as 'single_org' | 'multi_seat'}`)}
                    </p>
                  </>
                ),
              },
              {
                key: 'i',
                header: t(locale, 'm11.pur.invoice'),
                render: (e) => {
                  const p = purchases.get(e.entitlementId);
                  return p?.invoiceId ? (
                    <>
                      <a href={`/billing/invoices/${p.invoiceId}`}>
                        <Ltr>{p.invoiceId.slice(0, 8)}</Ltr>
                      </a>
                      {p.status === 'pending_payment' && (
                        <p>
                          <a href={`/billing/invoices/${p.invoiceId}`}>
                            {t(locale, 'm11.buy.payInvoice')}
                          </a>
                        </p>
                      )}
                    </>
                  ) : (
                    '—'
                  );
                },
              },
              {
                key: 'c',
                header: t(locale, 'field.created'),
                render: (e) => formatDateTime(e.createdAt, locale),
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                render: (e) => {
                  if (e.status !== 'active')
                    return <span className="nz-muted">{t(locale, 'm11.inst.needsActive')}</span>;
                  if (!s.can('marketplace:install'))
                    return <span className="nz-muted">{t(locale, 'm11.inst.noPermission')}</span>;
                  const l = listings.get(e.listingId);
                  return (
                    <InstallForm
                      locale={locale}
                      listing={{ id: e.listingId, type: e.type }}
                      versions={(l?.versions ?? []).filter(
                        (v) => v.moderationStatus === 'approved',
                      )}
                      workspaces={ws}
                      mfaFactorId={factor}
                    />
                  );
                },
              },
            ]}
          />
        )}
        <Section title={t(locale, 'm11.inst.list')}>
          {inst.length === 0 ? (
            <p className="nz-muted">{t(locale, 'm11.inst.empty')}</p>
          ) : (
            <Table
              caption={t(locale, 'm11.inst.list')}
              rows={inst}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: 'l',
                  header: t(locale, 'm11.pur.listing'),
                  render: (i) => (
                    <a href={`/marketplace/listings/${i.listingId}`}>
                      <Ltr>{i.listingId.slice(0, 8)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 't',
                  header: t(locale, 'field.type'),
                  render: (i) =>
                    t(
                      locale,
                      i.targetType === 'workflow'
                        ? 'm11.inst.target.workflow'
                        : 'm11.inst.target.project',
                    ),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (i) => (
                    <>
                      <Badge tone={moderationTone(i.status)}>
                        {tDynamic(locale, `m11.inst.status.${i.status}`, i.status)}
                      </Badge>
                      {i.status === 'failed' && !!(i.error as { code?: string } | null)?.code && (
                        <p className="nz-muted">
                          <Ltr>{String((i.error as { code?: string }).code)}</Ltr>
                        </p>
                      )}
                    </>
                  ),
                },
                {
                  key: 'g',
                  header: t(locale, 'm11.inst.result'),
                  render: (i) =>
                    i.targetType === 'workflow' && i.targetId ? (
                      <a href={`/automation/workflows/${i.targetId}/edit`}>
                        {t(locale, 'm11.inst.openWorkflow')}
                      </a>
                    ) : i.targetId ? (
                      <Ltr>{i.targetId.slice(0, 8)}</Ltr>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'c',
                  header: t(locale, 'field.created'),
                  render: (i) => formatDateTime(i.createdAt, locale),
                },
              ]}
            />
          )}
        </Section>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.pur.title')}</PageTitle>
      <MarketplaceTabs
        locale={locale}
        current="purchases"
        publisher={s.can('marketplace:publish')}
      />
      <p className="nz-muted">{t(locale, 'm11.pur.help')}</p>
      {body}
    </>
  );
}
