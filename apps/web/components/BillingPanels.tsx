'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { fromMinor, toMinor } from '../lib/billing';
import { NoticeText } from './Feedback';

export interface LimitDto {
  id: string;
  scope: 'org' | 'project';
  projectId: string | null;
  monthlyCapMinor: string;
  currency: string;
  alertThresholds: number[];
  fourEyesAboveMinor: string | null;
  version: number;
}

/** Org-level monthly cap editor. Replacing a cap sends the limit's ETag; a stale one (412) asks the user to reload. */
export function SpendingLimitForm(p: {
  locale: Locale;
  limit: LimitDto | null;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [cap, setCap] = useState(p.limit ? fromMinor(p.limit.monthlyCapMinor) : '');
  const [thresholds, setThresholds] = useState((p.limit?.alertThresholds ?? [80, 100]).join(', '));
  const [fourEyes, setFourEyes] = useState(
    p.limit?.fourEyesAboveMinor ? fromMinor(p.limit.fourEyesAboveMinor) : '',
  );
  const [local, setLocal] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocal(null);
    const capMinor = toMinor(cap);
    if (!capMinor) return setLocal(t(p.locale, 'bill.limits.invalid'));
    const th = thresholds
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number);
    if (
      th.length === 0 ||
      th.some((n) => !Number.isInteger(n) || n < 1 || n > 100) ||
      new Set(th).size !== th.length
    )
      return setLocal(t(p.locale, 'bill.limits.invalidThresholds'));
    let fe: string | null = null;
    if (fourEyes.trim() !== '') {
      fe = toMinor(fourEyes);
      if (!fe) return setLocal(t(p.locale, 'bill.limits.invalid'));
    }
    void a.run(
      () =>
        browserApi().PUT('/v1/billing/spending-limits', {
          params: { header: p.limit ? { 'If-Match': `"${p.limit.version}"` } : {} },
          body: {
            scope: 'org',
            monthlyCapMinor: capMinor,
            currency: p.limit?.currency ?? 'SAR',
            alertThresholds: th,
            fourEyesAboveMinor: fe,
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'bill.limits.saved') });
        router.refresh();
      },
      { 412: t(p.locale, 'bill.limits.conflict'), 422: t(p.locale, 'bill.limits.belowSpend') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'bill.limits.title')}>
      <Field id="cap" label={t(p.locale, 'bill.f.cap')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="thresholds" label={t(p.locale, 'bill.f.thresholds')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={thresholds}
            onChange={(e) => setThresholds(e.target.value)}
            required
          />
        )}
      </Field>
      <Field
        id="foureyes"
        label={t(p.locale, 'bill.f.fourEyes')}
        help={t(p.locale, 'bill.f.fourEyesHelp')}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="decimal"
            value={fourEyes}
            onChange={(e) => setFourEyes(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'action.save')}
      </Button>
      {local && <NoticeText notice={{ tone: 'error', text: local }} />}
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

export interface ApprovalRow {
  id: string;
  requesterUserId: string;
  subjectKind: string;
  subjectId: string;
  amountMinor: string;
  currency: string;
  reason: string;
  status: string;
  fourEyes: boolean;
  expiresAt: string;
}

