import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, Table } from '@nuzm/ui';
import {
  breakerState,
  breakerTone,
  healthTone,
  unverifiedAccounts,
  worstBreaker,
  type AccountDto,
  type ProviderDto,
} from '../lib/providers';

export const HealthBadge = ({ locale, state }: { locale: Locale; state: string | undefined }) => (
  <Badge tone={healthTone(state)}>
    {tDynamic(locale, `m05.adm.health.${state ?? 'unknown'}`, state ?? 'unknown')}
  </Badge>
);
export const BreakerBadge = ({ locale, breaker }: { locale: Locale; breaker: unknown }) => {
  const s = breakerState(breaker);
  return <Badge tone={breakerTone(s)}>{t(locale, `m05.adm.breaker.${s}`)}</Badge>;
};

/** UI-M05-08: the provider registry. Adapter availability and verification are stated plainly; nothing is "verified" here without a probe. */
export function ProvidersTable(p: {
  locale: Locale;
  providers: ProviderDto[];
  accounts: AccountDto[];
}) {
  if (p.providers.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.reg.empty.title')}
        body={t(p.locale, 'm05.adm.reg.empty.body')}
      />
    );
  const byProvider = (id: string) => p.accounts.filter((a) => a.providerId === id);
  return (
    <Table
      caption={t(p.locale, 'm05.adm.reg.title')}
      rows={p.providers}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'k',
          header: t(p.locale, 'm05.adm.col.provider'),
          render: (r) => (
            <a href={`/${p.locale}/providers/accounts?providerId=${r.id}`}>
              <Ltr>{r.key}</Ltr>
            </a>
          ),
        },
        { key: 'kind', header: t(p.locale, 'field.kind'), render: (r) => <Ltr>{r.kind}</Ltr> },
        {
          key: 'ad',
          header: t(p.locale, 'm05.adm.col.adapter'),
          render: (r) => (
            <span>
              <Ltr>{r.adapterId}</Ltr>{' '}
              {r.adapterAvailable ? (
                <Badge>{t(p.locale, 'm05.adm.reg.adapterYes')}</Badge>
              ) : (
                <Badge tone="warn">{t(p.locale, 'm05.adm.reg.adapterNo')}</Badge>
              )}
            </span>
          ),
        },
        {
          key: 'env',
          header: t(p.locale, 'm05.adm.col.environment'),
          render: (r) =>
            tDynamic(p.locale, `m05.adm.env.${r.environmentPolicy}`, r.environmentPolicy),
        },
        {
          key: 'st',
          header: t(p.locale, 'm05.adm.col.status'),
          render: (r) => (
            <Badge tone={r.status === 'active' ? undefined : 'warn'}>
              {tDynamic(p.locale, `m05.adm.status.${r.status}`, r.status)}
            </Badge>
          ),
        },
        {
          key: 'n',
          header: t(p.locale, 'm05.adm.col.accounts'),
          render: (r) => {
            const rows = byProvider(r.id);
            const open = unverifiedAccounts(rows);
            return (
              <span>
                <Ltr>{String(r.accountCount)}</Ltr>
                {open > 0 && (
                  <>
                    {' '}
                    <Badge tone="warn">
                      {t(p.locale, 'm05.adm.reg.unverified', { count: open })}
                    </Badge>
                  </>
                )}
              </span>
            );
          },
        },
        {
          key: 'c',
          header: t(p.locale, 'm05.adm.col.circuit'),
          render: (r) => {
            const rows = byProvider(r.id);
            return rows.length === 0 ? (
              <span className="nz-muted">—</span>
            ) : (
              <BreakerBadge locale={p.locale} breaker={{ state: worstBreaker(rows) }} />
            );
          },
        },
      ]}
    />
  );
}

/** Health and circuit-breaker state of every account (the breaker snapshot comes from the framework wrapper, per account). */
export function AccountHealthTable(p: { locale: Locale; accounts: AccountDto[] }) {
  if (p.accounts.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.acc.empty.title')}
        body={t(p.locale, 'm05.adm.acc.empty.body')}
      />
    );
  return (
    <Table
      caption={t(p.locale, 'm05.adm.reg.health')}
      rows={p.accounts}
      rowKey={(a) => a.id}
      columns={[
        {
          key: 'n',
          header: t(p.locale, 'm05.adm.col.account'),
          render: (a) => <a href={`/${p.locale}/providers/accounts/${a.id}`}>{a.name}</a>,
        },
        {
          key: 'p',
          header: t(p.locale, 'm05.adm.col.provider'),
          render: (a) => <Ltr>{a.providerKey}</Ltr>,
        },
        {
          key: 'h',
          header: t(p.locale, 'm05.adm.col.health'),
          render: (a) => <HealthBadge locale={p.locale} state={a.health?.state} />,
        },
        {
          key: 'b',
          header: t(p.locale, 'm05.adm.col.circuit'),
          render: (a) => <BreakerBadge locale={p.locale} breaker={a.health?.breaker} />,
        },
        {
          key: 'l',
          header: t(p.locale, 'm05.adm.col.lastHealth'),
          render: (a) =>
            a.health?.lastHealthAt ? formatDateTime(a.health.lastHealthAt, p.locale) : '—',
        },
        {
          key: 'v',
          header: t(p.locale, 'm05.adm.col.verified'),
          render: (a) =>
            a.verifiedAt ? (
              formatDateTime(a.verifiedAt, p.locale)
            ) : (
              <Badge tone="warn">{t(p.locale, 'm05.adm.acc.notVerified')}</Badge>
            ),
        },
      ]}
    />
  );
}
