'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Select } from '@nuzm/ui';
import { MOCK_SOURCES, runOfflineBody } from '../lib/benchmarks';
import { bt } from '../lib/benchmarks-text';
import { adminCsrf } from '../lib/client';

/**
 * The one action of the dashboard: record an OFFLINE replay (reference oracle or a scripted mock). It calls no model. A fresh `requestId` per click, so a double click records once; the
 * server refuses every other source (a recorded run can only come from the gated live runner, which is not available).
 */
export function BenchmarksActions({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [source, setSource] = useState<string>('reference');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const csrf = adminCsrf();
      const r = await fetch('/v1/admin/ai/benchmarks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-nuzm-realm': 'admin', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify(runOfflineBody(source, crypto.randomUUID())),
      });
      setMsg(r.ok ? { ok: true, text: bt(locale, 'recorded') } : { ok: false, text: bt(locale, 'failed') });
      if (r.ok) router.refresh();
    } catch {
      setMsg({ ok: false, text: bt(locale, 'failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label={bt(locale, 'recordOffline')} className="nz-stack">
      <h3 className="nz-h3">{bt(locale, 'recordOffline')}</h3>
      <Field id="bench-source" label={bt(locale, 'source')}>
        {(a) => (
          <Select {...a} value={source} onChange={(e) => setSource(e.target.value)}>
            {MOCK_SOURCES.map((x) => (
              <option key={x} value={x}>
                {x === 'reference' ? bt(locale, 'sourceReference') : x}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? bt(locale, 'recording') : bt(locale, 'record')}
      </Button>
      {msg && <Banner tone={msg.ok ? 'warn' : 'danger'}>{msg.text}</Banner>}
    </form>
  );
}
