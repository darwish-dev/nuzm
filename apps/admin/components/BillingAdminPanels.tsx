'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { useStepUp } from './StepUp';

export type Notice = { tone: 'error' | 'ok'; text: string } | null;
export const Note = ({ n }: { n: Notice }) =>
  n ? (
    <p
      role={n.tone === 'error' ? 'alert' : 'status'}
      className={n.tone === 'error' ? 'nz-error-text' : ''}
    >
      {n.text}
    </p>
  ) : null;

interface Res {
  response: Response;
  data?: unknown;
  error?: unknown;
}

/** Run a staff mutation: busy state, localized error text, and an MFA step-up prompt when the API asks for one. */
export function useStaffAction(locale: Locale, factorId: string | null) {
  const step = useStepUp(locale, factorId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  async function run(
    call: () => Promise<Res>,
    onOk: (data?: unknown) => void,
    overrides: Partial<Record<number, string>> = {},
  ) {
    setBusy(true);
    setNotice(null);
    const r = await call();
    setBusy(false);
    if (r.response.ok) return onOk(r.data);
    const code = (r.error as { code?: string } | undefined)?.code;
    if (code === 'step_up_required' && factorId)
      return step.ask(() => void run(call, onOk, overrides));
    const s = r.response.status;
    setNotice({
      tone: 'error',
      text:
        overrides[s] ??
        (s === 403
          ? t(locale, 'state.forbidden.title')
          : s === 422
            ? t(locale, 'err.validation')
            : t(locale, 'state.error.title')),
    });
  }
  return { run, busy, notice, setNotice, panel: step.panel };
}

/** Publish a draft price book version (a different person than its author; step-up). */
export function PublishVersion(p: {
  locale: Locale;
  bookId: string;
  versionId: string;
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
              browserApi().POST('/v1/admin/billing/price-books/{id}/versions', {
                params: { path: { id: p.bookId } },
                body: { publishVersionId: p.versionId },
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(p.locale, 'abill.books.published') });
              router.refresh();
            },
            { 403: t(p.locale, 'abill.books.fourEyes'), 409: t(p.locale, 'abill.books.overlap') },
          )
        }
      >
        {t(p.locale, 'abill.books.publish')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}

const WINDOWS = ['hour', 'day', 'event'] as const;
const BASES = ['usage', 'included', 'pass', 'subscription'] as const;

