'use client';
import { useState } from 'react';
import { Icon } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { SOLD_TLDS } from '../../lib/domains';

/**
 * The public domains page's tool: the dashboard's two ways in (register a new domain, transfer one you already own) with the dashboard's own wording.
 * Nothing is searched, bought or collected here: both forms are plain GET forms that open the dashboard's search / transfer page (signing in first when needed),
 * where availability, prices and the authorization code are handled. The authorization code is never asked for on a public page.
 */
export function DomainTools({ locale }: { locale: Locale }) {
  const [tab, setTab] = useState<'register' | 'transfer'>('register');
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

        <form
          id="dt-panel-register"
          role="tabpanel"
          aria-labelledby="dt-tab-register"
          hidden={tab !== 'register'}
          className="dt-panel"
          method="get"
          action="/domains/search"
        >
          <div className="dt-field">
            <Icon name="search" size={22} />
            <input
              name="q"
              dir="ltr"
              required
              autoComplete="off"
              spellCheck={false}
              aria-label={t(locale, 'dom.search.q')}
              placeholder={t(locale, 'dom.search.placeholder')}
            />
            <button type="submit" className="button button-blue">
              {t(locale, 'dom.search.go')} <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="dt-tlds" role="group" aria-label={t(locale, 'dom.search.extensions')}>
            <p>{t(locale, 'dom.search.extensions')}</p>
            <div>
              {SOLD_TLDS.map((x) => (
                <label key={x}>
                  <input type="checkbox" name="tlds" value={x} />
                  <span dir="ltr">.{x}</span>
                  <small>{t(locale, 'dom.search.extHint')}</small>
                </label>
              ))}
            </div>
          </div>
          <p className="dt-note">{t(locale, 'dom.search.help')}</p>
        </form>

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
