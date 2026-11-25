import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, Card, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../../components/BillingTabs';
import { PayInvoiceForm } from '../../../../../../components/PaymentsPanels';
import { trimDec } from '../../../../../../lib/billing';
import { statusTone } from '../../../../../../lib/payments';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M03-06: invoice detail: lines, tax breakdown, e-invoice status and QR, PDF/XML downloads, pay now. */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      try {
        const inv = await unwrap(
          s.api.GET('/v1/billing/invoices/{id}', { params: { path: { id } } }),
        );
        const payable =
          (inv.status === 'open' || inv.status === 'partially_paid') && s.can('billing:manage');
        const methods = payable ? await unwrap(s.api.GET('/v1/billing/payment-methods', {})) : null;
        const qr = inv.zatca.qr
          ? await QRCode.toDataURL(inv.zatca.qr, { margin: 1, width: 192 })
          : null;
        return { inv, methods, qr };
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    ({ inv, methods, qr }) => {
      const remaining = (BigInt(inv.totalMinor) - BigInt(inv.paidMinor)).toString();
      const money = (v: string) => <Ltr>{formatMinor(v, inv.currency, locale)}</Ltr>;
      const held =
        inv.zatca.state !== 'cleared' &&
        inv.buyer.buyerType === 'b2b' &&
        inv.zatca.state !== 'not_generated';
      return (
        <>
          <p className="nz-row">
            <Badge tone={statusTone(inv.status)}>
              {tDynamic(locale, `inv.status.${inv.status}`, inv.status)}
            </Badge>
            <Badge tone={statusTone(inv.zatca.state)}>
              {tDynamic(locale, `inv.zatca.${inv.zatca.state}`, inv.zatca.state)}
            </Badge>
            {inv.environment === 'sandbox' && <Badge tone="warn">{t(locale, 'inv.sandbox')}</Badge>}
          </p>
          {inv.taxReview.required && <Banner tone="warn">{t(locale, 'inv.taxReview')}</Banner>}
          <div className="nz-grid">
            <Card aria-labelledby="i-seller">
              <h2 className="nz-h2" id="i-seller">
                {t(locale, 'inv.seller')}
              </h2>
              <p>{inv.seller.legalName[locale]}</p>
              <p>
                {t(locale, 'inv.vatNumber')}: <Ltr>{inv.seller.vatNumber ?? '—'}</Ltr>
              </p>
            </Card>
            <Card aria-labelledby="i-buyer">
              <h2 className="nz-h2" id="i-buyer">
                {t(locale, 'inv.buyer')}
              </h2>
              <p>{inv.buyer.legalName[locale]}</p>
              <p>
                {t(locale, 'inv.vatNumber')}: <Ltr>{inv.buyer.vatNumber ?? '—'}</Ltr>
              </p>
            </Card>
            <Card aria-labelledby="i-dates">
              <h2 className="nz-h2" id="i-dates">
                {t(locale, 'inv.period')}
              </h2>
              <p>
                <Ltr>{`${inv.periodStart} → ${inv.periodEnd}`}</Ltr>
              </p>
              <p>
                {t(locale, 'inv.col.issued')}: {formatDateTime(inv.issuedAt, locale)}
              </p>
              <p>
                {t(locale, 'inv.col.due')}: {formatDateTime(inv.dueAt, locale)}
              </p>
            </Card>
          </div>
          <h2 className="nz-h2">{t(locale, 'inv.lines')}</h2>
          <Table
            caption={t(locale, 'inv.lines')}
            rows={inv.lines}
            rowKey={(l) => String(l.position)}
            columns={[
              { key: 'd', header: t(locale, 'inv.col.description'), render: (l) => l.description },
              {
                key: 'q',
                header: t(locale, 'inv.col.quantity'),
                icon: 'data',
                render: (l) => <Ltr>{`${trimDec(l.quantity)} ${l.unit}`}</Ltr>,
              },
              { key: 'n', header: t(locale, 'inv.col.net'), render: (l) => money(l.netMinor) },
              { key: 't', header: t(locale, 'inv.col.tax'), render: (l) => money(l.taxMinor) },
            ]}
          />
          <h2 className="nz-h2">{t(locale, 'inv.tax')}</h2>
          <Table
            caption={t(locale, 'inv.tax')}
            rows={inv.taxBreakdown}
            rowKey={(r) => `${r.rateCode}-${r.rateBps}`}
            columns={[
              {
                key: 'r',
                header: t(locale, 'inv.col.rate'),
                render: (r) => <Ltr>{`${r.rateBps / 100}%`}</Ltr>,
              },
              { key: 'n', header: t(locale, 'inv.col.taxable'), render: (r) => money(r.netMinor) },
              {
                key: 't',
                header: t(locale, 'inv.col.taxAmount'),
                icon: 'tag',
                render: (r) => money(r.taxMinor),
              },
            ]}
          />
          <Card aria-labelledby="i-tot">
            <h2 className="nz-h2" id="i-tot">
              {t(locale, 'inv.total')}
            </h2>
            <p>
              {t(locale, 'inv.subtotal')}: {money(inv.subtotalMinor)}
            </p>
            <p>
              {t(locale, 'inv.taxTotal')}: {money(inv.taxMinor)}
            </p>
            <p>
              <strong>
                {t(locale, 'inv.total')}: {money(inv.totalMinor)}
              </strong>
            </p>
            {remaining !== '0' && (
              <p>
                {t(locale, 'inv.remaining')}: {money(remaining)}
              </p>
            )}
          </Card>
          <div className="nz-row">
            {held ? (
              <p className="nz-muted">{t(locale, 'inv.heldClearance')}</p>
            ) : (
              <>
                <ButtonLink
                  variant="secondary"
                  href={`/billing/invoices/${inv.id}/pdf?lang=ar`}
                >
                  {t(locale, 'inv.pdfAr')}
                </ButtonLink>
                <ButtonLink
                  variant="secondary"
                  href={`/billing/invoices/${inv.id}/pdf?lang=en`}
                >
                  {t(locale, 'inv.pdfEn')}
                </ButtonLink>
              </>
            )}
            {inv.zatca.state !== 'not_generated' && !held && (
              <ButtonLink variant="secondary" href={`/billing/invoices/${inv.id}/xml`}>
                {t(locale, 'inv.xml')}
              </ButtonLink>
            )}
          </div>
          {inv.zatca.state !== 'not_generated' && (
            <Card aria-labelledby="i-qr">
              <h2 className="nz-h2" id="i-qr">
                {t(locale, 'inv.qr')}
              </h2>
              {qr ? (
                <img src={qr} width={192} height={192} alt={t(locale, 'inv.qr')} />
              ) : (
                <p className="nz-muted">
                  {tDynamic(locale, `inv.zatca.${inv.zatca.state}`, inv.zatca.state)}
                </p>
              )}
              <p className="nz-muted">{t(locale, 'inv.simulated')}</p>
            </Card>
          )}
          {methods && remaining !== '0' && (
            <PayInvoiceForm
              locale={locale}
              invoiceId={inv.id}
              remainingMinor={remaining}
              currency={inv.currency}
              methods={methods.items}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'inv.detail.title', { number: id.slice(0, 8) })}</PageTitle>
      <BillingTabs locale={locale} current="invoices" can={s.can} />
      {body}
    </>
  );
}
