import { formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Banner, Card, Ltr, Table } from '@nuzm/ui';
import { APPROVAL_ROLES, APPROVAL_TYPES } from '../lib/builder';

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * UI-M10-11: budgets, READ ONLY. The organization credit left, the ceilings of a run, the defaults and the approval policy (which role may decide which
 * approval type). Editing org budgets is provided by the M09 budgets endpoint, not here.
 */
export function BudgetView({ locale, budgets }: { locale: Locale; budgets: Schemas['AiBudgets'] }) {
  const c = (budgets.ceilings ?? {}) as Record<string, unknown>;
  const d = (budgets.defaults ?? {}) as Record<string, unknown>;
  const fmt = (v: number | null, kind: 'tokens' | 'minor' | 'minutes' | 'steps' | 'pct') =>
    v === null ? (
      '—'
    ) : kind === 'minor' ? (
      <Ltr>{formatMinor(String(v), 'SAR', locale)}</Ltr>
    ) : kind === 'minutes' ? (
      <Ltr>{`${v} ${t(locale, 'm10.run.minutesUnit')}`}</Ltr>
    ) : kind === 'pct' ? (
      <Ltr>{`${v}%`}</Ltr>
    ) : (
      <Ltr>{v.toLocaleString('en-US')}</Ltr>
    );
  return (
    <>
      <Banner tone="warn">{t(locale, 'm10.bud.m09')}</Banner>
      <Card aria-label={t(locale, 'm10.bud.credit')}>
        <h2 className="nz-h2">{t(locale, 'm10.bud.credit')}</h2>
        <p>
          <strong>
            <Ltr>{formatMinor(String(budgets.orgRemainingMinor), 'SAR', locale)}</Ltr>
          </strong>
        </p>
        <p className="nz-muted">{t(locale, 'm10.bud.creditHelp')}</p>
      </Card>
      <div className="nz-grid">
        <Card aria-label={t(locale, 'm10.bud.ceilings')}>
          <h2 className="nz-h2">{t(locale, 'm10.bud.ceilings')}</h2>
          <dl>
            <dt>{t(locale, 'm10.run.meter.tokens')}</dt>
            <dd>{fmt(n(c.maxTokens), 'tokens')}</dd>
            <dt>{t(locale, 'm10.run.meter.minutes')}</dt>
            <dd>{fmt(n(c.maxMinutes), 'minutes')}</dd>
            <dt>{t(locale, 'm10.bud.steps')}</dt>
            <dd>{fmt(n(c.maxSteps), 'steps')}</dd>
            <dt>{t(locale, 'm10.bud.warnAt')}</dt>
            <dd>{fmt(n(c.warnAtPct), 'pct')}</dd>
          </dl>
        </Card>
        <Card aria-label={t(locale, 'm10.bud.defaults')}>
          <h2 className="nz-h2">{t(locale, 'm10.bud.defaults')}</h2>
          <dl>
            <dt>{t(locale, 'm10.run.meter.tokens')}</dt>
            <dd>{fmt(n(d.maxTokens), 'tokens')}</dd>
            <dt>{t(locale, 'm10.run.meter.cost')}</dt>
            <dd>{fmt(n(d.maxCostMinor), 'minor')}</dd>
            <dt>{t(locale, 'm10.run.meter.minutes')}</dt>
            <dd>{fmt(n(d.maxMinutes), 'minutes')}</dd>
          </dl>
        </Card>
      </div>
      <h2 className="nz-h2">{t(locale, 'm10.bud.policy')}</h2>
      <p className="nz-muted">{t(locale, 'm10.bud.policyHelp')}</p>
      <Table
        caption={t(locale, 'm10.bud.policy')}
        rows={APPROVAL_TYPES}
        rowKey={(a) => a}
        columns={[
          {
            key: 't',
            header: t(locale, 'm10.apr.col.type'),
            render: (a) => tDynamic(locale, `m10.apr.type.${a}`, a),
          },
          {
            key: 'r',
            header: t(locale, 'm10.apr.roles'),
            render: (a) =>
              APPROVAL_ROLES[a]
                .map((r) => tDynamic(locale, `role.${r}`, r))
                .join(locale === 'ar' ? '، ' : ', '),
          },
        ]}
      />
    </>
  );
}
