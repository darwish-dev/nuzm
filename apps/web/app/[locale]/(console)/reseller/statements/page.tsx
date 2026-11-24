import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Table,
} from '@nuzm/ui';
import { ResellerTabs } from '../../../../../components/ProgramTabs';
import {
  FLAGS,
  issuerBlocked,
  moneyText,
  previousPeriod,
  validPeriod,
  type StatementDto,
} from '../../../../../lib/m11';
import { gateM11, m11View, resellerOf } from '../../../../../lib/m11-server';

/**
 * UI-M11-18: reseller statements for a period (wholesale, retail, margin, provisional VAT, ledger variance), CSV export, and the invoice-issuer banner. The issuer model comes from the statement's own
 * `issuer` field: while D-24 is open it is `disabled` / BLOCKED and no retail invoice exists. There is no control here that enables a model.
 */
export default async function Statements({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'reseller:finance',
    title: 'm11.st.title',
    flag: FLAGS.reseller,
    orgType: 'reseller',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { period: raw } = await searchParams;
  const period = raw && validPeriod(raw) ? raw : previousPeriod();
  const body = await m11View(
    locale,
    async () => {
      const reseller = await resellerOf(s);
      if (!reseller) return { reseller, st: null as StatementDto | null };
      return {
        reseller,
        st: (await unwrap(
          s.api.GET('/v1/resellers/{id}/statements', {
            params: { path: { id: reseller.id }, query: { period } },
          }),
        )) as unknown as StatementDto,
      };
    },
    ({ reseller, st }) => {
      if (!reseller || !st)
        return (
          <EmptyState
            title={t(locale, 'm11.rs.noProfile')}
            body={t(locale, 'm11.rs.noProfileBody')}
          />
        );
      const m = (v: string) => <Ltr>{moneyText(v, st.currency, locale)}</Ltr>;
      return (
        <>
          <Banner tone="warn">
            <strong>{t(locale, 'm11.st.issuer.title')}</strong>{' '}
            <Badge tone="warn">
              {issuerBlocked(st.issuer)
                ? st.issuer.status === 'BLOCKED'
                  ? 'BLOCKED'
                  : t(locale, 'm11.st.issuer.disabled')
                : st.issuer.status}
            </Badge>{' '}
            {t(locale, 'm11.st.issuer.body', { model: st.issuer.model })}
            <br />
            <bdi dir="auto">{st.issuer.reason}</bdi>
          </Banner>
          <p className="nz-row">
            <Ltr>{st.period}</Ltr>
            {st.provisional && <Badge tone="warn">{t(locale, 'm11.st.provisional')}</Badge>}
            <ButtonLink
              variant="secondary"
              href={`/reseller/statements/export?period=${st.period}`}
            >
              {t(locale, 'm11.st.csv')}
            </ButtonLink>
          </p>
          <div className="nz-grid">
            <Card aria-label={t(locale, 'm11.st.wholesale')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.wholesale')}</h2>
              <p>{m(st.totals.wholesaleMinor)}</p>
            </Card>
            <Card aria-label={t(locale, 'm11.st.retail')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.retail')}</h2>
              <p>{m(st.totals.retailMinor)}</p>
            </Card>
            <Card aria-label={t(locale, 'm11.st.margin')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.margin')}</h2>
              <p>{m(st.totals.marginMinor)}</p>
            </Card>
            <Card aria-label={t(locale, 'm11.st.vat')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.vat')}</h2>
              <p>{m(st.totals.taxMinor)}</p>
              <p className="nz-muted">{t(locale, 'm11.st.vatNote')}</p>
            </Card>
            <Card aria-label={t(locale, 'm11.st.ledger')}>
              <h2 className="nz-h2">{t(locale, 'm11.st.ledger')}</h2>
              <p>{m(st.ledger.wholesaleMinor)}</p>
              <p className="nz-muted">
                {t(locale, 'm11.st.variance')}: {m(st.ledger.varianceMinor)}
              </p>
            </Card>
          </div>
          {st.lines.length === 0 ? (
            <EmptyState title={t(locale, 'm11.st.empty')} body={t(locale, 'm11.st.emptyBody')} />
          ) : (
            <Table
              caption={t(locale, 'm11.st.lines')}
              rows={st.lines}
              rowKey={(l) => `${l.subOrgId}|${l.meterId}`}
              columns={[
                {
                  key: 'o',
                  header: t(locale, 'm11.rs.subOrgId'),
                  render: (l) => <Ltr>{l.subOrgId}</Ltr>,
                },
                {
                  key: 'm',
                  header: t(locale, 'm11.pr.scope.meter'),
                  render: (l) => <Ltr>{l.meterId}</Ltr>,
                },
                {
                  key: 'q',
                  header: t(locale, 'm11.st.quantity'),
                  render: (l) => <Ltr>{l.quantity}</Ltr>,
                },
                {
                  key: 'w',
                  header: t(locale, 'm11.st.wholesale'),
                  render: (l) => m(l.wholesaleMinor),
                },
                { key: 'r', header: t(locale, 'm11.st.retail'), render: (l) => m(l.retailMinor) },
                { key: 'g', header: t(locale, 'm11.st.margin'), render: (l) => m(l.marginMinor) },
              ]}
            />
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.st.title')}</PageTitle>
      <ResellerTabs locale={locale} current="statements" />
      <form method="get" className="nz-row" role="search" aria-label={t(locale, 'm11.st.period')}>
        <Field
          id="st-period"
          label={t(locale, 'm11.st.period')}
          help={t(locale, 'm11.st.periodHelp')}
        >
          {(a) => (
            <Input
              name="period"
              dir="ltr"
              defaultValue={period}
              pattern="\d{4}-(0[1-9]|1[0-2])"
              {...a}
            />
          )}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
