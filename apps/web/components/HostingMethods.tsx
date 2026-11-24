import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import { SITE_METHODS, type SiteMethod } from '../lib/hosting-catalog';

const ICON: Record<SiteMethod, IconName> = {
  ai: 'sparkle',
  wordpress: 'grid',
  static: 'globe',
  php: 'code',
  nodejs: 'data',
};

/**
 * "How do you want to build your website?": the ways to add a website. The AI agent opens the AI builder; static, PHP and Node.js continue to the plan
 * and details with that runtime; WordPress is listed but cannot be chosen until the platform can install it. Server component: plain links.
 */
export function HostingMethods({
  locale,
  query,
}: {
  locale: Locale;
  /** Kept on every link (a chosen plan or a domain the website is for). */
  query: Record<string, string>;
}) {
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...query, ...extra });
    return `?${p.toString()}`;
  };
  return (
    <div className="nzc-methods" role="list">
      {SITE_METHODS.map((m) => {
        const body = (
          <>
            <span className="nzc-method-ico" aria-hidden="true">
              <Icon name={ICON[m.id]} size={22} />
            </span>
            <h3>{t(locale, `host.method.${m.id}` as MessageKey)}</h3>
            <p>{t(locale, `host.method.${m.id}.tag` as MessageKey)}</p>
            {!m.available && (
              <span className="nzc-method-soon">{t(locale, 'host.method.soon')}</span>
            )}
          </>
        );
        return m.available ? (
          <a
            key={m.id}
            role="listitem"
            className="nzc-method"
            data-featured={m.id === 'ai' ? 'true' : undefined}
            href={
              m.id === 'ai'
                ? `/builder/projects`
                : `/hosting/sites/new${qs({ method: m.id })}`
            }
          >
            {body}
          </a>
        ) : (
          <div
            key={m.id}
            role="listitem"
            className="nzc-method"
            data-soon="true"
            aria-disabled="true"
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
