import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ApprovalsPanel } from '../../../../../components/BillingPanels';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Approvals({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(s.api.GET('/v1/billing/spend-approvals', { params: { query: { limit: 50 } } })),
    (page) => (
      <ApprovalsPanel
        locale={locale}
        rows={page.items}
        fmt={Object.fromEntries(page.items.map((r) => [r.id, formatDateTime(r.expiresAt, locale)]))}
        selfId={s.me.id}
        canDecide={s.can('billing:manage')}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.approvals.title')}</PageTitle>
      <BillingTabs locale={locale} current="approvals" can={s.can} />
      {body}
    </>
  );
}
