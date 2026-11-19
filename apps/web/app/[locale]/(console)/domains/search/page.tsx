import { AddDomainToCart } from '../../../../../components/AddDomainToCart';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { unwrap, type components } from '@nuzm/sdk';
import { isLocale, t, type Locale } from '@nuzm/i18n';
import { Art, Badge, ForbiddenState, Icon, Ltr, PageTitle } from '@nuzm/ui';
import { money, reasonKey, SOLD_TLDS, tldsParam } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Item = components['schemas']['DomainSearchItem'];

/** One row's state, from the search answer only: unknown is never shown as available. */
const stateOf = (r: Item): 'blocked' | 'available' | 'taken' | 'unknown' =>
  r.eligibility.state === 'blocked'
    ? 'blocked'
    : r.available === true
      ? 'available'
      : r.available === false
        ? 'taken'
        : 'unknown';

function Status({ locale, r }: { locale: Locale; r: Item }): ReactNode {
  switch (stateOf(r)) {
    case 'blocked':
      return (
        <span>
          <Badge tone="warn">{t(locale, 'dom.search.blocked')}</Badge>{' '}
          <span className="nz-muted">{t(locale, reasonKey(r.eligibility.rule))}</span>
        </span>
      );
    case 'available':
      return (
        <Badge tone="success">
          {t(locale, 'dom.search.available')}
          {r.premium ? ` — ${t(locale, 'dom.search.premium')}` : ''}
        </Badge>
      );
    case 'taken':
      return <Badge>{t(locale, 'dom.search.taken')}</Badge>;
    default:
      return (
        <span>
          <Badge tone="warn">{t(locale, 'dom.search.unknown')}</Badge>{' '}
          <span className="nz-muted">{t(locale, 'dom.search.stale')}</span>
        </span>
      );
  }
}

/**
 * UI-M07-02: a search hero (name + the extensions the sales policy enables), then the answer: the best purchasable name as a featured card,
 * and every other name with its status, price and reason. A TLD that is not sold is shown disabled WITH the reason; unknown answers are
 * never "available"; prices only ever come from the search answer.
 */
export default async function Search({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; tlds?: string | string[] }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:search'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.search.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const q = (sp.q ?? '').trim();
  const tlds = tldsParam(sp.tlds);
  const picked = new Set(tlds?.split(',') ?? []);
  const canBuy = s.can('domain:write');
  const orgId = s.org.orgId;
  // an available name that cannot be bought (no verified registrar, no price) says so instead of leaving a gap
  const buy = (r: Item, label?: string) =>
    r.purchasable && canBuy ? (
      <AddDomainToCart locale={locale} orgId={orgId} name={r.name} price={r.price} label={label} />
    ) : stateOf(r) === 'available' && !r.purchasable ? (
      <span className="nz-muted">{t(locale, 'dom.search.notForSale')}</span>
    ) : null;
  const price = (r: Item) =>
    r.price ? (
      <Ltr>{money(r.price.amountMinor, r.price.currency)}</Ltr>
    ) : stateOf(r) === 'available' ? (
      <span className="nz-muted">{t(locale, 'dom.search.noPrice')}</span>
    ) : (
      '—'
    );

  const form = (
    <form method="get" className="nzc-dsearch" role="search" aria-labelledby="ds-h">
      <div className="nzc-dsearch-inner">
        <Art name="domains" className="nzc-dsearch-art" />
        <h2 id="ds-h">{t(locale, 'dom.search.hero')}</h2>
        <p className="nzc-dsearch-sub">{t(locale, 'dom.hero.body')}</p>
        <div className="nzc-dsearch-bar">
          <div className="nzc-dsearch-field">
            <Icon name="search" />
            <input
              id="sq"
              name="q"
              className="nzc-dsearch-input"
              dir="ltr"
              defaultValue={q}
              required
              autoComplete="off"
              spellCheck={false}
              aria-label={t(locale, 'dom.search.q')}
              placeholder={t(locale, 'dom.search.placeholder')}
            />
            <button className="nz-btn" type="submit" aria-label={t(locale, 'dom.search.go')}>
              <span>{t(locale, 'dom.search.go')}</span>
              <Icon name="arrow" size={18} />
            </button>
          </div>
        </div>
        <div className="nzc-tlds" role="group" aria-labelledby="ds-tlds">
          <p className="nzc-tlds-title" id="ds-tlds">
            {t(locale, 'dom.search.extensions')}
          </p>
          <div className="nzc-tlds-grid">
            {SOLD_TLDS.map((x) => (
              <label key={x} className="nzc-tld">
                <span className="nzc-tld-name">.{x}</span>
                <input type="checkbox" name="tlds" value={x} defaultChecked={picked.has(x)} />
                <span className="nzc-tld-hint">{t(locale, 'dom.search.extHint')}</span>
              </label>
            ))}
          </div>
        </div>
        <p className="nzc-dsearch-note">{t(locale, 'dom.search.help')}</p>
      </div>
    </form>
  );

  const results = q
    ? await view(
        locale,
        () =>
          unwrap(
            s.api.GET('/v1/domains/search', {
              params: { query: { q, ...(tlds ? { tlds } : {}) } },
            }),
          ),
        (data) => {
          // the featured card: the exact name typed if it is available, else the first one that can be bought, else the first available
          const want = q.toLowerCase();
          const best =
            data.items.find((r) => r.name === want && stateOf(r) === 'available') ??
            data.items.find((r) => r.purchasable && stateOf(r) === 'available') ??
            data.items.find((r) => stateOf(r) === 'available');
          const rest = data.items.filter((r) => r !== best);
          return (
            <section aria-labelledby="dr-h">
              <div className="nzc-dres-head">
                <h2 id="dr-h">{t(locale, 'dom.search.results')}</h2>
              </div>
              {best && (
                <div className="nzc-dres-best">
                  <div>
                    <span className="nzc-kicker">
                      <Icon name="check" size={16} />
                      {t(locale, 'dom.search.best')}
                    </span>
                    <div className="nzc-dname">
                      <Ltr>{best.name}</Ltr>
                    </div>
                    <Status locale={locale} r={best} />
                  </div>
                  <div className="nzc-dres-price">
                    <div>
                      {best.price ? <strong>{price(best)}</strong> : price(best)}
                      {best.price && <small>{t(locale, 'dom.search.perYear')}</small>}
                    </div>
                    {buy(best)}
                  </div>
                </div>
              )}
              {rest.length > 0 && (
                <>
                  {best && (
                    <div className="nzc-dres-head">
                      <h3>{t(locale, 'dom.search.more')}</h3>
                    </div>
                  )}
                  <ul className="nzc-dres-list" aria-label={t(locale, 'dom.search.results')}>
                    {rest.map((r) => (
                      <li key={r.name} data-state={stateOf(r)}>
                        <span className="nzc-dname">
                          <Ltr>{r.name}</Ltr>
                        </span>
                        <Status locale={locale} r={r} />
                        <span className="nzc-dprice">
                          {price(r)}
                          {r.price && (
                            <span className="nz-muted"> · {t(locale, 'dom.search.perYear')}</span>
                          )}
                        </span>
                        <span>{buy(r, `${t(locale, 'dom.search.buy')} ${r.name}`)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          );
        },
      )
    : null;
  return (
    <>
      <a className="nzc-back" href={`/${locale}/domains`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.tab.list')}
      </a>
      <PageTitle>{t(locale, 'dom.search.title')}</PageTitle>
      {form}
      {results}
    </>
  );
}
