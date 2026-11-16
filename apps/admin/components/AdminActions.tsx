'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { browserApi } from '../lib/client';
import { useStepUp } from './StepUp';

/** Map a failed response to a user-facing message: step-up gets its own hint, everything else a generic one. */
async function failure(
  r: { response: Response; error?: unknown },
  labels: { stepUp: string; error: string },
) {
  const code = (r.error as { code?: string } | undefined)?.code;
  return code === 'step_up_required' ? labels.stepUp : labels.error;
}

export function OrgStatusAction(p: {
  locale: Locale;
  mfaFactorId: string | null;
  orgId: string;
  orgName: string;
  status: 'active' | 'suspended';
  labels: {
    suspend: string;
    reinstate: string;
    confirm: string;
    reason: string;
    cancel: string;
    stepUp: string;
    error: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const step = useStepUp(p.locale, p.mfaFactorId);

  async function patch(status: 'active' | 'suspended', reason?: string) {
    setBusy(true);
    setMsg('');
    const r = await browserApi().PATCH('/v1/admin/organizations/{id}', {
      params: { path: { id: p.orgId } },
      body: { status, ...(reason ? { reason } : {}) },
    });
    setBusy(false);
    if (!r.response.ok) {
      if ((r.error as { code?: string } | undefined)?.code === 'step_up_required' && p.mfaFactorId)
        return step.ask(() => void patch(status, reason));
      return setMsg(await failure(r, p.labels));
    }
    setOpen(false);
    router.refresh();
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void patch('suspended', String(new FormData(e.currentTarget).get('reason') ?? '').trim());
  }

  if (p.status === 'suspended')
    return (
      <>
        <Button variant="secondary" disabled={busy} onClick={() => patch('active')}>
          {p.labels.reinstate}
        </Button>
        {step.panel}
        {msg && (
          <p role="alert" className="nz-error-text">
            {msg}
          </p>
        )}
      </>
    );
  return open ? (
    <>
      <form onSubmit={submit} noValidate aria-label={p.labels.confirm}>
        <p>{p.labels.confirm}</p>
        <Field id={`reason-${p.orgId}`} label={p.labels.reason} error={msg || undefined}>
          {(a) => <Input name="reason" required minLength={5} maxLength={500} {...a} />}
        </Field>
        <div className="nz-row">
          <Button type="submit" variant="danger" disabled={busy}>
            {p.labels.suspend}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {p.labels.cancel}
          </Button>
        </div>
      </form>
      {step.panel}
    </>
  ) : (
    <Button variant="danger" onClick={() => setOpen(true)}>
      {p.labels.suspend}
    </Button>
  );
}

export function ImpersonateAction(p: {
  userId: string;
  email: string;
  requireApproval: boolean;
  webOrigin: string;
  locale: Locale;
  mfaFactorId: string | null;
  labels: {
    open: string;
    title: string;
    reason: string;
    ttl: string;
    approvalRef: string;
    notice: string;
    start: string;
    cancel: string;
    stepUp: string;
    error: string;
    started: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const step = useStepUp(p.locale, p.mfaFactorId);

  async function start(body: { reason: string; ttlMinutes: number; approvalRef?: string }) {
    setBusy(true);
    setMsg(null);
    const r = await browserApi().POST('/v1/admin/users/{id}/impersonation', {
      params: { path: { id: p.userId } },
      body,
    });
    setBusy(false);
    if (!r.response.ok) {
      if ((r.error as { code?: string } | undefined)?.code === 'step_up_required' && p.mfaFactorId)
        return step.ask(() => void start(body));
      return setMsg({ tone: 'error', text: await failure(r, p.labels) });
    }
    setMsg({
      tone: 'ok',
      text: p.labels.started.replace(
        '{time}',
        new Date((r.data as { expiresAt: string }).expiresAt).toLocaleTimeString(p.locale),
      ),
    });
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ref = String(f.get('approvalRef') ?? '').trim();
    void start({
      reason: String(f.get('reason')).trim(),
      ttlMinutes: Number(f.get('ttl')),
      ...(ref ? { approvalRef: ref } : {}),
    });
  }
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {p.labels.open}
      </Button>
    );
  return (
    <>
      <form onSubmit={submit} noValidate aria-label={p.labels.title}>
        <p>{p.labels.notice}</p>
        <Field id={`ir-${p.userId}`} label={p.labels.reason}>
          {(a) => <Input name="reason" required minLength={10} maxLength={500} {...a} />}
        </Field>
        <Field id={`it-${p.userId}`} label={p.labels.ttl}>
          {(a) => (
            <Input name="ttl" type="number" min={1} max={30} defaultValue={15} required {...a} />
          )}
        </Field>
        <Field id={`ia-${p.userId}`} label={p.labels.approvalRef}>
          {(a) => (
            <Input
              name="approvalRef"
              required={p.requireApproval}
              maxLength={200}
              dir="ltr"
              {...a}
            />
          )}
        </Field>
        {msg && (
          <p
            role={msg.tone === 'error' ? 'alert' : 'status'}
            className={msg.tone === 'error' ? 'nz-error-text' : ''}
          >
            {msg.text}
            {msg.tone === 'ok' && (
              <>
                {' '}
                <a href={`${p.webOrigin}/${p.locale}`}>{p.labels.open}</a>
              </>
            )}
          </p>
        )}
        <div className="nz-row">
          <Button type="submit" disabled={busy}>
            {p.labels.start}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {p.labels.cancel}
          </Button>
        </div>
      </form>
      {step.panel}
    </>
  );
}

export function FlagForm(p: {
  labels: { key: string; value: string; save: string; error: string };
}) {
  const router = useRouter();
  const [msg, setMsg] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMsg('');
    let value: unknown;
    try {
      value = JSON.parse(String(f.get('value')));
    } catch {
      return setMsg(p.labels.error);
    }
    const r = await browserApi().PUT('/v1/admin/feature-flags', {
      body: { key: String(f.get('key')), scope: 'global', value },
    });
    if (!r.response.ok) return setMsg(p.labels.error);
    router.refresh();
  }
  return (
    <form onSubmit={submit} noValidate className="nz-row">
      <Field id="flag-key" label={p.labels.key} error={msg || undefined}>
        {(a) => <Input name="key" required dir="ltr" pattern="[a-z][a-z0-9_.\-]{1,63}" {...a} />}
      </Field>
      <Field id="flag-value" label={p.labels.value}>
        {(a) => <Input name="value" required dir="ltr" defaultValue="true" {...a} />}
      </Field>
      <Button type="submit">{p.labels.save}</Button>
    </form>
  );
}
