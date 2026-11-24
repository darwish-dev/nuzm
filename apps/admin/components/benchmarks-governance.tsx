'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Select } from '@nuzm/ui';
import {
  VERDICTS,
  governanceActions,
  governanceBody,
  type GovernanceAction,
  type GovernanceState,
} from '../lib/benchmarks';
import { bt, type BenchKey } from '../lib/benchmarks-text';
import { adminCsrf } from '../lib/client';

/**
 * Records one threshold-governance event (propose, review, accept, reject) through the CSRF-protected admin endpoint. The server enforces every rule (who may act, four eyes, one review
 * per reviewer); this form only offers the actions that make sense in the current state and only those the signed-in person may take. A fresh `requestId` per click, so a double click records once.
 */
export function BenchmarksGovernanceForm({
  locale,
  version,
  state,
  canManage,
  canApprove,
}: {
  locale: Locale;
  version: string;
  state: GovernanceState;
  canManage: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const allowed = governanceActions(state).filter((a) =>
    a === 'accept' || a === 'reject' ? canApprove : canManage,
  );
  const [action, setAction] = useState<GovernanceAction | ''>('');
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<string>(VERDICTS[0]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (allowed.length === 0) return null;
  const current: GovernanceAction = allowed.includes(action as GovernanceAction)
    ? (action as GovernanceAction)
    : allowed[0]!;
  const needsText = current !== 'accept';
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
        headers: {
          'content-type': 'application/json',
          'x-nuzm-realm': 'admin',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify(
          governanceBody(current, version, { text, verdict }, crypto.randomUUID()),
        ),
      });
      setMsg(
        r.ok
          ? { ok: true, text: bt(locale, 'govDone') }
          : { ok: false, text: bt(locale, 'failed') },
      );
      if (r.ok) {
        setText('');
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: bt(locale, 'failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label={bt(locale, 'governanceTitle')} className="nz-stack">
      <Field id="gov-action" label={bt(locale, 'actionLabel')}>
        {(a) => (
          <Select
            {...a}
            value={current}
            onChange={(e) => setAction(e.target.value as GovernanceAction)}
          >
            {allowed.map((x) => (
              <option key={x} value={x}>
                {bt(locale, `action_${x}` as BenchKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {current === 'review' && (
        <Field id="gov-verdict" label={bt(locale, 'fieldVerdict')}>
          {(a) => (
            <Select {...a} value={verdict} onChange={(e) => setVerdict(e.target.value)}>
              {VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {bt(locale, `verdict_${v}` as BenchKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {needsText && (
        <Field
          id="gov-text"
          label={bt(
            locale,
            current === 'propose'
              ? 'fieldSummary'
              : current === 'review'
                ? 'fieldNote'
                : 'fieldReason',
          )}
        >
          {(a) => (
            <Input
              {...a}
              value={text}
              maxLength={2000}
              required
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? bt(locale, 'working') : bt(locale, 'submit')}
      </Button>
      {msg && <Banner tone={msg.ok ? 'warn' : 'danger'}>{msg.text}</Banner>}
    </form>
  );
}