/** Approval list with decision buttons for approvers (step-up is handled by `useAction`) and a request form. */
export function ApprovalsPanel(p: {
  locale: Locale;
  rows: ApprovalRow[];
  fmt: Record<string, string>;
  selfId: string;
  canDecide: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [kind, setKind] = useState<'quote' | 'operation'>('quote');
  const [subject, setSubject] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const decide = (id: string, decision: 'approve' | 'deny') =>
    void a.run(
      () =>
        browserApi().POST('/v1/billing/spend-approvals/{id}/decision', {
          params: { path: { id } },
          body: { decision },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'bill.approvals.decided') });
        router.refresh();
      },
      { 403: t(p.locale, 'bill.approvals.self'), 409: t(p.locale, 'bill.approvals.expired') },
    );
  function submit(e: FormEvent) {
    e.preventDefault();
    setLocal(null);
    const minor = toMinor(amount);
    if (!minor) return setLocal(t(p.locale, 'bill.limits.invalid'));
    void a.run(
      () =>
        browserApi().POST('/v1/billing/spend-approvals', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            ...(kind === 'quote' ? { quoteId: subject.trim() } : { operationId: subject.trim() }),
            amount: minor,
            currency: 'SAR',
            reason,
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'bill.approvals.requested') });
        setSubject('');
        setAmount('');
        setReason('');
        router.refresh();
      },
      { 409: t(p.locale, 'bill.approvals.open') },
    );
  }
  return (
    <>
      {p.rows.length > 0 && (
        <Table
          caption={t(p.locale, 'bill.approvals.title')}
          rows={p.rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'subject',
              header: t(p.locale, 'bill.f.subjectKind'),
              render: (r) => (
                <>
                  <span>{tDynamic(p.locale, `bill.subject.${r.subjectKind}`, r.subjectKind)} </span>
                  <Ltr>{r.subjectId.slice(0, 8)}</Ltr>
                </>
              ),
            },
            {
              key: 'amount',
              header: t(p.locale, 'bill.f.amount'),
              render: (r) => <Ltr>{formatMinor(r.amountMinor, r.currency, p.locale)}</Ltr>,
            },
            { key: 'reason', header: t(p.locale, 'bill.f.reason'), render: (r) => r.reason },
            {
              key: 'status',
              header: t(p.locale, 'field.status'),
              render: (r) => (
                <>
                  <Badge
                    tone={
                      r.status === 'approved'
                        ? 'success'
                        : r.status === 'pending'
                          ? undefined
                          : 'danger'
                    }
                  >
                    {tDynamic(p.locale, `bill.status.${r.status}`, r.status)}
                  </Badge>
                  {r.fourEyes && (
                    <>
                      {' '}
                      <Badge>{t(p.locale, 'bill.approvals.fourEyes')}</Badge>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'expires',
              header: t(p.locale, 'bill.f.expires'),
              render: (r) => p.fmt[r.id] ?? '',
            },
            {
              key: 'act',
              header: t(p.locale, 'bill.approvals.decide'),
              render: (r) =>
                p.canDecide && r.status === 'pending' ? (
                  <span className="nz-row">
                    <Button disabled={a.busy} onClick={() => decide(r.id, 'approve')}>
                      {t(p.locale, 'bill.act.approve')}
                    </Button>
                    <Button variant="danger" disabled={a.busy} onClick={() => decide(r.id, 'deny')}>
                      {t(p.locale, 'bill.act.deny')}
                    </Button>
                  </span>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
      <form
        onSubmit={submit}
        className="nz-card"
        aria-label={t(p.locale, 'bill.approvals.request')}
      >
        <h2 className="nz-h2">{t(p.locale, 'bill.approvals.request')}</h2>
        <Field id="kind" label={t(p.locale, 'bill.f.subjectKind')}>
          {(x) => (
            <Select
              {...x}
              value={kind}
              onChange={(e) => setKind(e.target.value as 'quote' | 'operation')}
            >
              <option value="quote">{t(p.locale, 'bill.subject.quote')}</option>
              <option value="operation">{t(p.locale, 'bill.subject.operation')}</option>
            </Select>
          )}
        </Field>
        <Field id="subject" label={t(p.locale, 'bill.f.subjectId')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="amount" label={t(p.locale, 'bill.f.amount')}>
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
        <Field id="reason" label={t(p.locale, 'bill.f.reason')}>
          {(x) => (
            <Input
              {...x}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={500}
            />
          )}
        </Field>
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'bill.approvals.request')}
        </Button>
        {local && <NoticeText notice={{ tone: 'error', text: local }} />}
      </form>
      <NoticeText notice={a.notice} />
      {a.panel}
    </>
  );
}

/** "Request approval" for one quote (amount and currency come from the immutable quote). */
export function QuoteApprovalButton(p: {
  locale: Locale;
  quoteId: string;
  amountMinor: string;
  currency: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  return (
    <>
      <Button
        disabled={a.busy}
        onClick={() =>
          void a.run(
            () =>
              browserApi().POST('/v1/billing/spend-approvals', {
                params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
                body: {
                  quoteId: p.quoteId,
                  amount: p.amountMinor,
                  currency: p.currency,
                  reason: p.quoteId,
                },
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(p.locale, 'bill.approvals.requested') });
              router.refresh();
            },
            { 409: t(p.locale, 'bill.approvals.open') },
          )
        }
      >
        {t(p.locale, 'bill.quote.request')}
      </Button>
      <NoticeText notice={a.notice} />
    </>
  );
}

/** Time left on a quote; announced politely (not every second) and replaced by the expired message at zero. */
export function ExpiryCountdown(p: { locale: Locale; expiresAt: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Date.parse(p.expiresAt) - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [p.expiresAt]);
  if (left === null) return null;
  if (left === 0) return <p role="status">{t(p.locale, 'bill.quote.expired')}</p>;
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const time = `${m}:${String(s).padStart(2, '0')}`;
  return (
    <p role="timer" aria-live="off">
      {t(p.locale, 'bill.quote.expires', { time })}
    </p>
  );
}
