'use client';
import { useId, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Art, Button, Icon, type ArtName, type IconName } from '@nuzm/ui';
import { CART_MAX } from '../lib/cart';
import { addToCart } from '../lib/cart-client';
import {
  COMPARE_ROWS,
  RUNTIME_GROUPS,
  compareValue,
  gbText,
  offersRuntime,
  typesWithPlans,
  type CatalogPlan,
  type HostingType,
} from '../lib/hosting-catalog';

const TYPE_ART: Record<HostingType, ArtName> = {
  web: 'hosting',
  cloud: 'cloud',
  webapp: 'builder',
  agency: 'agency',
};
const TYPE_ICON: Record<HostingType, IconName> = {
  web: 'hosting',
  cloud: 'cloud',
  webapp: 'code',
  agency: 'organization',
};
const EVERY = ['ssl', 'backups', 'domains', 'usage', 'residency'] as const;
const FAQ = [1, 2, 3] as const;

/** "Choose plan": puts the plan in the basket (one website) and says so; the floating basket opens. */
function ChoosePlan({
  locale,
  orgId,
  plan,
  secondary,
}: {
  locale: Locale;
  orgId: string;
  plan: CatalogPlan;
  secondary?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'added' | 'full'>('idle');
  return (
    <>
      <Button
        variant={secondary ? 'secondary' : 'primary'}
        onClick={() => {
          setState(addToCart(orgId, plan).ok ? 'added' : 'full');
          window.setTimeout(() => setState('idle'), 2200);
        }}
      >
        {state === 'added' ? (
          <>
            <Icon name="check" size={16} /> {t(locale, 'host.shop.added')}
          </>
        ) : (
          t(locale, 'host.shop.choose')
        )}
      </Button>
      {state === 'full' && (
        <span className="nz-error-text" role="alert">
          {t(locale, 'cart.full', { max: CART_MAX })}
        </span>
      )}
    </>
  );
}

/**
 * "Get new hosting": hosting TYPES as tabs, each with its plans as cards (the headline limits and the runtimes), then a side-by-side comparison of the
 * selected type, what every plan includes, and a short FAQ. Everything shown is read from the plans the API returns; a plan without an approved
 * price says the price is shown at checkout.
 */
export function HostingShop({
  locale,
  plans,
  prices,
  initialType,
  orgId,
}: {
  locale: Locale;
  /** The organization whose basket a chosen plan goes into. */
  orgId: string;
  plans: CatalogPlan[];
  /** Display price per plan id, or null when it is quoted at checkout. */
  prices: Record<string, string | null>;
  initialType?: HostingType;
}) {
  const groups = typesWithPlans(plans);
  const [type, setType] = useState<HostingType>(
    groups.some((g) => g.type === initialType)
      ? (initialType as HostingType)
      : (groups[0]?.type ?? 'web'),
  );
  const [compare, setCompare] = useState(false);
  const uid = useId();
  const group = groups.find((g) => g.type === type) ?? groups[0];
  if (!group) return null;
  const typeName = (x: HostingType) => t(locale, `host.type.${x}` as MessageKey);
  const planName = (p: CatalogPlan) => p.name[locale];

  return (
    <div className="nzc-shop hs">
      <header className="hs-hero">
        <div className="hs-glow" aria-hidden="true" />
        <div className="hs-hero-copy">
          <span className="hs-pill">{t(locale, 'host.shop.eyebrow')}</span>
          <h2>{t(locale, 'host.shop.title')}</h2>
          <p>{t(locale, 'host.shop.sub')}</p>
        </div>
        <div className="hs-hero-art" aria-hidden="true">
          <Art name={TYPE_ART[type]} />
        </div>
      </header>

      <div className="hs-body" id={`${uid}-plans`}>
        <div className="hs-types" role="tablist" aria-label={t(locale, 'host.shop.types')}>
          {groups.map((g) => (
            <button
              key={g.type}
              type="button"
              role="tab"
              className="hs-type"
              id={`${uid}-tab-${g.type}`}
              aria-selected={g.type === type}
              aria-controls={`${uid}-panel`}
              tabIndex={g.type === type ? 0 : -1}
              onClick={() => {
                setType(g.type);
                setCompare(false);
              }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                // the tab list is mirrored in Arabic, so the arrow that points at the next tab is the opposite one
                const i = groups.findIndex((x) => x.type === type);
                const j = (i + (locale === 'ar' ? -step : step) + groups.length) % groups.length;
                setType(groups[j]!.type);
                document.getElementById(`${uid}-tab-${groups[j]!.type}`)?.focus();
              }}
            >
              <span className="hs-type-icon" aria-hidden="true">
                <Icon name={TYPE_ICON[g.type]} size={20} />
              </span>
              {typeName(g.type)}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${type}`}>
          <p className="hs-tag">
            <strong>{typeName(type)}</strong>
            <span>{t(locale, `host.type.${type}.tag` as MessageKey)}</span>
          </p>
          <div className="hs-grid">
            {group.plans.map((p) => (
              <article key={p.id} className="hs-plan" aria-labelledby={`${uid}-p-${p.id}`}>
                <div className="hs-plan-top">
                  <h3 id={`${uid}-p-${p.id}`}>{planName(p)}</h3>
                  <span className="hs-plan-mark" aria-hidden="true">
                    <Icon name={TYPE_ICON[type]} size={20} />
                  </span>
                </div>
                <p className="hs-price">
                  {prices[p.id] ? (
                    <strong dir="ltr">{prices[p.id]}</strong>
                  ) : (
                    <span className="nz-muted">{t(locale, 'host.shop.priceLater')}</span>
                  )}
                </p>
                <ul className="hs-specs">
                  <li>
                    <Icon name="check" size={16} />
                    {p.quotas.sitesCount === 1
                      ? t(locale, 'host.shop.perPlanSite')
                      : t(locale, 'host.shop.perPlanSites', { n: p.quotas.sitesCount })}
                  </li>
                  <li>
                    <Icon name="check" size={16} />
                    {t(locale, 'host.plan.card', {
                      disk: gbText(p.quotas.diskMb),
                      traffic: p.quotas.bandwidthGb,
                      dbs: p.quotas.dbCount,
                    })}
                  </li>
                </ul>
                <div className="hs-runtimes">
                  <span className="nz-muted">{t(locale, 'host.shop.includes')}</span>
                  {RUNTIME_GROUPS.filter((g) => offersRuntime(p, g.match)).map((g) => (
                    <span key={g.id} className="hs-chip" dir="ltr">
                      {g.label}
                    </span>
                  ))}
                </div>
                <div className="hs-choose">
                  <ChoosePlan locale={locale} orgId={orgId} plan={p} />
                </div>
              </article>
            ))}
          </div>

          <button
            type="button"
            className="nzc-shop-compare-btn"
            aria-expanded={compare}
            aria-controls={`${uid}-compare`}
            onClick={() => setCompare(!compare)}
          >
            {compare ? t(locale, 'host.shop.compare.hide') : t(locale, 'host.shop.compare')}
            <span className="nzc-shop-chev" data-open={compare ? 'true' : undefined}>
              <Icon name="chevron" size={16} />
            </span>
          </button>
          {compare && (
            <div className="nzc-shop-table-wrap" id={`${uid}-compare`}>
              <table className="nzc-shop-table">
                <caption className="nz-sr">
                  {t(locale, 'host.shop.compare.caption', { type: typeName(type) })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t(locale, 'host.shop.feature')}</th>
                    {group.plans.map((p) => (
                      <th key={p.id} scope="col">
                        <span>{planName(p)}</span>
                        <ChoosePlan locale={locale} orgId={orgId} plan={p} secondary />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row}>
                      <th scope="row">{t(locale, `host.row.${row}` as MessageKey)}</th>
                      {group.plans.map((p) => {
                        const v = compareValue(p, row);
                        return (
                          <td key={p.id}>
                            {v.kind === 'text' && <span dir="ltr">{v.value}</span>}
                            {v.kind === 'yes' && (
                              <span className="nzc-shop-yes">
                                <Icon name="check" size={18} />
                                <span className="nz-sr">{t(locale, 'host.shop.yes')}</span>
                              </span>
                            )}
                            {v.kind === 'no' && (
                              <span className="nz-muted">
                                —<span className="nz-sr">{t(locale, 'host.shop.no')}</span>
                              </span>
                            )}
                            {v.kind === 'unknown' && (
                              <span className="nz-muted">
                                —<span className="nz-sr">{t(locale, 'host.shop.unknown')}</span>
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <section className="nzc-shop-every" aria-labelledby={`${uid}-every`}>
        <h3 id={`${uid}-every`}>{t(locale, 'host.every.title')}</h3>
        <ul>
          {EVERY.map((k) => (
            <li key={k}>
              <Icon name="check" size={16} />
              {t(locale, `host.every.${k}` as MessageKey)}
            </li>
          ))}
        </ul>
      </section>

      <section className="nzc-shop-faq" aria-labelledby={`${uid}-faq`}>
        <h3 id={`${uid}-faq`}>{t(locale, 'host.faq.title')}</h3>
        {FAQ.map((n) => (
          <details key={n}>
            <summary>{t(locale, `host.faq.q${n}` as MessageKey)}</summary>
            <p>{t(locale, `host.faq.a${n}` as MessageKey)}</p>
          </details>
        ))}
      </section>
    </div>
  );
}
