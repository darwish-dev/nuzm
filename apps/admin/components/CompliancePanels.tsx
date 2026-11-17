'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  breachMoveBody,
  nextBreachStates,
  localToIso,
  type BreachFields,
  type BreachState,
} from '../lib/compliance';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();
const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={3} {...p} />
);

// ---- UI-M04-09: map a control to a feature ------------------------------------------------------------------------------------

export function ControlMapForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  controls: { controlId: string; title: string }[];
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [controlId, setControlId] = useState(p.controls[0]?.controlId ?? '');
  const [module, setModule] = useState('');
  const [feature, setFeature] = useState('');
  const [req, setReq] = useState('');
  const [idem, setIdem] = useState(key());
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(module.trim()) || !feature.trim() || !req.trim())
      return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/compliance/controls', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            controlId,
            module: module.trim(),
            feature: feature.trim(),
            evidenceRequirement: req.trim(),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'cmp.ctl.mapped') });
        setIdem(key());
        setFeature('');
        setReq('');
        router.refresh();
      },
      { 422: t(p.locale, 'cmp.invalid') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'cmp.ctl.mapTitle')}>
      <h2 className="nz-h2">{t(p.locale, 'cmp.ctl.mapTitle')}</h2>
      <Field id="cm-control" label={t(p.locale, 'cmp.ctl.control')}>
        {(x) => (
          <Select {...x} value={controlId} onChange={(e) => setControlId(e.target.value)}>
            {p.controls.map((c) => (
              <option key={c.controlId} value={c.controlId}>
                {c.controlId} — {c.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="cm-module" label={t(p.locale, 'cmp.ctl.module')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={module}
            onChange={(e) => setModule(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="cm-feature" label={t(p.locale, 'cmp.ctl.feature')}>
        {(x) => (
          <Input
            {...x}
            value={feature}
            maxLength={120}
            onChange={(e) => setFeature(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="cm-req" label={t(p.locale, 'cmp.ctl.requirement')}>
        {(x) => (
          <Input
            {...x}
            value={req}
            maxLength={300}
            onChange={(e) => setReq(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'cmp.ctl.mapSubmit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M04-10: add manual evidence -------------------------------------------------------------------------------------------

export function EvidenceForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  controls: { controlId: string; title: string }[];
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [controlId, setControlId] = useState(p.controls[0]?.controlId ?? '');
  const [type, setType] = useState<'document' | 'attestation' | 'external-report'>('document');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [idem, setIdem] = useState(key());
  function submit(e: FormEvent) {
    e.preventDefault();
    const needsDoc = type !== 'attestation';
    if ((needsDoc && ref.trim().length < 3) || (type === 'attestation' && note.trim() === ''))
      return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/compliance/evidence', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            controlId,
            type,
            ...(ref.trim() ? { documentRef: ref.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'cmp.ev.added') });
        setIdem(key());
        setRef('');
        setNote('');
        router.refresh();
      },
      { 422: t(p.locale, 'cmp.invalid') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'cmp.ev.addTitle')}>
      <h2 className="nz-h2">{t(p.locale, 'cmp.ev.addTitle')}</h2>
      <Field id="ev-control" label={t(p.locale, 'cmp.ctl.control')}>
        {(x) => (
          <Select {...x} value={controlId} onChange={(e) => setControlId(e.target.value)}>
            {p.controls.map((c) => (
              <option key={c.controlId} value={c.controlId}>
                {c.controlId} — {c.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="ev-type" label={t(p.locale, 'cmp.ev.type')}>
        {(x) => (
          <Select {...x} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {(['document', 'attestation', 'external-report'] as const).map((k) => (
              <option key={k} value={k}>
                {t(p.locale, `cmp.ev.type.${k}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="ev-ref" label={t(p.locale, 'cmp.ev.ref')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={ref}
            maxLength={300}
            onChange={(e) => setRef(e.target.value)}
          />
        )}
      </Field>
      <Field id="ev-note" label={t(p.locale, 'cmp.ev.note')}>
        {(x) => (
          <TextArea
            {...x}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'cmp.ev.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M04-13: answer or validate --------------------------------------------------------------------------------------------

export function ValidationForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  items: { validationKey: string; regime: string; version: number; applicability: string }[];
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [vk, setVk] = useState(p.items[0]?.validationKey ?? '');
  const [status, setStatus] = useState<'answered' | 'validated' | 'rejected' | 'open'>('answered');
  const [applic, setApplic] = useState('to_confirm');
  const [answer, setAnswer] = useState('');
  const [doc, setDoc] = useState('');
  const [idem, setIdem] = useState(key());
  const cur = p.items.find((x) => x.validationKey === vk);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!cur) return;
    if (status === 'validated' && (doc.trim().length < 3 || applic === 'to_confirm'))
      return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.val.needsEvidence') });
    if (status === 'answered' && answer.trim() === '')
      return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/compliance/regulatory-validations', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            validationKey: vk,
            baseVersion: cur.version,
            status,
            applicability: applic as 'to_confirm',
            ...(answer.trim() ? { answer: answer.trim() } : {}),
            ...(doc.trim() ? { documentRef: doc.trim() } : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'cmp.val.saved') });
        setIdem(key());
        setAnswer('');
        setDoc('');
        router.refresh();
      },
      { 409: t(p.locale, 'cmp.conflict'), 422: t(p.locale, 'cmp.val.needsEvidence') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'cmp.val.formTitle')}>
      <h2 className="nz-h2">{t(p.locale, 'cmp.val.formTitle')}</h2>
      <Field id="vl-key" label={t(p.locale, 'cmp.val.key')}>
        {(x) => (
          <Select {...x} value={vk} onChange={(e) => setVk(e.target.value)}>
            {p.items.map((i) => (
              <option key={i.validationKey} value={i.validationKey}>
                {i.regime}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="vl-status" label={t(p.locale, 'cmp.val.col.status')}>
        {(x) => (
          <Select
            {...x}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            {(['answered', 'validated', 'rejected', 'open'] as const).map((k) => (
              <option key={k} value={k}>
                {t(p.locale, `cmp.val.status.${k}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="vl-applic" label={t(p.locale, 'cmp.val.col.applic')}>
        {(x) => (
          <Select {...x} value={applic} onChange={(e) => setApplic(e.target.value)}>
            {(['to_confirm', 'applicable', 'not_applicable'] as const).map((k) => (
              <option key={k} value={k}>
                {t(p.locale, `cmp.val.applic.${k}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="vl-answer" label={t(p.locale, 'cmp.val.answer')}>
        {(x) => (
          <TextArea
            {...x}
            value={answer}
            maxLength={2000}
            onChange={(e) => setAnswer(e.target.value)}
          />
        )}
      </Field>
      <Field id="vl-doc" label={t(p.locale, 'cmp.val.doc')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={doc}
            maxLength={300}
            onChange={(e) => setDoc(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy || !cur}>
        {t(p.locale, 'cmp.val.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M04-14: breach cases --------------------------------------------------------------------------------------------------

export function BreachOpenForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [summary, setSummary] = useState('');
  const [detected, setDetected] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [linked, setLinked] = useState('');
  const [idem, setIdem] = useState(key());
  function submit(e: FormEvent) {
    e.preventDefault();
    const at = localToIso(detected);
    if (summary.trim().length < 10 || !at || (linked && !/^[A-Za-z0-9:_.-]{1,128}$/.test(linked)))
      return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/compliance/breach-cases', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            summary: summary.trim(),
            detectedAt: at,
            severity,
            ...(linked ? { linkedIncidentId: linked } : {}),
          },
        }),
      (data) => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'cmp.br.opened') });
        setIdem(key());
        const id = (data as { id?: string } | undefined)?.id;
        router.push(
          id
            ? `/${p.locale}/compliance/breach-cases?id=${id}`
            : `/${p.locale}/compliance/breach-cases`,
        );
        router.refresh();
      },
      { 422: t(p.locale, 'cmp.invalid') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'cmp.br.open')}>
      <h2 className="nz-h2">{t(p.locale, 'cmp.br.open')}</h2>
      <Field id="bo-summary" label={t(p.locale, 'cmp.br.summary')}>
        {(x) => (
          <TextArea
            {...x}
            value={summary}
            maxLength={2000}
            onChange={(e) => setSummary(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="bo-at" label={t(p.locale, 'cmp.br.detectedAt')}>
        {(x) => (
          <Input
            {...x}
            type="datetime-local"
            dir="ltr"
            value={detected}
            onChange={(e) => setDetected(e.target.value)}
            required
          />
        )}
      </Field>
      <Field id="bo-sev" label={t(p.locale, 'cmp.br.severity')}>
        {(x) => (
          <Select
            {...x}
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
          >
            {(['low', 'medium', 'high', 'critical'] as const).map((k) => (
              <option key={k} value={k}>
                {t(p.locale, `cmp.br.severity.${k}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="bo-linked" label={t(p.locale, 'cmp.br.linked')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={linked}
            maxLength={128}
            onChange={(e) => setLinked(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'cmp.br.openSubmit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

const EMPTY: BreachFields = {
  note: '',
  personalData: 'yes',
  scope: '',
  classes: '',
  regions: '',
  orgIds: '',
  tables: '',
  notify: 'yes',
  rationale: '',
  recipients: '',
  notifiedAt: '',
  reference: '',
  severity: '',
};

/** One form for the next step of a case: the fields change with the target state. The API stays the authority (step order, four eyes, versions). */
export function BreachMovePanel(p: {
  locale: Locale;
  mfaFactorId: string | null;
  caseId: string;
  version: number;
  state: string;
  decision: { notify?: boolean } | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const next = nextBreachStates(p.state, p.decision);
  const [f, setF] = useState<BreachFields>(EMPTY);
  const [idem, setIdem] = useState(key());
  const to = next[0] as BreachState | undefined;
  if (!to || !p.canManage) return null;
  const set = (k: keyof BreachFields) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = breachMoveBody(to!, f);
    if (b.error) return a.setNotice({ tone: 'error', text: t(p.locale, 'cmp.invalid') });
    void a.run(
      () =>
        browserApi().POST('/v1/admin/compliance/breach-cases', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            caseId: p.caseId,
            transition: to as 'triaged',
            baseVersion: p.version,
            ...(b.note ? { note: b.note } : {}),
            ...(b.data ? { data: b.data } : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'cmp.br.moved') });
        setIdem(key());
        setF(EMPTY);
        router.refresh();
      },
      {
        403: t(p.locale, 'cmp.br.forbidden'),
        409: t(p.locale, 'cmp.br.stale'),
        422: t(p.locale, 'cmp.invalid'),
      },
    );
  }
  const yn = (k: 'personalData' | 'notify', id: string, label: string) => (
    <Field id={id} label={label}>
      {(x) => (
        <Select {...x} value={f[k]} onChange={set(k)}>
          <option value="yes">{t(p.locale, 'cmp.br.yes')}</option>
          <option value="no">{t(p.locale, 'cmp.br.no')}</option>
        </Select>
      )}
    </Field>
  );
  const text = (k: keyof BreachFields, id: string, label: string, ltr = false) => (
    <Field id={id} label={label}>
      {(x) => <Input {...x} dir={ltr ? 'ltr' : undefined} value={f[k]} onChange={set(k)} />}
    </Field>
  );
  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(p.locale, 'cmp.br.move', {
        state: tDynamic(p.locale, `cmp.br.state.${to}`, to),
      })}
    >
      <h2 className="nz-h2">
        {t(p.locale, 'cmp.br.move', { state: tDynamic(p.locale, `cmp.br.state.${to}`, to) })}
      </h2>
      {to === 'triaged' && (
        <Field id="bm-sev" label={t(p.locale, 'cmp.br.severity')}>
          {(x) => (
            <Select {...x} value={f.severity} onChange={set('severity')}>
              <option value="">—</option>
              {(['low', 'medium', 'high', 'critical'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(p.locale, `cmp.br.severity.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {to === 'assessed' && (
        <>
          {yn('personalData', 'bm-pd', t(p.locale, 'cmp.br.f.personalData'))}
          {text('scope', 'bm-scope', t(p.locale, 'cmp.br.f.scope'))}
          {text('classes', 'bm-classes', t(p.locale, 'cmp.br.f.classes'), true)}
          {text('regions', 'bm-regions', t(p.locale, 'cmp.br.f.regions'), true)}
          {text('orgIds', 'bm-orgs', t(p.locale, 'cmp.br.f.orgIds'), true)}
          {text('tables', 'bm-tables', t(p.locale, 'cmp.br.f.tables'), true)}
        </>
      )}
      {to === 'notification_decision' && (
        <>
          <p className="nz-muted">{t(p.locale, 'cmp.br.decisionOther')}</p>
          {yn('notify', 'bm-notify', t(p.locale, 'cmp.br.f.notify'))}
          {text('rationale', 'bm-rationale', t(p.locale, 'cmp.br.f.rationale'))}
          {text('recipients', 'bm-recipients', t(p.locale, 'cmp.br.f.recipients'))}
        </>
      )}
      {to === 'notified' && (
        <>
          <Field id="bm-at" label={t(p.locale, 'cmp.br.f.notifiedAt')}>
            {(x) => (
              <Input
                {...x}
                type="datetime-local"
                dir="ltr"
                value={f.notifiedAt}
                onChange={set('notifiedAt')}
              />
            )}
          </Field>
          {text('reference', 'bm-ref', t(p.locale, 'cmp.br.f.reference'), true)}
        </>
      )}
      {text('note', 'bm-note', t(p.locale, 'cmp.br.note'))}
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'cmp.br.moveSubmit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

/** The evidence pack: needs a reason (it reads across organizations and is logged); shown as a digest with a JSON download. */
export function BreachPack(p: { locale: Locale; caseId: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [pack, setPack] = useState<{ digest: string; json: string } | null>(null);
  const [err, setErr] = useState('');
  async function go(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) return setErr(t(p.locale, 'cmp.invalid'));
    setBusy(true);
    setErr('');
    const r = await browserApi().GET('/v1/admin/compliance/breach-cases', {
      params: { query: { id: p.caseId, pack: true, reason: reason.trim() } },
    });
    setBusy(false);
    const one = (r.data as { items?: { evidencePack?: { digest?: string } }[] } | undefined)
      ?.items?.[0]?.evidencePack;
    if (!r.response.ok || !one)
      return setErr(
        r.response.status === 403
          ? t(p.locale, 'state.forbidden.title')
          : t(p.locale, 'state.error.title'),
      );
    setPack({ digest: one.digest ?? '', json: JSON.stringify(one, null, 2) });
  }
  return (
    <form onSubmit={go} className="nz-card" aria-label={t(p.locale, 'cmp.br.pack')}>
      <h2 className="nz-h2">{t(p.locale, 'cmp.br.pack')}</h2>
      <p className="nz-muted">{t(p.locale, 'cmp.br.packHelp')}</p>
      <Field id="bp-reason" label={t(p.locale, 'cmp.br.packReason')}>
        {(x) => (
          <Input
            {...x}
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" disabled={busy}>
        {t(p.locale, 'cmp.br.packSubmit')}
      </Button>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      {pack && (
        <p role="status">
          {t(p.locale, 'cmp.br.packDigest')}: <bdi dir="ltr">{pack.digest}</bdi>{' '}
          <a
            download={`breach-evidence-${p.caseId.slice(0, 8)}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(pack.json)}`}
          >
            {t(p.locale, 'cmp.br.packDownload')}
          </a>
        </p>
      )}
    </form>
  );
}
