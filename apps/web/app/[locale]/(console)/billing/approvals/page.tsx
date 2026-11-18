import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ApprovalsPanel } from '../../../../../components/BillingPanels';
import { BillingTabs } from '../../../../../components/BillingTabs';
import {
  CLOUD_FLAG,
  flagOn,
  one,
  provisioningHint,
  type ProvisioningHint,
} from '../../../../../lib/compute';
import { serverCompute } from '../../../../../lib/compute-server';
import { isUuid } from '../../../../../lib/privacy';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Approvals({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  // UI-M05-07: opened from the create-instance wizard with the quote that needs approval
  const quoteId = one(sp.quoteId);
  const amountMinor = one(sp.amountMinor);
  const prefill =
    isUuid(quoteId) && /^[1-9]\d{0,17}$/.test(amountMinor) ? { quoteId, amountMinor } : undefined;
  const body = await view(
    locale,
    async () => {
      const page = await unwrap(
        s.api.GET('/v1/billing/spend-approvals', { params: { query: { limit: 50 } } }),
      );
      // Approvals whose subject is a compute quote are flagged as provisioning. A lookup that fails only drops the flag.
      const provisioning: Record<string, ProvisioningHint> = {};
      if (s.org && flagOn(s.me.featureFlags, CLOUD_FLAG) && s.can('quote:read')) {
        const c = await serverCompute(s.org.orgId);
        await Promise.all(
          page.items
            .filter((r) => r.subjectKind === 'quote' && r.status === 'pending')
            .slice(0, 20)
            .map(async (r) => {
              const q = await c.get<unknown>(`/v1/quotes/${r.subjectId}`);
              const hint = q.response.ok ? provisioningHint(q.data) : null;
              if (hint) provisioning[r.id] = hint;
            }),
        );
      }
      return { page, provisioning };
    },
    ({ page, provisioning }) => (
      <ApprovalsPanel
        locale={locale}
        rows={page.items}
        fmt={Object.fromEntries(page.items.map((r) => [r.id, formatDateTime(r.expiresAt, locale)]))}
        selfId={s.me.id}
        canDecide={s.can('billing:manage')}
        mfaFactorId={s.me.mfaFactorId ?? null}
        provisioning={provisioning}
        prefill={prefill}
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
