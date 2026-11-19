import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { Checkout } from '../../../../components/Checkout';
import type { CatalogPlan } from '../../../../lib/hosting-catalog';
import { sandboxUi } from '../../../../lib/payments';
import { requireSession } from '../../../../lib/server';

/** A part that cannot be read for this member (or fails) is left out: the checkout then says what is missing instead of failing as a whole. */
const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

/**
 * The basket's checkout: hosting websites are completed here (details, card, review, confirm); each domain and each cloud server continues in its own
 * order step, which keeps the contact details, consents and approvals those orders need. The basket itself lives in the browser.
 */
export default async function CheckoutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !(s.can('hosting:site:create') || s.can('domain:write')))
    return (
      <>
        <PageTitle>{t(locale, 'checkout.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const [plans, projects, methods] = await Promise.all([
    s.can('hosting:plan:read') ? safe(unwrap(s.api.GET('/v1/hosting/plans', {}))) : null,
    s.can('hosting:site:create')
      ? safe(unwrap(s.api.GET('/v1/projects', { params: { query: { limit: 100 } } })))
      : null,
    s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/payment-methods', {}))) : null,
  ]);
  return (
    <>
      <PageTitle>{t(locale, 'checkout.title')}</PageTitle>
      <Checkout
        locale={locale}
        orgId={s.org.orgId}
        plans={(plans?.items ?? []) as CatalogPlan[]}
        projects={(projects?.items ?? []).map((p) => ({ id: p.id, name: p.name }))}
        methods={(methods?.items ?? [])
          .filter((m) => m.status === 'active')
          .map((m) => ({
            id: m.id,
            brand: m.brand,
            last4: m.last4,
            expMonth: m.expMonth,
            expYear: m.expYear,
            isDefault: m.isDefault,
          }))}
        canSites={s.can('hosting:site:create')}
        canAddCard={s.can('billing:manage')}
        sandbox={sandboxUi()}
      />
    </>
  );
}
