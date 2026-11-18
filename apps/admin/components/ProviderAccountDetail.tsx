import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, Table } from '@nuzm/ui';
import {
  capabilityTone,
  capabilityView,
  evidenceKindTone,
  formatCost,
  regionTone,
  regionVerification,
  safeCredentialRef,
  type AccountDto,
  type CapabilityRow,
  type PlanRow,
  type RegionRow,
} from '../lib/providers';
import { Kv } from './ProviderCommon';
import { BreakerBadge, HealthBadge } from './ProviderRegistry';

/** Account facts. The vault reference is shown, a credential value never is. */
export function AccountSummary({ locale, a }: { locale: Locale; a: AccountDto }) {
  const ref = safeCredentialRef(a.credentialRef);
  return (
    <dl>
      <Kv label={t(locale, 'm05.adm.col.provider')}>
        <Ltr>{a.providerKey}</Ltr> (<Ltr>{a.adapterId}</Ltr>)
      </Kv>
      <Kv label={t(locale, 'm05.adm.col.credentialRef')}>
        {ref ? (
          <Ltr>{ref}</Ltr>
        ) : (
          <span className="nz-muted">{t(locale, 'm05.adm.acc.refHidden')}</span>
        )}
      </Kv>
      <Kv label={t(locale, 'm05.adm.col.status')}>
        {tDynamic(locale, `m05.adm.status.${a.status}`, a.status)}
      </Kv>
      <Kv label={t(locale, 'm05.adm.col.health')}>
        <HealthBadge locale={locale} state={a.health?.state} />{' '}
        <BreakerBadge locale={locale} breaker={a.health?.breaker} />
      </Kv>
      <Kv label={t(locale, 'm05.adm.col.verified')}>
        {a.verifiedAt ? (
          formatDateTime(a.verifiedAt, locale)
        ) : (
          <Badge tone="warn">{t(locale, 'm05.adm.acc.notVerified')}</Badge>
        )}
      </Kv>
      <Kv label={t(locale, 'm05.adm.col.spendCap')}>
        {a.spendCap ? <Ltr>{formatCost(a.spendCap.amountMinor, a.spendCap.currency)}</Ltr> : '—'}
      </Kv>
      {a.scopeNote && <Kv label={t(locale, 'm05.adm.acc.scopeNote')}>{a.scopeNote}</Kv>}
    </dl>
  );
}

/**
 * The capability matrix. `unknown` (never probed) is shown as UNSUPPORTED, exactly like `unsupported`: the platform treats both the same
 * way and the screen must not suggest otherwise.
 */
export function CapabilityTable({ locale, rows }: { locale: Locale; rows: CapabilityRow[] }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.cap.empty.title')}
        body={t(locale, 'm05.adm.cap.empty.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm05.adm.cap.title')}
      rows={rows}
      rowKey={(r) => r.capabilityId}
      columns={[
        {
          key: 'c',
          header: t(locale, 'm05.adm.cap.col.capability'),
          render: (r) => (
            <span>
              {tDynamic(locale, `m05.adm.cap.id.${r.capabilityId}`, r.capabilityId)}{' '}
              <span className="nz-muted">
                <Ltr>{r.capabilityId}</Ltr>
              </span>
            </span>
          ),
        },
        {
          key: 's',
          header: t(locale, 'm05.adm.cap.col.state'),
          render: (r) => (
            <span>
              <Badge tone={capabilityTone(r)}>
                {t(locale, `m05.adm.cap.${capabilityView(r.state)}`)}
              </Badge>
              {r.state === 'unknown' && (
                <>
                  {' '}
                  <span className="nz-muted">{t(locale, 'm05.adm.cap.notProbed')}</span>
                </>
              )}
            </span>
          ),
        },
        {
          key: 'p',
          header: t(locale, 'm05.adm.cap.col.probedAt'),
          render: (r) => (r.probedAt ? formatDateTime(r.probedAt, locale) : '—'),
        },
        {
          key: 'e',
          header: t(locale, 'm05.adm.col.evidence'),
          render: (r) => (r.evidenceRef ? <Ltr>{r.evidenceRef}</Ltr> : '—'),
        },
      ]}
    />
  );
}