export function CreateMeterForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    id: '',
    unit: '',
    window: 'hour',
    basis: 'usage',
    dims: '',
    description: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/admin/meters', {
          body: {
            id: f.id.trim(),
            unit: f.unit.trim(),
            aggregationWindow: f.window as (typeof WINDOWS)[number],
            basis: f.basis as (typeof BASES)[number],
            dimensionsAllowed: f.dims
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
            ...(f.description.trim() ? { description: f.description.trim() } : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'abill.meters.created') });
        setF({ id: '', unit: '', window: 'hour', basis: 'usage', dims: '', description: '' });
        router.refresh();
      },
      { 409: t(p.locale, 'abill.meters.exists') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'abill.meters.create')}>
      <h2 className="nz-h2">{t(p.locale, 'abill.meters.create')}</h2>
      <Field id="mid" label={t(p.locale, 'abill.f.meterId')}>
        {(x) => <Input {...x} dir="ltr" value={f.id} onChange={set('id')} required />}
      </Field>
      <Field id="munit" label={t(p.locale, 'abill.f.unit')}>
        {(x) => <Input {...x} dir="ltr" value={f.unit} onChange={set('unit')} required />}
      </Field>
      <Field id="mwin" label={t(p.locale, 'abill.f.window')}>
        {(x) => (
          <Select {...x} value={f.window} onChange={set('window')}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="mbasis" label={t(p.locale, 'abill.f.basis')}>
        {(x) => (
          <Select {...x} value={f.basis} onChange={set('basis')}>
            {BASES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="mdims" label={t(p.locale, 'abill.f.dims')}>
        {(x) => <Input {...x} dir="ltr" value={f.dims} onChange={set('dims')} />}
      </Field>
      <Field id="mdesc" label={t(p.locale, 'abill.f.description')}>
        {(x) => (
          <Input {...x} value={f.description} onChange={set('description')} maxLength={200} />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'action.create')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

/** File a reversal request, or decide one (a different person). The API has one endpoint for both (docs/04). */
export function AdjustmentsPanel(p: {
  locale: Locale;
  canRequest: boolean;
  canDecide: boolean;
  mfaFactorId: string | null;
}) {
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [req, setReq] = useState({ orgId: '', txId: '', reason: '' });
  const [dec, setDec] = useState({ id: '', decision: 'approve', note: '' });
  const overrides = {
    404: t(p.locale, 'abill.adj.notFound'),
    409: t(p.locale, 'abill.adj.conflict'),
  };
  const file = (e: FormEvent) => {
    e.preventDefault();
    let created = '';
    void a.run(
      async () => {
        const r = await browserApi().POST('/v1/admin/billing/adjustments', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { orgId: req.orgId.trim(), reverses: req.txId.trim(), reason: req.reason },
        });
        created = (r.data as { id?: string } | undefined)?.id ?? '';
        return r;
      },
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'abill.adj.requested', { id: created }) });
        setReq({ orgId: '', txId: '', reason: '' });
      },
      overrides,
    );
  };
  const decide = (e: FormEvent) => {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/admin/billing/adjustments', {
          body: {
            adjustmentId: dec.id.trim(),
            decision: dec.decision as 'approve' | 'reject',
            ...(dec.note ? { note: dec.note } : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'abill.adj.decided') });
        setDec({ id: '', decision: 'approve', note: '' });
      },
      { ...overrides, 403: t(p.locale, 'abill.adj.self') },
    );
  };
  return (
    <>
      <p>{t(p.locale, 'abill.adj.note')}</p>
      <p className="nz-muted">{t(p.locale, 'abill.adj.noList')}</p>
      <p className="nz-muted">{t(p.locale, 'abill.adj.linesApi')}</p>
      {p.canRequest && (
        <form onSubmit={file} className="nz-card" aria-label={t(p.locale, 'abill.adj.request')}>
          <h2 className="nz-h2">{t(p.locale, 'abill.adj.request')}</h2>
          <Field id="aorg" label={t(p.locale, 'abill.f.orgId')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={req.orgId}
                onChange={(e) => setReq({ ...req, orgId: e.target.value })}
                required
              />
            )}
          </Field>
          <Field id="atx" label={t(p.locale, 'abill.f.txId')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={req.txId}
                onChange={(e) => setReq({ ...req, txId: e.target.value })}
                required
              />
            )}
          </Field>
          <Field id="areason" label={t(p.locale, 'abill.f.reason')}>
            {(x) => (
              <Input
                {...x}
                value={req.reason}
                onChange={(e) => setReq({ ...req, reason: e.target.value })}
                required
                maxLength={500}
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'abill.act.file')}
          </Button>
        </form>
      )}
      {p.canDecide && (
        <form onSubmit={decide} className="nz-card" aria-label={t(p.locale, 'abill.adj.decide')}>
          <h2 className="nz-h2">{t(p.locale, 'abill.adj.decide')}</h2>
          <Field id="aid" label={t(p.locale, 'abill.f.adjId')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={dec.id}
                onChange={(e) => setDec({ ...dec, id: e.target.value })}
                required
              />
            )}
          </Field>
          <Field id="adec" label={t(p.locale, 'abill.f.decision')}>
            {(x) => (
              <Select
                {...x}
                value={dec.decision}
                onChange={(e) => setDec({ ...dec, decision: e.target.value })}
              >
                <option value="approve">{t(p.locale, 'abill.act.approve')}</option>
                <option value="reject">{t(p.locale, 'abill.act.reject')}</option>
              </Select>
            )}
          </Field>
          <Field id="anote" label={t(p.locale, 'abill.f.note')}>
            {(x) => (
              <Input
                {...x}
                value={dec.note}
                onChange={(e) => setDec({ ...dec, note: e.target.value })}
                maxLength={500}
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'abill.act.decide')}
          </Button>
        </form>
      )}
      <Note n={a.notice} />
      {a.panel}
    </>
  );
}
