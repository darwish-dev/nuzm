import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { ButtonLink, Card, EmptyState, Ltr, Meter, PageTitle } from '@nuzm/ui';
import { BillingTabs } from '../../../../components/BillingTabs';
import { trimDec } from '../../../../lib/billing';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/** A tile that may be unavailable to this role (e.g. no `usage:read`): it is simply left out, never faked. */
const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export default async function BillingOverview({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      const balance = await unwrap(s.api.GET('/v1/billing/balance', {}));
      const [summary, limits, quotas, approvals] = await Promise.all([
        safe(unwrap(s.api.GET('/v1/usage/summary', {}))),
        safe(unwrap(s.api.GET('/v1/billing/spending-limits', {}))),
        safe(unwrap(s.api.GET('/v1/quotas', {}))),
        safe(
          unwrap(
            s.api.GET('/v1/billing/spend-approvals', {
              params: { query: { status: 'pending', limit: 50 } },
            }),
          ),
        ),
      ]);
      return { balance, summary, limits, quotas, approvals };
    },
    ({ balance, summary, limits, quotas, approvals }) => {
      const cap = limits?.items.find((l) => l.scope === 'org') ?? null;
      const spent =
        summary?.totalMinor && summary.currency === cap?.currency ? BigInt(summary.totalMinor) : 0n;
      const percent = cap ? Number((spent * 100n) / BigInt(cap.monthlyCapMinor)) : 0;
      const alerts = [
        ...(quotas?.items ?? [])
          .filter((q) => q.measured && q.state !== 'ok')
          .map((q) =>
            t(locale, 'bill.alerts.quota', {
              group: q.meterGroup,
              percent: q.percent ?? 0,
              state: tDynamic(locale, `bill.state.${q.state}`, q.state),
            }),
          ),
        ...(approvals && approvals.items.length > 0
          ? [t(locale, 'bill.alerts.approvals', { count: approvals.items.length })]
          : []),
      ];
      return (
        <div className="nz-grid">
          <Card aria-labelledby="b-balance">
            <h2 className="nz-h2" id="b-balance">
              {t(locale, 'bill.balance.title')}
            </h2>
            {balance.balances.length === 0 ? (
              <p className="nz-muted">{t(locale, 'bill.balance.none')}</p>
            ) : (
              balance.balances.map((b) => (
                <p key={b.currency}>
                  <Ltr>{formatMinor(b.balanceMinor, b.currency, locale)}</Ltr>
                </p>
              ))
            )}
            <ButtonLink variant="secondary" href={`/${locale}/billing/ledger`}>
              {t(locale, 'bill.tab.ledger')}
            </ButtonLink>
          </Card>
          <Card aria-labelledby="b-mtd">
            <h2 className="nz-h2" id="b-mtd">
              {t(locale, 'bill.mtd.title')}
            </h2>
            {!summary || summary.items.length === 0 ? (
              <p className="nz-muted">{t(locale, 'bill.mtd.none')}</p>
            ) : summary.totalMinor && summary.currency ? (
              <p>
                <Ltr>{formatMinor(summary.totalMinor, summary.currency, locale)}</Ltr>
              </p>
            ) : (
              <p className="nz-muted">{t(locale, 'bill.mtd.unrated')}</p>
            )}
            {summary && summary.items.length > 0 && (
              <p className="nz-muted">
                {summary.items
                  .slice(0, 3)
                  .map((i) => `${i.meterId} ${trimDec(i.quantity)}`)
                  .join(' · ')}
              </p>
            )}
            <ButtonLink variant="secondary" href={`/${locale}/billing/usage`}>
              {t(locale, 'bill.tab.usage')}
            </ButtonLink>
          </Card>
          <Card aria-labelledby="b-spend">
            <h2 className="nz-h2" id="b-spend">
              {t(locale, 'bill.spend.title')}
            </h2>
            {cap ? (
              <>
                <p>
                  <Ltr>
                    {t(locale, 'bill.spend.of', {
                      spent: formatMinor(spent.toString(), cap.currency, locale),
                      cap: formatMinor(cap.monthlyCapMinor, cap.currency, locale),
                    })}
                  </Ltr>
                </p>
                <Meter label={t(locale, 'bill.spend.meter')} percent={percent} />
              </>
            ) : (
              <p className="nz-muted">{t(locale, 'bill.spend.nocap')}</p>
            )}
            <ButtonLink variant="secondary" href={`/${locale}/billing/spending-limits`}>
              {t(locale, 'bill.tab.limits')}
            </ButtonLink>
          </Card>
          <Card aria-labelledby="b-alerts">
            <h2 className="nz-h2" id="b-alerts">
              {t(locale, 'bill.alerts.title')}
            </h2>
            {alerts.length === 0 ? (
              <p className="nz-muted">{t(locale, 'bill.alerts.none')}</p>
            ) : (
              <ul>
                {alerts.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.title')}</PageTitle>
      <BillingTabs locale={locale} current="overview" can={s.can} />
      {body ?? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      )}
    </>
  );
}