/**
 * Regions with their evidence. "Verified" is shown (green) only for a verified region whose evidence kind is `live`; verified on fixture or
 * mock evidence reads NOT VERIFIED, with the evidence kind next to it.
 */
export function RegionsTable({ locale, rows }: { locale: Locale; rows: RegionRow[] }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.reg2.empty.title')}
        body={t(locale, 'm05.adm.reg2.empty.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm05.adm.reg2.title')}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'r',
          header: t(locale, 'm05.adm.reg2.col.region'),
          render: (r) => (
            <span>
              <Ltr>{r.providerRegionId}</Ltr>
              {r.displayName && <span className="nz-muted"> — {r.displayName}</span>}
            </span>
          ),
        },
        { key: 'c', header: t(locale, 'field.country'), render: (r) => <Ltr>{r.countryCode}</Ltr> },
        {
          key: 's',
          header: t(locale, 'm05.adm.col.status'),
          render: (r) => {
            const v = regionVerification(r);
            return <Badge tone={regionTone(v)}>{t(locale, `m05.adm.reg2.v.${v}`)}</Badge>;
          },
        },
        {
          key: 'k',
          header: t(locale, 'm05.adm.reg2.col.kind'),
          render: (r) =>
            r.evidenceKind ? (
              <Badge tone={evidenceKindTone(r.evidenceKind)}>
                {t(locale, `m05.adm.evidence.${r.evidenceKind}`)}
              </Badge>
            ) : (
              <span className="nz-muted">{t(locale, 'm05.adm.evidence.none')}</span>
            ),
        },
        {
          key: 'v',
          header: t(locale, 'm05.adm.reg2.col.verifiedAt'),
          render: (r) => (r.verifiedAt ? formatDateTime(r.verifiedAt, locale) : '—'),
        },
        {
          key: 'e',
          header: t(locale, 'm05.adm.col.evidence'),
          render: (r) => (r.evidenceRef ? <Ltr>{r.evidenceRef}</Ltr> : '—'),
        },
      ]}
    />
  );
}

/** Plans of the last catalog sync, with the provider's own price (integer minor units, the vendor's currency; no conversion). */
export function PlansTable({ locale, rows }: { locale: Locale; rows: PlanRow[] }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.plan.empty.title')}
        body={t(locale, 'm05.adm.plan.empty.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm05.adm.plan.title')}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'p',
          header: t(locale, 'm05.adm.plan.col.plan'),
          render: (r) => <Ltr>{r.planRef}</Ltr>,
        },
        {
          key: 'r',
          header: t(locale, 'm05.adm.reg2.col.region'),
          render: (r) => <Ltr>{r.providerRegionId}</Ltr>,
        },
        {
          key: 'v',
          header: t(locale, 'm05.adm.plan.col.vcpu'),
          render: (r) => <Ltr>{String(r.vcpu)}</Ltr>,
        },
        {
          key: 'm',
          header: t(locale, 'm05.adm.plan.col.memory'),
          render: (r) => <Ltr>{String(r.memoryMb)}</Ltr>,
        },
        {
          key: 'd',
          header: t(locale, 'm05.adm.plan.col.disk'),
          render: (r) => <Ltr>{String(r.diskGb)}</Ltr>,
        },
        {
          key: 'c',
          header: t(locale, 'm05.adm.plan.col.cost'),
          render: (r) =>
            r.providerPrice?.amountMinor && r.providerPrice.currency ? (
              <Ltr>
                {formatCost(r.providerPrice.amountMinor, r.providerPrice.currency)}
                {r.providerPrice.period
                  ? ` / ${t(locale, `m05.adm.plan.${r.providerPrice.period}`)}`
                  : ''}
              </Ltr>
            ) : (
              <span className="nz-muted">{t(locale, 'm05.adm.plan.noPrice')}</span>
            ),
        },
        {
          key: 'a',
          header: t(locale, 'm05.adm.plan.col.availability'),
          render: (r) => (
            <Badge tone={r.availability === 'available' ? undefined : 'warn'}>
              {tDynamic(locale, `m05.adm.plan.av.${r.availability}`, r.availability)}
            </Badge>
          ),
        },
      ]}
    />
  );
}
