'use client';
import { useState, type FormEvent } from 'react';
import { Icon } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { SOLD_TLDS, money, reasonKey } from '../../lib/domains';

/** One answer of the domain search (`GET /v1/public/domains/search`), the same shape the dashboard's search shows. */
interface Item {
  name: string;
  tld: string;
  available: boolean | 'unknown' | null;
  premium: boolean;
  price: { amountMinor: string; currency: string } | null;
  eligibility: { state: 'allowed' | 'blocked'; rule: string; reason: string };
  purchasable: boolean;
}
const stateOf = (r: Item): 'blocked' | 'available' | 'taken' | 'unknown' =>
  r.eligibility.state === 'blocked'
    ? 'blocked'
    : r.available === true
      ? 'available'
      : r.available === false
        ? 'taken'
        : 'unknown';

/**
 * The public domains page's tool: the dashboard's domain checker (name, extensions, the answer with its status and price) and its transfer entry, in the
 * dashboard's own wording. The checker asks the public search endpoint (same rules as the dashboard: unknown is never "available", only verified registrar
 * capabilities); BUYING happens in the dashboard, so "Register" opens the dashboard's search for that exact name (signing in first when needed). The transfer form
 * is a plain GET form to the dashboard's transfer page and never asks for an authorization code on a public page.
 */
