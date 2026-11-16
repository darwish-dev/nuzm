import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { PublishVersion } from '../../../../../components/BillingAdminPanels';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function PriceBooks({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/admin/billing/price-books', { params: { query: { limit: 50 } } }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          {page.items.map((b) => (
            <Card key={b.id} aria-labelledby={`pb-${b.id}`}>
              <h2 className="nz-h2" id={`pb-${b.id}`}>{`${b.name} (${b.currency})`}</h2>
              {b.placeholder && (
                <p>
                  <Badge tone="warn">{t(locale, 'abill.books.placeholder')}</Badge>
                </p>
              )}
              {b.versions.map((v) => (
                <div key={v.id}>
                  <p className="nz-row">
                    <strong>{`${t(locale, 'abill.f.version')} ${v.version}`}</strong>
                    <Badge tone={v.status === 'published' ? 'success' : 'warn'}>{v.status}</Badge>
                    <span>{`${t(locale, 'abill.f.effective')}: ${formatDateTime(v.effectiveFrom, locale)}`}</span>
                  </p>
                  <Table
                    caption={`${b.name} · ${t(locale, 'abill.f.version')} ${v.version}`}
                    rows={v.items}
                    rowKey={(i) => i.meterId}
                    columns={[
                      {
                        key: 'm',
                        header: t(locale, 'bill.f.meter'),
                        render: (i) => <Ltr>{i.meterId}</Ltr>,
                      },
                      { key: 't', header: t(locale, 'abill.f.tier'), render: (i) => i.tierModel },
                      {
                        key: 'p',
                        header: t(locale, 'abill.f.unitPrice'),
                        render: (i) =>
                          i.unitPriceMinor ? (
                            <Ltr>{i.unitPriceMinor}</Ltr>
                          ) : (
                            <Ltr>
                              {(i.tiers ?? [])
                                .map((x) => `${x.upTo ?? '∞'}:${x.unitPriceMinor}`)
                                .join(' · ')}
                            </Ltr>
                          ),
                      },
                      {
                        key: 'a',
                        header: t(locale, 'abill.f.allowance'),
                        render: (i) => <Ltr>{i.includedAllowance}</Ltr>,
                      },
                      {
                        key: 'r',
                        header: t(locale, 'abill.f.rounding'),
                        render: (i) => i.rounding,
                      },
                    ]}
                  />
                  {v.status === 'draft' && s.can('admin:billing:publish') && (
                    <PublishVersion
                      locale={locale}
                      bookId={b.id}
                      versionId={v.id}
                      mfaFactorId={s.me.mfaFactorId ?? null}
                    />
                  )}
                </div>
              ))}
            </Card>
          ))}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'abill.books.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="books" can={s.can} />
      {body}
    </>
  );
}
