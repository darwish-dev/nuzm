import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Icon, Meter, type IconName } from '@nuzm/ui';

interface SiteFacts {
  runtime: string;
  planName: string;
  domains: { domain: string; state: string }[];
  /** plan limit per dimension (`disk_mb`, `bandwidth_gb`, ...) */
  limits: Record<string, number>;
  /** what the hosting node has reported so far (usually only disk and inodes) */
  used: Record<string, number | undefined>;
  diskLimitMb: number | null;
  diskUsedMb: number | undefined;
}

const nf = (x: number, locale: Locale, d = 0) =>
  x.toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-US', { maximumFractionDigits: d });
const amount = (v: number, unit: 'mb' | 'gb' | 'n', locale: Locale) =>
  unit === 'mb'
    ? v >= 1024
      ? `${nf(v / 1024, locale, 1)} GB`
      : `${nf(v, locale)} MB`
    : unit === 'gb'
      ? `${nf(v, locale)} GB`
      : nf(v, locale);

const MAIN: { dim: string; label: MessageKey; unit: 'mb' | 'gb' | 'n'; icon: IconName }[] = [
  { dim: 'disk_mb', label: 'host.usage.disk', unit: 'mb', icon: 'cloud' },
  { dim: 'bandwidth_gb', label: 'host.usage.bandwidth', unit: 'gb', icon: 'globe' },
  { dim: 'backup_count', label: 'host.tab.backups', unit: 'n', icon: 'data' },
  { dim: 'db_count', label: 'host.tab.databases', unit: 'n', icon: 'data' },
];
const MORE: { dim: string; label: MessageKey; unit: 'mb' | 'gb' | 'n' }[] = [
  { dim: 'memory_mb', label: 'host.dim.memory', unit: 'mb' },
  { dim: 'inodes', label: 'host.usage.inodes', unit: 'n' },
  { dim: 'processes', label: 'host.dim.processes', unit: 'n' },
  { dim: 'backup_gb', label: 'host.usage.backup', unit: 'gb' },
];

/**
 * The top of a website's page: what needs attention, the key numbers and every plan limit in one place. A number is a USAGE only when the hosting node reported it;
 * otherwise it is shown as the plan limit and says so (nothing is invented).
 */
export function HostingInsights({ locale, site }: { locale: Locale; site: SiteFacts }) {
  const waiting = site.domains.filter((d) => d.state !== 'active' && d.state !== 'removed').length;
  const pct =
    site.diskLimitMb && site.diskUsedMb !== undefined
      ? (site.diskUsedMb / site.diskLimitMb) * 100
      : null;
  const attention: { tone: 'warn' | 'danger'; icon: IconName; text: string }[] = [];
  if (site.domains.length === 0)
    attention.push({ tone: 'warn', icon: 'globe', text: t(locale, 'host.ins.attn.noDomain') });
  if (waiting > 0)
    attention.push({
      tone: 'warn',
      icon: 'globe',
      text: t(locale, 'host.ins.attn.domain', { n: waiting }),
    });
  if (pct !== null && pct >= 75)
    attention.push({
      tone: pct >= 90 ? 'danger' : 'warn',
      icon: 'cloud',
      text: t(locale, 'host.ins.attn.disk', { percent: Math.round(pct) }),
    });
  const measured = site.diskUsedMb !== undefined;
  return (
    <section className="nzc-insights" aria-labelledby="site-ins">
      <div className="nzc-insights-head">
        <h2 className="nzc-section-title" id="site-ins">
          {t(locale, 'host.ins.title')}
        </h2>
        <p className="nz-muted">
          {t(locale, measured ? 'host.ins.sub' : 'host.resources.limitsNote')}
        </p>
      </div>
      <div className="nzc-attn" role="status" aria-label={t(locale, 'host.ins.attn.title')}>
        {attention.length === 0 ? (
          <p className="nzc-attn-ok">
            <Icon name="check" size={16} /> {t(locale, 'host.ins.attn.ok')}
          </p>
        ) : (
          <ul>
            {attention.map((a) => (
              <li key={a.text} data-tone={a.tone}>
                <Icon name={a.icon} size={16} /> {a.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="nzc-insight-tiles">
        {MAIN.map(({ dim, label, unit, icon }) => {
          const lim = site.limits[dim];
          if (lim === undefined) return null;
          const u = site.used[dim];
          return (
            <div key={dim} className="nzc-insight">
              <span className="nzc-quota-label">
                <Icon name={icon} size={14} /> {t(locale, label)}
              </span>
              <span className="nzc-quota-value">
                {u === undefined ? (
                  amount(lim, unit, locale)
                ) : (
                  <>
                    {amount(u, unit, locale)} <small>/ {amount(lim, unit, locale)}</small>
                  </>
                )}
              </span>
              {u !== undefined ? (
                <Meter
                  label={t(locale, 'host.usage.meter', { dim: t(locale, label) })}
                  percent={lim ? (u / lim) * 100 : 0}
                />
              ) : (
                <small className="nz-muted">{t(locale, 'host.resources.limits')}</small>
              )}
            </div>
          );
        })}
      </div>
      <ul className="nzc-limit-chips" aria-label={t(locale, 'host.resources.limits')}>
        {MORE.map(({ dim, label, unit }) => {
          const lim = site.limits[dim];
          if (lim === undefined) return null;
          const u = site.used[dim];
          return (
            <li key={dim}>
              <span>{t(locale, label)}</span>
              <strong>
                {u === undefined
                  ? amount(lim, unit, locale)
                  : `${amount(u, unit, locale)} / ${amount(lim, unit, locale)}`}
              </strong>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
