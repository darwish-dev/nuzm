import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { PriceRulesEditor } from '../../../../../components/ProgramsPanels';
import { ResellerTabs } from '../../../../../components/ProgramTabs';
import { Section } from '../../../../../components/M11Parts';
import { FLAGS, type RuleSetDto } from '../../../../../lib/m11';
import { gateM11, m11View, resellerOf } from '../../../../../lib/m11-server';

/** UI-M11-17: the price-rule editor: markup per plan or meter, margin preview, BELOW-COST blocking, optimistic concurrency on the rule-set version (`If-Match`). */
export default async function Pricing({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'reseller:pricing',
    title: 'm11.pr.title',
    flag: FLAGS.reseller,
    orgType: 'reseller',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await m11View(
    locale,
    async () => {
      const reseller = await resellerOf(s);
      if (!reseller) return { reseller, rules: null as RuleSetDto | null };
      return {
        reseller,
        rules: (await unwrap(
          s.api.GET('/v1/resellers/{id}/price-rules', { params: { path: { id: reseller.id } } }),
        )) as unknown as RuleSetDto,
      };
    },
    ({ reseller, rules }) =>
      !reseller || !rules ? (
        <EmptyState
          title={t(locale, 'm11.rs.noProfile')}
          body={t(locale, 'm11.rs.noProfileBody')}
        />
      ) : (
        <>
          <p className="nz-muted">{t(locale, 'm11.pr.help')}</p>
          <p>
            {t(locale, 'm11.pr.currentVersion')}: <Ltr>{rules.version}</Ltr>
          </p>
          <PriceRulesEditor
            locale={locale}
            resellerId={reseller.id}
            currency={reseller.currency}
            ruleSet={rules}
            canEdit={s.can('reseller:pricing')}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
          <Section title={t(locale, 'm11.pr.history')}>
            {rules.history.length === 0 ? (
              <p className="nz-muted">{t(locale, 'm11.pr.historyEmpty')}</p>
            ) : (
              <Table
                caption={t(locale, 'm11.pr.history')}
                rows={rules.history}
                rowKey={(h) => String(h.version)}
                columns={[
                  {
                    key: 'v',
                    header: t(locale, 'm11.wf.col.version'),
                    render: (h) => <Ltr>{h.version}</Ltr>,
                  },
                  {
                    key: 'c',
                    header: t(locale, 'field.created'),
                    render: (h) => formatDateTime(h.createdAt, locale),
                  },
                  {
                    key: 'n',
                    header: t(locale, 'm11.pr.rulesCount'),
                    render: (h) => <Ltr>{h.rules}</Ltr>,
                  },
                ]}
              />
            )}
          </Section>
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.pr.title')}</PageTitle>
      <ResellerTabs locale={locale} current="pricing" />
      {body}
    </>
  );
}
