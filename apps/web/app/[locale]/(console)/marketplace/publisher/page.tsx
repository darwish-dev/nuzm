import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { CreateListingForm, SubmitVersionForm } from '../../../../../components/MarketplacePanels';
import { MarketplaceTabs } from '../../../../../components/MarketplaceTabs';
import { Section } from '../../../../../components/M11Parts';
import {
  FLAGS,
  itemsOf,
  listingTitle,
  moderationTone,
  moneyText,
  scanSummary,
  type ListingDto,
} from '../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../lib/m11-server';

/**
 * UI-M11-09: the publisher dashboard: own listings in every state, versions with their moderation status and scan findings, and the revenue ACCRUAL (a ledger liability: accrued, NOT paid out;
 * payout is D-26/HG-11-01, open). Publishing needs a VERIFIED publisher account: the API answers 403 `publisher_not_verified` and the forms show the verification-pending state.
 */
export default async function Publisher({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'marketplace:publish',
    title: 'm11.pub.title',
    flag: FLAGS.marketplace,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const factor = s.me.mfaFactorId ?? null;
  const orgId = s.org!.orgId;
  const body = await m11View(
    locale,
    async () =>
      itemsOf<ListingDto>(
        await unwrap(
          s.api.GET('/v1/marketplace/listings', { params: { query: { mine: true, limit: 100 } } }),
        ),
      ),
    (items) => {
      const cur = items[0]?.accrual?.currency ?? 'SAR';
      const gross = items
        .filter((l) => l.accrual && l.accrual.currency === cur)
        .reduce((a, l) => a + BigInt(l.accrual!.grossMinor), 0n);
      const share = items
        .filter((l) => l.accrual && l.accrual.currency === cur)
        .reduce((a, l) => a + BigInt(l.accrual!.shareMinor), 0n);
      const purchases = items.reduce((a, l) => a + (l.accrual?.purchases ?? 0), 0);
      return (
        <>
          <Card aria-label={t(locale, 'm11.pub.accrual.title')}>
            <h2 className="nz-h2">{t(locale, 'm11.pub.accrual.title')}</h2>
            <p>
              <Badge tone="warn">{t(locale, 'm11.pub.accrual.label')}</Badge>
            </p>
            <dl>
              <dt>{t(locale, 'm11.pub.accrual.gross')}</dt>
              <dd>
                <Ltr>{moneyText(gross.toString(), cur, locale)}</Ltr>
              </dd>
              <dt>{t(locale, 'm11.pub.accrual.share')}</dt>
              <dd>
                <Ltr>{moneyText(share.toString(), cur, locale)}</Ltr>
              </dd>
              <dt>{t(locale, 'm11.pub.accrual.purchases')}</dt>
              <dd>
                <Ltr>{purchases}</Ltr>
              </dd>
            </dl>
            <p className="nz-muted">{t(locale, 'm11.pub.accrual.note')}</p>
          </Card>
          <Section title={t(locale, 'm11.pub.listings')}>
            {items.length === 0 ? (
              <EmptyState
                title={t(locale, 'm11.pub.empty')}
                body={t(locale, 'm11.pub.emptyBody')}
              />
            ) : (
              <div style={{ display: 'grid', gap: 16 }}>
                {items.map((l) => (
                  <Card key={l.id} aria-label={listingTitle(l, locale)}>
                    <h3 className="nz-h2">
                      <a href={`/${locale}/marketplace/listings/${l.id}`}>
                        <bdi dir="auto">{listingTitle(l, locale)}</bdi>
                      </a>{' '}
                      <Badge tone={moderationTone(l.status)}>
                        {tDynamic(locale, `m11.pub.status.${l.status}`, l.status)}
                      </Badge>
                    </h3>
                    <p className="nz-row">
                      <Badge>{t(locale, `m11.mkt.type.${l.type}`)}</Badge>
                      <Ltr>{moneyText(l.price.amount, l.price.currency, locale)}</Ltr>
                      {l.accrual && (
                        <span className="nz-muted">
                          {t(locale, 'm11.pub.accrual.row', {
                            n: l.accrual.purchases,
                            share: moneyText(l.accrual.shareMinor, l.accrual.currency, locale),
                          })}
                        </span>
                      )}
                    </p>
                    {l.status === 'draft' && (
                      <Banner tone="warn">{t(locale, 'm11.pub.draftNote')}</Banner>
                    )}
                    {l.versions.length === 0 ? (
                      <p className="nz-muted">{t(locale, 'm11.pub.noVersions')}</p>
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
                            key: 'm',
                            header: t(locale, 'm11.pub.moderation'),
                            render: (v) => (
                              <Badge tone={moderationTone(v.moderationStatus)}>
                                {tDynamic(
                                  locale,
                                  `m11.pub.mod.${v.moderationStatus}`,
                                  v.moderationStatus,
                                )}
                              </Badge>
                            ),
                          },
                          {
                            key: 's',
                            header: t(locale, 'm11.pub.scan'),
                            render: (v) => {
                              const sc = scanSummary(v);
                              return sc ? (
                                <>
                                  <Badge tone={moderationTone(sc.verdict)}>
                                    {tDynamic(locale, `m11.pub.scan.${sc.verdict}`, sc.verdict)}
                                  </Badge>
                                  <details>
                                    <summary>
                                      {t(locale, 'm11.pub.findings', {
                                        block: sc.block,
                                        warn: sc.warn,
                                      })}
                                    </summary>
                                    <ul>
                                      {v.scan!.findings.map((f, i) => (
                                        <li key={i}>
                                          <Badge tone={f.severity === 'block' ? 'danger' : 'warn'}>
                                            {f.severity}
                                          </Badge>{' '}
                                          <Ltr>{f.rule}</Ltr> <Ltr>{f.where}</Ltr>{' '}
                                          <bdi dir="auto">{f.detail}</bdi>
                                        </li>
                                      ))}
                                    </ul>
                                    <p className="nz-muted">{t(locale, 'm11.pub.scanNote')}</p>
                                  </details>
                                </>
                              ) : (
                                '—'
                              );
                            },
                          },
                          {
                            key: 'd',
                            header: t(locale, 'field.created'),
                            render: (v) => formatDateTime(v.createdAt, locale),
                          },
                        ]}
                      />
                    )}
                    {l.status !== 'archived' && l.status !== 'suspended' && (
                      <div style={{ marginBlockStart: 12 }}>
                        <SubmitVersionForm
                          locale={locale}
                          listing={l}
                          orgId={orgId}
                          mfaFactorId={factor}
                        />
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </Section>
          <div style={{ marginBlockStart: 16 }}>
            <CreateListingForm locale={locale} orgId={orgId} mfaFactorId={factor} />
          </div>
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.pub.title')}</PageTitle>
      <MarketplaceTabs locale={locale} current="publisher" publisher />
      {body}
    </>
  );
}
