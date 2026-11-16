import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { SpendingLimitForm } from '../../../../../components/BillingPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function SpendingLimits({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/billing/spending-limits', {})),
    ({ items }) => {
      const org = items.find((l) => l.scope === 'org') ?? null;
      const projects = items.filter((l) => l.scope === 'project');
      return (
        <>
          {!org && <p className="nz-muted">{t(locale, 'bill.limits.none')}</p>}
          {s.can('billing:manage') ? (
            <SpendingLimitForm locale={locale} limit={org} mfaFactorId={s.me.mfaFactorId ?? null} />
          ) : (
            org && (
              <p>
                <Ltr>{formatMinor(org.monthlyCapMinor, org.currency, locale)}</Ltr>
              </p>
            )
          )}
          {projects.length > 0 && (
            <Table
              caption={t(locale, 'bill.scope.project')}
              rows={projects}
              rowKey={(l) => l.id}
              columns={[
                {
                  key: 's',
                  header: t(locale, 'bill.f.scope'),
                  render: (l) => tDynamic(locale, `bill.scope.${l.scope}`, l.scope),
                },
                {
                  key: 'p',
                  header: t(locale, 'bill.scope.project'),
                  render: (l) => <Ltr>{l.projectId ?? ''}</Ltr>,
                },
                {
                  key: 'c',
                  header: t(locale, 'bill.f.cap'),
                  render: (l) => <Ltr>{formatMinor(l.monthlyCapMinor, l.currency, locale)}</Ltr>,
                },
              ]}
            />
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.limits.title')}</PageTitle>
      <BillingTabs locale={locale} current="limits" can={s.can} />
      {body}
    </>
  );
}
