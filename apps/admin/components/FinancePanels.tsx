'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { RC_TYPES, isUuid, toMinor, validRange, type RcType, type ZatcaStep } from '../lib/finance';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();

// ---- UI-M03-15: request a refund ---------------------------------------------------------------------------------------------

interface RefundDto {
  id: string;
  paymentId: string;
  amountMinor: string;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureCode: string | null;
}

export function RefundForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  /** Pre-fills the payment id (a link from the payment screen); the person still has to enter the amount and the reason. */
  defaultPaymentId?: string | undefined;
}) {
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [paymentId, setPaymentId] = useState(p.defaultPaymentId ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [results, setResults] = useState<RefundDto[]>([]);
  // one key per distinct request: a double click or a retry after a lost answer replays the same refund, never a second one
  const [idem, setIdem] = useState(key());
  function submit(e: FormEvent) {
    e.preventDefault();
    const minor = toMinor(amount);
    if (!isUuid(paymentId) || !minor || reason.trim() === '' || (creditNote && !isUuid(creditNote)))
      return a.setNotice({ tone: 'error', text: t(p.locale, 'af.ref.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/billing/refunds', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            paymentId: paymentId.trim(),
            amount: minor,
            reason: reason.trim(),
            ...(creditNote ? { creditNoteId: creditNote.trim() } : {}),
          },
        }),
      (data) => {
        const r = data as RefundDto;
        setResults((x) => [r, ...x.filter((y) => y.id !== r.id)]);
        a.setNotice({
          tone: r.status === 'failed' ? 'error' : 'ok',
          text:
            r.status === 'succeeded'
              ? t(p.locale, 'af.ref.done')
              : r.status === 'pending'
                ? t(p.locale, 'af.ref.pending')
                : t(p.locale, 'af.ref.failed', { code: r.failureCode ?? 'failed' }),
        });
        setIdem(key());
        setPaymentId('');
        setAmount('');
        setReason('');
        setCreditNote('');
      },
      {
        404: t(p.locale, 'af.ref.notFound'),
        409: t(p.locale, 'af.ref.conflict'),
        422: t(p.locale, 'af.ref.invalid'),
      },
    );
  }
  return (
    <>
      <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'af.ref.title')}>
        <p className="nz-muted">{t(p.locale, 'af.ref.help')}</p>
        <Field id="rf-payment" label={t(p.locale, 'af.ref.payment')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="rf-amount" label={t(p.locale, 'af.ref.amount')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="rf-reason" label={t(p.locale, 'field.reason')}>
          {(x) => (
            <Input
              {...x}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="rf-cn" label={t(p.locale, 'af.ref.creditNote')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={creditNote}
              onChange={(e) => setCreditNote(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'af.ref.submit')}
        </Button>
        <Note n={a.notice} />
        {a.panel}
      </form>
      {results.length > 0 && (
        <ul className="nz-card" aria-label={t(p.locale, 'af.ref.result')}>
          {results.map((r) => (
            <li key={r.id} className="nz-row">
              <Ltr>{r.id}</Ltr>
              <Ltr>{formatMinor(r.amountMinor, r.currency, p.locale)}</Ltr>
              <Badge
                tone={
                  r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warn'
                }
              >
                {tDynamic(p.locale, `af.ref.status.${r.status}`, r.status)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---- UI-M03-16: run reconciliations ------------------------------------------------------------------------------------------

export function RunReconciliationsForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  defaultFrom: string;
  defaultTo: string;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [types, setTypes] = useState<RcType[]>([]);
  const [from, setFrom] = useState(p.defaultFrom);
  const [to, setTo] = useState(p.defaultTo);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (types.length === 0 || !validRange(from, to))
      return a.setNotice({ tone: 'error', text: t(p.locale, 'af.rc.run.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/billing/reconciliations', {
          body: { types, periodFrom: from, periodTo: to },
        }),
      (data) => {
        const n = (data as { runs?: unknown[] } | undefined)?.runs?.length ?? types.length;
        a.setNotice({ tone: 'ok', text: t(p.locale, 'af.rc.run.queued', { count: n }) });
        router.refresh();
      },
      { 409: t(p.locale, 'af.rc.run.conflict'), 422: t(p.locale, 'af.rc.run.invalid') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'af.rc.run.title')}>
      <h2 className="nz-h2">{t(p.locale, 'af.rc.run.title')}</h2>
      <fieldset>
        <legend>{t(p.locale, 'af.rc.run.types')}</legend>
        {RC_TYPES.map((x) => (
          <label key={x} className="nz-row">
            <input
              type="checkbox"
              checked={types.includes(x)}
              onChange={(e) =>
                setTypes((cur) => (e.target.checked ? [...cur, x] : cur.filter((c) => c !== x)))
              }
            />
            <Ltr>{x}</Ltr> {tDynamic(p.locale, `af.rc.type.${x}`, x)}
          </label>
        ))}
      </fieldset>
      <Field id="rc-from" label={t(p.locale, 'af.rc.run.from')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="rc-to" label={t(p.locale, 'af.rc.run.to')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'af.rc.run.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M03-17: assign / accept / link an adjustment -------------------------------------------------------------------------

export function BreakActions(p: {
  locale: Locale;
  runId: string;
  itemId: string;
  status: string;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [mode, setMode] = useState<'accept' | 'adjustment' | null>(null);
  const [note, setNote] = useState('');
  const [adj, setAdj] = useState('');
  if (!p.canManage || p.status === 'resolved') return null;
  const send = (body: {
    action: 'assign' | 'adjustment' | 'accept';
    adjustmentId?: string;
    note?: string;
  }) =>
    void a.run(
      () =>
        browserApi().POST('/v1/admin/billing/reconciliations/{id}/resolutions', {
          params: { path: { id: p.runId } },
          body: { itemId: p.itemId, ...body },
        }),
      () => {
        setMode(null);
        setNote('');
        setAdj('');
        a.setNotice({ tone: 'ok', text: t(p.locale, 'af.rc.done') });
        router.refresh();
      },
      { 409: t(p.locale, 'af.rc.err.conflict'), 422: t(p.locale, 'af.rc.err.input') },
    );
  return (
    <div>
      <div className="nz-row">
        {p.status === 'open' && (
          <Button variant="secondary" disabled={a.busy} onClick={() => send({ action: 'assign' })}>
            {t(p.locale, 'af.rc.act.assign')}
          </Button>
        )}
        <Button variant="secondary" disabled={a.busy} onClick={() => setMode('accept')}>
          {t(p.locale, 'af.rc.act.accept')}
        </Button>
        <Button variant="secondary" disabled={a.busy} onClick={() => setMode('adjustment')}>
          {t(p.locale, 'af.rc.act.adjust')}
        </Button>
      </div>
      {mode === 'accept' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim() === '')
              return a.setNotice({ tone: 'error', text: t(p.locale, 'af.rc.err.input') });
            send({ action: 'accept', note: note.trim() });
          }}
        >
          <Field id={`n-${p.itemId}`} label={t(p.locale, 'af.rc.f.note')}>
            {(x) => (
              <Input
                {...x}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'af.rc.act.accept')}
          </Button>
        </form>
      )}
      {mode === 'adjustment' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!isUuid(adj))
              return a.setNotice({ tone: 'error', text: t(p.locale, 'af.rc.err.input') });
            send({
              action: 'adjustment',
              adjustmentId: adj.trim(),
              ...(note ? { note: note.trim() } : {}),
            });
          }}
        >
          <Field id={`a-${p.itemId}`} label={t(p.locale, 'af.rc.f.adjustment')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={adj}
                onChange={(e) => setAdj(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'af.rc.act.adjust')}
          </Button>
        </form>
      )}
      <Note n={a.notice} />
      {a.panel}
    </div>
  );
}

// ---- UI-M03-18: e-invoicing onboarding steps ---------------------------------------------------------------------------------

export function RequestStepButton(p: {
  locale: Locale;
  environment: 'sandbox' | 'simulation';
  step: ZatcaStep;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  return (
    <>
      <Button
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/admin/billing/zatca/onboarding', {
                body: { environment: p.environment, step: p.step },
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(p.locale, 'af.z.requested') });
              router.refresh();
            },
            { 409: t(p.locale, 'af.z.err.conflict'), 422: t(p.locale, 'af.z.err.env') },
          )
        }
      >
        {t(p.locale, 'af.z.request', {
          step: tDynamic(p.locale, `af.z.step.${p.step}`, p.step),
        })}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}

export function DecideStep(p: {
  locale: Locale;
  stepId: string;
  step: ZatcaStep;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [otp, setOtp] = useState('');
  const decide = (decision: 'approve' | 'reject') =>
    void a.run(
      () =>
        browserApi().POST('/v1/admin/billing/zatca/onboarding', {
          body: {
            stepId: p.stepId,
            decision,
            ...(decision === 'approve' && p.step === 'compliance_csid' && otp ? { otp } : {}),
          },
        }),
      () => {
        setOtp('');
        a.setNotice({ tone: 'ok', text: t(p.locale, 'af.z.decided') });
        router.refresh();
      },
      { 403: t(p.locale, 'af.z.err.self'), 409: t(p.locale, 'af.z.err.conflict') },
    );
  return (
    <div>
      {p.step === 'compliance_csid' && (
        <Field id={`otp-${p.stepId}`} label={t(p.locale, 'af.z.otp')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              autoComplete="off"
              maxLength={20}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          )}
        </Field>
      )}
      <div className="nz-row">
        <Button disabled={a.busy} onClick={() => decide('approve')}>
          {t(p.locale, 'af.z.approve')}
        </Button>
        <Button variant="secondary" disabled={a.busy} onClick={() => decide('reject')}>
          {t(p.locale, 'af.z.reject')}
        </Button>
      </div>
      <Note n={a.notice} />
      {a.panel}
    </div>
  );
}

// ---- UI-M03-19: retry a dead-lettered submission -----------------------------------------------------------------------------

export function RetrySubmission(p: { locale: Locale; id: string; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  return (
    <>
      <Button
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/admin/billing/zatca/submissions/{id}/retry', {
                params: { path: { id: p.id } },
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(p.locale, 'af.zs.retried') });
              router.refresh();
            },
            { 409: t(p.locale, 'af.zs.err.conflict') },
          )
        }
      >
        {t(p.locale, 'af.zs.retry')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}

// ---- UI-M03-20: hold / resume a dunning case ---------------------------------------------------------------------------------

export function DunningAction(p: {
  locale: Locale;
  id: string;
  hold: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [reason, setReason] = useState('');
  const action = p.hold ? 'resume' : 'hold';
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim() === '' || reason.length > 500)
      return a.setNotice({ tone: 'error', text: t(p.locale, 'af.dn.err.input') });
    void a.run(
      () =>
        browserApi().PATCH('/v1/admin/billing/dunning/{id}', {
          params: { path: { id: p.id } },
          body: { action, reason: reason.trim() },
        }),
      () => {
        setReason('');
        a.setNotice({ tone: 'ok', text: t(p.locale, `af.dn.done.${action}`) });
        router.refresh();
      },
      { 409: t(p.locale, 'af.dn.err.closed'), 422: t(p.locale, 'af.dn.err.input') },
    );
  }
  return (
    <form onSubmit={submit}>
      <Field id={`dn-${p.id}`} label={t(p.locale, 'af.dn.f.reason')}>
        {(x) => (
          <Input
            {...x}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" disabled={a.busy}>
        {t(p.locale, `af.dn.act.${action}`)}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
