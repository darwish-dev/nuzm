import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle } from '@nuzm/ui';
import { CreateProfileButton } from '../../../../components/ProgramsPanels';
import { ResellerTabs } from '../../../../components/ProgramTabs';
import { FLAGS, itemsOf, type RuleSetDto, type SubOrgDto } from '../../../../lib/m11';
import { gateM11, m11View, resellerOf } from '../../../../lib/m11-server';

/** UI-M11-15: the reseller dashboard: sub-organization links, the price-rule set in force and the way to the statements. A reseller sees metadata and aggregates only, never a sub-organization's content. */
export default async function ResellerDashboard({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const g = await gateM11(params, {
    permission: ['reseller:manage', 'org:read'],
    title: 'm11.rs.title',
    flag: FLAGS.reseller,
    orgType: 'reseller',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await m11View(
    locale,
    async () => {
      const reseller = await resellerOf(s);
      if (!reseller) return { reseller, subs: [] as SubOrgDto[], rules: null as RuleSetDto | null };
      const subs = itemsOf<SubOrgDto>(
        await unwrap(
          s.api.GET('/v1/resellers/{id}/sub-organizations', {
            params: { path: { id: reseller.id } },
          }),
        ),
      );
      const rules = s.can('reseller:pricing')
        ? ((await unwrap(
            s.api.GET('/v1/resellers/{id}/price-rules', { params: { path: { id: reseller.id } } }),
          ).catch(() => null)) as unknown as RuleSetDto | null)
        : null;
      return { reseller, subs, rules };
    },
    ({ reseller, subs, rules }) => {
      if (!reseller)
        return (
          <EmptyState
            title={t(locale, 'm11.rs.noProfile')}
            body={t(locale, 'm11.rs.noProfileBody')}
            action={
              s.can('reseller:manage') ? (
                <CreateProfileButton
                  locale={locale}
                  kind="reseller"
                  mfaFactorId={s.me.mfaFactorId ?? null}
                />
              ) : undefined
            }
          />
        );
      const n = (st: string) => subs.filter((x) => x.status === st).length;
      return (
        <>
          {reseller.status === 'suspended' && (
            <Banner tone="danger">{t(locale, 'm11.rs.suspended')}</Banner>
          )}
          <p className="nz-row">
            <strong>
              <bdi dir="auto">{reseller.name}</bdi>
            </strong>
            <Badge tone={reseller.status === 'active' ? 'success' : 'danger'}>
              {t(locale, `m11.ag.status.${reseller.status}`)}
            </Badge>
            <Ltr>{reseller.currency}</Ltr>
          </p>
          <div className="nz-grid">
            <Card aria-label={t(locale, 'm11.rs.stat.subs')}>
              <h2 className="nz-h2">{t(locale, 'm11.rs.stat.subs')}</h2>
              <p style={{ fontSize: '1.6rem', margin: 0 }}>
                <Ltr>{n('active')}</Ltr>
              </p>
              <p className="nz-muted">
                {t(locale, 'm11.rs.stat.subsDetail', {
                  pending: n('pending'),
                  declined: n('declined'),
                })}
              </p>
              <a href={`/reseller/sub-organizations`}>{t(locale, 'm11.rs.subs.title')}</a>
            </Card>
            <Card aria-label={t(locale, 'm11.rs.stat.rules')}>
              <h2 className="nz-h2">{t(locale, 'm11.rs.stat.rules')}</h2>
              {rules ? (
                <>
                  <p style={{ fontSize: '1.6rem', margin: 0 }}>
                    <Ltr>{rules.rules.length}</Ltr>
                  </p>
                  <p className="nz-muted">
                    {t(locale, 'm11.rs.stat.rulesDetail', { version: rules.version })}
                  </p>
                </>
              ) : (
                <p className="nz-muted">{t(locale, 'm11.rs.stat.rulesNone')}</p>
              )}
              <a href={`/reseller/pricing`}>{t(locale, 'm11.pr.title')}</a>
            </Card>
            <Card aria-label={t(locale, 'm11.st.title')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.title')}</h2>
              <p className="nz-muted">{t(locale, 'm11.rs.stat.statements')}</p>
              <a href={`/reseller/statements`}>{t(locale, 'm11.st.title')}</a>
            </Card>
          </div>
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.rs.title')}</PageTitle>
      <ResellerTabs locale={locale} current="dashboard" />
      {body}
    </>
  );
}