export function DomainTools({ locale }: { locale: Locale }) {
  const [tab, setTab] = useState<'register' | 'transfer'>('register');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);
  async function check(e: FormEvent) {
    e.preventDefault();
    const name = q.trim();
    if (!name) return;
    setBusy(true);
    setFailed(false);
    try {
      const url = new URL('/v1/public/domains/search', window.location.origin);
      url.searchParams.set('q', name);
      if (picked.length) url.searchParams.set('tlds', picked.join(','));
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      setItems(((await res.json()) as { items: Item[] }).items);
    } catch {
      setItems(null);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const best =
    items?.find((r) => r.name === q.trim().toLowerCase() && stateOf(r) === 'available') ??
    items?.find((r) => r.purchasable && stateOf(r) === 'available') ??
    items?.find((r) => stateOf(r) === 'available');
  const rest = items?.filter((r) => r !== best) ?? [];
  const status = (r: Item) => {
    const st = stateOf(r);
    return st === 'available'
      ? t(locale, 'dom.search.available') +
          (r.premium ? ` — ${t(locale, 'dom.search.premium')}` : '')
      : st === 'taken'
        ? t(locale, 'dom.search.taken')
        : st === 'blocked'
          ? `${t(locale, 'dom.search.blocked')}: ${t(locale, reasonKey(r.eligibility.rule))}`
          : `${t(locale, 'dom.search.unknown')} — ${t(locale, 'dom.search.stale')}`;
  };
  const priceOf = (r: Item) =>
    r.price ? (
      <>
        <strong dir="ltr">{money(r.price.amountMinor, r.price.currency)}</strong>
        <small>{t(locale, 'dom.search.perYear')}</small>
      </>
    ) : stateOf(r) === 'available' ? (
      <small>{t(locale, 'dom.search.noPrice')}</small>
    ) : null;
  const action = (r: Item) =>
    r.purchasable ? (
      <a className="button button-blue" href={`/domains/search?q=${encodeURIComponent(r.name)}`}>
        {locale === 'ar' ? 'سجّل النطاق' : 'Register'}
      </a>
    ) : stateOf(r) === 'available' ? (
      <small>{t(locale, 'dom.search.notForSale')}</small>
    ) : null;
  return (
    <section className="section wrap svc-section dt-section" aria-labelledby="dt-title">
      <div className="dt-card">
        <div className="dt-head">
          <span className="eyebrow">{t(locale, 'dom.search.title')}</span>
          <h2 id="dt-title">{t(locale, 'dom.search.hero')}</h2>
          <p>{t(locale, 'dom.hero.body')}</p>
        </div>
        <div className="dt-tabs" role="tablist" aria-label={t(locale, 'dom.search.title')}>
          {(
            [
              ['register', t(locale, 'dom.tab.search')],
              ['transfer', t(locale, 'dom.tab.transfers')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`dt-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`dt-panel-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          id="dt-panel-register"
          role="tabpanel"
          aria-labelledby="dt-tab-register"
          hidden={tab !== 'register'}
          className="dt-panel"
        >
          <form className="dt-panel" onSubmit={check} role="search" action="/domains/search">
            <div className="dt-field">
              <Icon name="search" size={22} />
              <input
                name="q"
                dir="ltr"
                required
                autoComplete="off"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label={t(locale, 'dom.search.q')}
                placeholder={t(locale, 'dom.search.placeholder')}
              />
              <button type="submit" className="button button-blue" disabled={busy}>
                {t(locale, 'dom.search.go')} <Icon name="arrow" size={16} />
              </button>
            </div>
            <div className="dt-tlds" role="group" aria-label={t(locale, 'dom.search.extensions')}>
              <p>{t(locale, 'dom.search.extensions')}</p>
              <div>
                {SOLD_TLDS.map((x) => (
                  <label key={x}>
                    <input
                      type="checkbox"
                      name="tlds"
                      value={x}
                      checked={picked.includes(x)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, x] : picked.filter((p) => p !== x))
                      }
                    />
                    <span dir="ltr">.{x}</span>
                    <small>{t(locale, 'dom.search.extHint')}</small>
                  </label>
                ))}
              </div>
            </div>
            <p className="dt-note">{t(locale, 'dom.search.help')}</p>
          </form>
          <div aria-live="polite" className="dt-results">
            {failed && <p className="dt-error">{t(locale, 'state.error.title')}</p>}
            {items && (
              <>
                <h3>{t(locale, 'dom.search.results')}</h3>
                {best && (
                  <div className="dt-best">
                    <div>
                      <span className="dt-kicker">
                        <Icon name="check" size={15} /> {t(locale, 'dom.search.best')}
                      </span>
                      <div className="dt-name" dir="ltr">
                        {best.name}
                      </div>
                      <span className="dt-status is-available">{status(best)}</span>
                    </div>
                    <div className="dt-side">
                      <div className="dt-price">{priceOf(best)}</div>
                      {action(best)}
                    </div>
                  </div>
                )}
                <ul className="dt-list">
                  {rest.map((r) => (
                    <li key={r.name}>
                      <span className="dt-name" dir="ltr">
                        {r.name}
                      </span>
                      <span className={`dt-status is-${stateOf(r)}`}>{status(r)}</span>
                      <span className="dt-price">{priceOf(r)}</span>
                      {action(r)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <form
          id="dt-panel-transfer"
          role="tabpanel"
          aria-labelledby="dt-tab-transfer"
          hidden={tab !== 'transfer'}
          className="dt-panel"
          method="get"
          action="/domains/transfers"
        >
          <ol className="dt-steps">
            {(['dom.tr.step1', 'dom.tr.step2', 'dom.tr.step3'] as const).map((k, i) => (
              <li key={k}>
                <b>{i + 1}</b>
                {t(locale, k)}
              </li>
            ))}
          </ol>
          <div className="dt-field">
            <Icon name="globe" size={22} />
            <input
              name="domain"
              dir="ltr"
              required
              autoComplete="off"
              spellCheck={false}
              aria-label={t(locale, 'dom.search.q')}
              placeholder="mybrand.com"
            />
            <button type="submit" className="button button-blue">
              {t(locale, 'dom.tr.go')} <Icon name="arrow" size={16} />
            </button>
          </div>
          <p className="dt-note">
            <Icon name="lock" size={14} /> {t(locale, 'dom.tr.authHelp')}
          </p>
        </form>
      </div>
    </section>
  );
}
