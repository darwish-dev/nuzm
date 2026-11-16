'use client';
import { useState } from 'react';
import { Badge, Button } from '@nuzm/ui';
import { browserApi } from '../lib/client';

interface Item {
  id: string;
  text: string;
  when: string;
  read: boolean;
}

export function NotificationList(p: {
  items: Item[];
  labels: { read: string; unread: string; error: string };
}) {
  const [items, setItems] = useState(p.items);
  const [err, setErr] = useState('');
  async function toggle(i: Item) {
    setErr('');
    const r = await browserApi().PATCH('/v1/notifications/{id}', {
      params: { path: { id: i.id } },
      body: { read: !i.read },
    });
    if (!r.response.ok) return setErr(p.labels.error);
    setItems((cur) => cur.map((x) => (x.id === i.id ? { ...x, read: !x.read } : x)));
  }
  return (
    <>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 'var(--nuzm-space-3)' }}>
        {items.map((i) => (
          <li key={i.id} className="nz-card nz-row" style={{ fontWeight: i.read ? 400 : 600 }}>
            <span style={{ flex: 1 }}>
              {i.text}
              <br />
              <span className="nz-muted">{i.when}</span>
            </span>
            {!i.read && <Badge tone="warn">•</Badge>}
            <Button variant="secondary" onClick={() => toggle(i)}>
              {i.read ? p.labels.unread : p.labels.read}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
