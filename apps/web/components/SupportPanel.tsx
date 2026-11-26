'use client';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, useSupportDock, type IconName } from '@nuzm/ui';
import { BrandMark } from './BrandLogo';

/** The documentation the panel's Documentation tab lists (the same guides and API areas as the console copy at /documentation). */
export interface SupportDocs {
  /** the console copy's home, `/documentation` */
  home: string;
  guides: { href: string; title: string; summary: string; icon: IconName }[];
  reference: { href: string; title: string }[];
  referenceHome: string;
  endpoints: number;
}

export interface SupportTopic {
  id: string;
  label: string;
  href: string;
  icon: IconName;
}

/**
 * The support panel docked beside the page (opened from the top bar's support button). Two tabs, each with its icon:
 *  - Chat: a chat-style thread with a greeting and quick links to the areas of the console. You can type and "send": the message shows in the thread, but
 *    live chat with the support team has no service behind it yet, so it is marked "not sent" and nothing pretends it was delivered.
 *  - Documentation: the website documentation's guides and API areas, searchable, each opening its copy inside the console (/documentation).
 */
export function SupportPanel({
  locale,
  topics,
  docs,
}: {
  locale: Locale;
  topics: SupportTopic[];
  docs?: SupportDocs;
}) {
  const dock = useSupportDock();
  const [tab, setTab] = useState<'chat' | 'docs'>('chat');
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<{ id: number; text: string }[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [sent.length]);
  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    setSent((m) => [...m, { id: m.length + 1, text: text.slice(0, 2000) }]);
    setDraft('');
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send();
    if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
  };
  return (
    <div className="sup">
      <header className="sup-head">
        <span className="sup-avatar" aria-hidden="true">
          <BrandMark />
        </span>
        <div className="sup-title">
          <strong>{t(locale, 'sup.title')}</strong>
          <small>{t(locale, 'sup.sub')}</small>
        </div>
        <button
          type="button"
          className="sup-close"
          aria-label={t(locale, 'sup.close')}
          onClick={dock.close}
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      {docs && <SupportTabs locale={locale} tab={tab} onTab={setTab} />}
      {docs && tab === 'docs' ? (
        <SupportDocsView locale={locale} docs={docs} />
      ) : (
        <div
          className="sup-chat"
          {...(docs
            ? { role: 'tabpanel', id: 'sup-panel-chat', 'aria-labelledby': 'sup-tab-chat' }
            : {})}
        >
          <div className="sup-thread" role="log" aria-label={t(locale, 'sup.title')}>
            <div className="sup-msg">
              <span className="sup-msg-avatar" aria-hidden="true">
                <BrandMark />
              </span>
              <p>{t(locale, 'sup.greeting')}</p>
            </div>
            {(topics.length > 0 || docs) && (
              <nav className="sup-topics" aria-label={t(locale, 'sup.topics')}>
                <p className="sup-label">{t(locale, 'sup.topics')}</p>
                <ul>
                  {docs && (
                    <li>
                      <button type="button" onClick={() => setTab('docs')}>
                        <span className="sup-topic-icon" aria-hidden="true">
                          <Icon name="book" size={16} />
                        </span>
                        {t(locale, 'sup.docs.link')}
                        <Icon name="arrow" size={14} />
                      </button>
                    </li>
                  )}
                  {topics.map((x) => (
                    <li key={x.id}>
                      <a href={x.href}>
                        <span className="sup-topic-icon" aria-hidden="true">
                          <Icon name={x.icon} size={16} />
                        </span>
                        {x.label}
                        <Icon name="arrow" size={14} />
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {sent.map((m) => (
              <div key={m.id} className="sup-mine">
                <p dir="auto">{m.text}</p>
                <small>{t(locale, 'sup.notSent')}</small>
              </div>
            ))}
            <div ref={end} />
          </div>
          <form className="sup-composer" onSubmit={send}>
            <div className="sup-composer-box">
              <label className="nz-sr" htmlFor="sup-text">
                {t(locale, 'sup.placeholder')}
              </label>
              <textarea
                id="sup-text"
                dir="auto"
                rows={2}
                maxLength={2000}
                value={draft}
                placeholder={t(locale, 'sup.placeholder')}
                aria-describedby="sup-note"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
              />
              <button
                type="submit"
                disabled={draft.trim() === ''}
                aria-label={t(locale, 'sup.send')}
              >
                <Icon name="send" size={18} />
              </button>
            </div>
            <p className="sup-note" id="sup-note">
              {t(locale, 'sup.offline')}
            </p>
          </form>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'chat', icon: 'support', label: 'sup.tab.chat' },
  { id: 'docs', icon: 'book', label: 'sup.tab.docs' },
] as const;

/** The panel's two tabs (WAI-ARIA tabs: arrow keys move between them). */
function SupportTabs({
  locale,
  tab,
  onTab,
}: {
  locale: Locale;
  tab: 'chat' | 'docs';
  onTab: (t: 'chat' | 'docs') => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = TABS[tab === 'chat' ? 1 : 0]!;
    onTab(next.id);
    refs.current[TABS.indexOf(next)]?.focus();
  };
  return (
    <div className="sup-tabs" role="tablist" aria-label={t(locale, 'sup.tabs')} onKeyDown={onKey}>
      {TABS.map((x, i) => (
        <button
          key={x.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`sup-tab-${x.id}`}
          aria-selected={tab === x.id}
          aria-controls={`sup-panel-${x.id}`}
          tabIndex={tab === x.id ? 0 : -1}
          onClick={() => onTab(x.id)}
        >
          <Icon name={x.icon} size={16} />
          {t(locale, x.label)}
        </button>
      ))}
    </div>
  );
}

/** The Documentation tab: a search box, the guides and the API areas, each a link to its page in the console copy. */
function SupportDocsView({ locale, docs }: { locale: Locale; docs: SupportDocs }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const has = (...v: string[]) => needle === '' || v.some((x) => x.toLowerCase().includes(needle));
  const guides = docs.guides.filter((g) => has(g.title, g.summary));
  const areas = docs.reference.filter((r) => has(r.title));
  return (
    <div className="sup-docs" role="tabpanel" id="sup-panel-docs" aria-labelledby="sup-tab-docs">
      <p className="sup-docs-intro">{t(locale, 'sup.docs.intro')}</p>
      <label className="sup-docs-search">
        <Icon name="search" size={16} />
        <span className="nz-sr">{t(locale, 'sup.docs.search')}</span>
        <input
          type="search"
          value={q}
          placeholder={t(locale, 'sup.docs.search')}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {guides.length > 0 && (
        <nav className="sup-topics" aria-label={t(locale, 'sup.docs.guides')}>
          <p className="sup-label">{t(locale, 'sup.docs.guides')}</p>
          <ul>
            {guides.map((g) => (
              <li key={g.href}>
                <a href={g.href}>
                  <span className="sup-topic-icon" aria-hidden="true">
                    <Icon name={g.icon} size={16} />
                  </span>
                  <span className="sup-doc-text">
                    {g.title}
                    <small>{g.summary}</small>
                  </span>
                  <Icon name="arrow" size={14} />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {(needle === '' || areas.length > 0) && (
        <nav className="sup-topics" aria-label={t(locale, 'sup.docs.reference')}>
          <p className="sup-label">{t(locale, 'sup.docs.reference')}</p>
          <ul>
            {needle === '' ? (
              <li>
                <a href={docs.referenceHome}>
                  <span className="sup-topic-icon" aria-hidden="true">
                    <Icon name="code" size={16} />
                  </span>
                  <span className="sup-doc-text">
                    {t(locale, 'sup.docs.reference')}
                    <small>
                      {t(locale, 'sup.docs.referenceSub', {
                        n: docs.endpoints,
                        t: docs.reference.length,
                      })}
                    </small>
                  </span>
                  <Icon name="arrow" size={14} />
                </a>
              </li>
            ) : (
              areas.map((r) => (
                <li key={r.href}>
                  <a href={r.href}>
                    <span className="sup-topic-icon" aria-hidden="true">
                      <Icon name="code" size={16} />
                    </span>
                    <span className="sup-doc-text" dir="ltr">
                      {r.title}
                    </span>
                    <Icon name="arrow" size={14} />
                  </a>
                </li>
              ))
            )}
          </ul>
        </nav>
      )}
      {needle !== '' && guides.length === 0 && areas.length === 0 && (
        <p className="sup-docs-empty" role="status">
          {t(locale, 'sup.docs.empty')}
        </p>
      )}
      <a className="sup-docs-all" href={docs.home}>
        <Icon name="book" size={16} />
        {t(locale, 'sup.docs.openAll')}
      </a>
    </div>
  );
}
