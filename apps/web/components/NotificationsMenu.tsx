'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@nuzm/ui';
import { browserApi } from '../lib/client';

export interface NotificationItem {
  id: string;
  text: string;
  when: string;
  read: boolean;
}

/**
 * The bell in the top bar: the latest notifications as a pop-up (no page, no tab of its own). Each one can be marked read or unread;
 * "view all" goes to the full list. Closes on Escape and on an outside click.
 */
export function NotificationsMenu(props: {
  items: NotificationItem[];
  unreadCount: number;
  viewAllHref: string;
  labels: {
    menu: string;
    title: string;
    empty: string;
    read: string;
    unread: string;
    viewAll: string;
    error: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(props.items);
  const [unread, setUnread] = useState(props.unreadCount);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggle(i: NotificationItem) {
    setErr('');
    const r = await browserApi().PATCH('/v1/notifications/{id}', {
      params: { path: { id: i.id } },
      body: { read: !i.read },
    });
    if (!r.response.ok) return setErr(props.labels.error);
    setItems((cur) => cur.map((x) => (x.id === i.id ? { ...x, read: !x.read } : x)));
    setUnread((n) => Math.max(0, n + (i.read ? 1 : -1)));
  }

  const name = unread > 0 ? `${props.labels.menu} (${unread})` : props.labels.menu;
  return (
    <div className="nzc-menu" ref={ref}>
      <button
        type="button"
        className="nzc-icon-btn"
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="nzc-dot" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="nzc-menu-panel nzc-notif-panel"
          role="dialog"
          aria-label={props.labels.title}
        >
          <div className="nzc-notif-head">{props.labels.title}</div>
          {err && (
            <p role="alert" className="nz-error-text" style={{ margin: '8px 14px 0' }}>
              {err}
            </p>
          )}
          {items.length === 0 ? (
            <p className="nzc-notif-empty">{props.labels.empty}</p>
          ) : (
            <ul className="nzc-notif-list">
              {items.map((i) => (
                <li key={i.id} data-read={i.read ? 'true' : 'false'}>
                  <span className="nzc-notif-text">
                    {i.text}
                    <span className="nzc-notif-when">{i.when}</span>
                  </span>
                  <button type="button" className="nzc-notif-toggle" onClick={() => toggle(i)}>
                    {i.read ? props.labels.unread : props.labels.read}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="nzc-notif-foot">
            <a href={props.viewAllHref}>{props.labels.viewAll}</a>
          </div>
        </div>
      )}
    </div>
  );
}
