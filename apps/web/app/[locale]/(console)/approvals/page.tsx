import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ApprovalsInbox } from '../../../../components/ApprovalPanels';
import { bgate, bview } from '../../../../lib/builder-gate';

/**
 * UI-M10-07: approvals inbox across runs, deployments, exports and releases (PROPOSED route PA-M10-02, pending the owner's approval). A decision is bound to the
 * scopeHash of the exact action shown.
 */
export default async function Approvals({ params }: { params: Promise<{ locale: string }> }) {
  const g = await bgate(params, 'ai:read', 'm10.apr.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await bview(
    locale,
    () => unwrap(s.api.GET('/v1/ai/approvals', { params: { query: { status: 'pending' } } })),
    (data) => (
      <ApprovalsInbox
        locale={locale}
        initial={data.items}
        canDecide={s.can('ai:approve')}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm10.apr.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm10.apr.help')}</p>
      {body}
    </>
  );
}
