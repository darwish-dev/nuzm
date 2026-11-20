'use client';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, useSupportDock, type IconName } from '@nuzm/ui';
import { BrandMark } from './BrandLogo';

export interface SupportTopic {
  id: string;
  label: string;
  href: string;
  icon: IconName;
}

/**
 * The support panel docked beside the page (opened from the top bar's support button): a chat-style thread with a greeting and quick links to the areas of the
 * console. You can type and "send": the message shows in the thread, but live chat with the support team has no service behind it yet, so it is marked
 * "not sent" and nothing pretends it was delivered.
 */
export function SupportPanel({ locale, topics }: { locale: Locale; topics: SupportTopic[] }) {
  const dock = useSupportDock();
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
      <div className="sup-thread" role="log" aria-label={t(locale, 'sup.title')}>
        <div className="sup-msg">
          <span className="sup-msg-avatar" aria-hidden="true">
            <BrandMark />
          </span>
          <p>{t(locale, 'sup.greeting')}</p>
        </div>
        {topics.length > 0 && (
          <nav className="sup-topics" aria-label={t(locale, 'sup.topics')}>
            <p className="sup-label">{t(locale, 'sup.topics')}</p>
            <ul>
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
          <button type="submit" disabled={draft.trim() === ''} aria-label={t(locale, 'sup.send')}>
            <Icon name="send" size={18} />
          </button>
        </div>
        <p className="sup-note" id="sup-note">
          {t(locale, 'sup.offline')}
        </p>
      </form>
    </div>
  );
}
