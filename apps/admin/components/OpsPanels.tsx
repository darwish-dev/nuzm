'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Schemas } from '@nuzm/sdk';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  ALERT_OPS,
  ALERT_SEVERITIES,
  EXERCISE_ENVIRONMENTS,
  EXERCISE_SCOPES,
  SEVERITIES,
  defineAlertBody,
  formatDuration,
  measuredRto,
  nextIncidentStatuses,
  openIncidentBody,
  recoveryExerciseBody,
  silenceUntil,
  updateIncidentBody,
} from '../lib/ops';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();
const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={3} {...p} />
);

// ---- UI-M12-05: open an incident ----------------------------------------------------------------------------------------------

export function IncidentOpenForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    severity: 'SEV3',
    title: '',
    summary: '',
    components: '',
    breachCaseId: '',
  });
  const [idem, setIdem] = useState(key());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = openIncidentBody(f);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.inc.invalid') });
    const body = b.body;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/incidents', {
          params: { header: { 'Idempotency-Key': idem } },
          body,
        }),
      (data) => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.inc.opened') });
        setIdem(key());
        setF({ ...f, title: '', summary: '', components: '', breachCaseId: '' });
        const id = (data as { id?: string } | undefined)?.id;
        if (id) router.push(`/${p.locale}/incidents/${id}`);
        else router.refresh();
      },
      { 422: t(p.locale, 'm12.inc.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.inc.open.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.inc.open.title')}</h2>
      <Field id="in-sev" label={t(p.locale, 'm12.inc.col.severity')}>
        {(x) => (
          <Select {...x} value={f.severity} onChange={set('severity')}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.inc.sev.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="in-title" label={t(p.locale, 'm12.inc.open.titleField')}>
        {(x) => <Input {...x} value={f.title} maxLength={200} onChange={set('title')} required />}
      </Field>
      <Field id="in-summary" label={t(p.locale, 'm12.inc.open.summary')}>
        {(x) => <TextArea {...x} value={f.summary} maxLength={2000} onChange={set('summary')} />}
      </Field>
      <Field
        id="in-comp"
        label={t(p.locale, 'm12.inc.open.components')}
        help={t(p.locale, 'm12.inc.open.componentsHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.components} onChange={set('components')} />}
      </Field>
      <Field id="in-breach" label={t(p.locale, 'm12.inc.breach')}>
        {(x) => <Input {...x} dir="ltr" value={f.breachCaseId} onChange={set('breachCaseId')} />}
      </Field>
      <p className="nz-muted">{t(p.locale, 'm12.inc.noPii')}</p>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.inc.open.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M12-06: update an incident (status, severity, note, comms draft, breach-case id) --------------------------------------

export function IncidentUpdatePanel(p: {
  locale: Locale;
  mfaFactorId: string | null;
  id: string;
  status: string;
  severity: string;
  breachCaseId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const next = nextIncidentStatuses(p.status);
  const [f, setF] = useState({
    status: '',
    severity: '',
    note: '',
    commsDraft: '',
    breachCaseId: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  if (p.status === 'closed')
    return <p className="nz-muted">{t(p.locale, 'm12.inc.closedTerminal')}</p>;
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = updateIncidentBody(
      { status: p.status, severity: p.severity, breachCaseId: p.breachCaseId },
      f,
    );
    if (!b.body)
      return a.setNotice({
        tone: 'error',
        text: t(p.locale, b.error === 'nothing' ? 'm12.inc.nothing' : 'm12.inc.invalid'),
      });
    const body = b.body;
    void a.run(
      () =>
        browserApi().PATCH('/v1/admin/incidents/{id}', {
          params: { path: { id: p.id } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.inc.updated') });
        setF({ status: '', severity: '', note: '', commsDraft: '', breachCaseId: '' });
        router.refresh();
      },
      { 409: t(p.locale, 'm12.inc.invalidState'), 422: t(p.locale, 'm12.inc.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.inc.update.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.inc.update.title')}</h2>
      <Field id="iu-status" label={t(p.locale, 'm12.inc.col.status')}>
        {(x) => (
          <Select {...x} value={f.status} onChange={set('status')}>
            <option value="">{t(p.locale, 'm12.inc.update.keep')}</option>
            {next.map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.inc.status.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="iu-sev" label={t(p.locale, 'm12.inc.col.severity')}>
        {(x) => (
          <Select {...x} value={f.severity} onChange={set('severity')}>
            <option value="">{t(p.locale, 'm12.inc.update.keep')}</option>
            {SEVERITIES.filter((s) => s !== p.severity).map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.inc.sev.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="iu-note" label={t(p.locale, 'm12.inc.update.note')}>
        {(x) => <TextArea {...x} value={f.note} maxLength={4000} onChange={set('note')} />}
      </Field>
      <Field
        id="iu-comms"
        label={t(p.locale, 'm12.inc.update.comms')}
        help={t(p.locale, 'm12.inc.comms.help')}
      >
        {(x) => (
          <TextArea {...x} value={f.commsDraft} maxLength={4000} onChange={set('commsDraft')} />
        )}
      </Field>
      <Field id="iu-breach" label={t(p.locale, 'm12.inc.breach')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.breachCaseId}
            placeholder={p.breachCaseId ?? ''}
            onChange={set('breachCaseId')}
          />
        )}
      </Field>
      <p className="nz-muted">{t(p.locale, 'm12.inc.noPii')}</p>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.inc.update.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M12-07: alerts: acknowledge, silence with an expiry, define a rule ----------------------------------------------------

export function AlertActions(p: {
  locale: Locale;
  mfaFactorId: string | null;
  ruleKey: string;
  state: string;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [until, setUntil] = useState('');
  const [open, setOpen] = useState(false);
  const act = (
    body: Schemas['AlertAction'],
    done: 'm12.al.acked' | 'm12.al.silenced' | 'm12.al.unsilenced',
  ) =>
    void a.run(
      () =>
        browserApi().POST('/v1/admin/alerts', {
          params: { header: { 'Idempotency-Key': key() } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, done) });
        setOpen(false);
        router.refresh();
      },
      { 409: t(p.locale, 'm12.al.notFiring'), 422: t(p.locale, 'm12.al.silenceInvalid') },
    );
  function silence(e: FormEvent) {
    e.preventDefault();
    const c = silenceUntil(until);
    if (!c.until) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.al.silenceInvalid') });
    act({ action: 'silence', ruleKey: p.ruleKey, until: c.until }, 'm12.al.silenced');
  }
  return (
    <div>
      <div className="nz-row">
        {p.state === 'firing' && (
          <Button
            variant="secondary"
            disabled={a.busy}
            onClick={() => act({ action: 'acknowledge', ruleKey: p.ruleKey }, 'm12.al.acked')}
          >
            {t(p.locale, 'm12.al.ack')}
          </Button>
        )}
        {p.state === 'silenced' ? (
          <Button
            variant="secondary"
            disabled={a.busy}
            onClick={() => act({ action: 'unsilence', ruleKey: p.ruleKey }, 'm12.al.unsilenced')}
          >
            {t(p.locale, 'm12.al.unsilence')}
          </Button>
        ) : (
          <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {t(p.locale, 'm12.al.silence')}
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={silence} noValidate aria-label={t(p.locale, 'm12.al.silence')}>
          <Field
            id={`al-until-${p.ruleKey}`}
            label={t(p.locale, 'm12.al.until')}
            help={t(p.locale, 'm12.al.untilHelp')}
          >
            {(x) => (
              <Input
                {...x}
                type="datetime-local"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                required
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'm12.al.silenceSubmit')}
          </Button>
        </form>
      )}
      <Note n={a.notice} />
      {a.panel}
    </div>
  );
}

export function AlertDefineForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    ruleKey: '',
    title: '',
    severity: 'warning',
    ownerRole: '',
    runbookUrl: '',
    metric: '',
    op: '>',
    threshold: '',
  });
  const [idem, setIdem] = useState(key());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = defineAlertBody(f);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.al.invalid') });
    const body = b.body;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/alerts', {
          params: { header: { 'Idempotency-Key': idem } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.al.defined') });
        setIdem(key());
        router.refresh();
      },
      { 422: t(p.locale, 'm12.al.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.al.define.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.al.define.title')}</h2>
      <Field id="ad-key" label={t(p.locale, 'm12.al.define.key')}>
        {(x) => <Input {...x} dir="ltr" value={f.ruleKey} onChange={set('ruleKey')} required />}
      </Field>
      <Field id="ad-title" label={t(p.locale, 'm12.al.col.title')}>
        {(x) => <Input {...x} value={f.title} maxLength={200} onChange={set('title')} required />}
      </Field>
      <Field id="ad-sev" label={t(p.locale, 'm12.al.col.severity')}>
        {(x) => (
          <Select {...x} value={f.severity} onChange={set('severity')}>
            {ALERT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.al.sev.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="ad-owner"
        label={t(p.locale, 'm12.al.col.owner')}
        help={t(p.locale, 'm12.al.define.ownerHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.ownerRole} onChange={set('ownerRole')} required />}
      </Field>
      <Field
        id="ad-runbook"
        label={t(p.locale, 'm12.al.col.runbook')}
        help={t(p.locale, 'm12.al.define.runbookHelp')}
      >
        {(x) => (
          <Input {...x} dir="ltr" value={f.runbookUrl} onChange={set('runbookUrl')} required />
        )}
      </Field>
      <Field id="ad-metric" label={t(p.locale, 'm12.al.define.metric')}>
        {(x) => <Input {...x} dir="ltr" value={f.metric} onChange={set('metric')} required />}
      </Field>
      <Field id="ad-op" label={t(p.locale, 'm12.al.define.op')}>
        {(x) => (
          <Select {...x} dir="ltr" value={f.op} onChange={set('op')}>
            {ALERT_OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="ad-thr" label={t(p.locale, 'm12.al.define.threshold')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="decimal"
            value={f.threshold}
            onChange={set('threshold')}
            required
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.al.define.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M12-09: record a recovery exercise (RTO is computed from the two timestamps) -----------------------------------------

export function RecoveryExerciseForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    scope: 'control_plane_db',
    environment: 'staging',
    startedAt: '',
    restoredAt: '',
    rpoSeconds: '',
    evidence: '',
    notes: '',
  });
  const [idem, setIdem] = useState(key());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const rto = f.startedAt && f.restoredAt ? measuredRto(f.startedAt, f.restoredAt) : null;
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = recoveryExerciseBody(f);
    if (!b.body)
      return a.setNotice({
        tone: 'error',
        text: t(
          p.locale,
          b.error === 'restoredAt' || b.error === 'startedAt'
            ? 'm12.dr.invalidTimes'
            : 'm12.dr.invalid',
        ),
      });
    const body = b.body;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/recovery-exercises', {
          params: { header: { 'Idempotency-Key': idem } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.dr.recorded') });
        setIdem(key());
        setF({ ...f, startedAt: '', restoredAt: '', rpoSeconds: '', evidence: '', notes: '' });
        router.refresh();
      },
      { 422: t(p.locale, 'm12.dr.refused') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.dr.form.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.dr.form.title')}</h2>
      <p className="nz-muted">{t(p.locale, 'm12.dr.form.help')}</p>
      <Field id="dr-scope" label={t(p.locale, 'm12.dr.col.scope')}>
        {(x) => (
          <Select {...x} value={f.scope} onChange={set('scope')}>
            {EXERCISE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.dr.scope.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="dr-env" label={t(p.locale, 'm12.dr.col.env')} help={t(p.locale, 'm12.dr.envNote')}>
        {(x) => (
          <Select {...x} value={f.environment} onChange={set('environment')}>
            {EXERCISE_ENVIRONMENTS.map((s) => (
              <option key={s} value={s}>
                {t(p.locale, `m12.dr.env.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="dr-start" label={t(p.locale, 'm12.dr.col.started')}>
        {(x) => (
          <Input
            {...x}
            type="datetime-local"
            value={f.startedAt}
            onChange={set('startedAt')}
            required
          />
        )}
      </Field>
      <Field id="dr-end" label={t(p.locale, 'm12.dr.col.restored')}>
        {(x) => (
          <Input
            {...x}
            type="datetime-local"
            value={f.restoredAt}
            onChange={set('restoredAt')}
            required
          />
        )}
      </Field>
      <p role="status">
        <strong>{t(p.locale, 'm12.dr.rtoComputed')}</strong>{' '}
        {rto && 'seconds' in rto ? (
          <>
            <Ltr>{formatDuration(rto.seconds)}</Ltr> (<Ltr>{String(rto.seconds)}</Ltr>{' '}
            {t(p.locale, 'm12.unit.seconds')})
          </>
        ) : rto ? (
          <span className="nz-error-text">{t(p.locale, 'm12.dr.invalidTimes')}</span>
        ) : (
          '—'
        )}
      </p>
      <Field id="dr-rpo" label={t(p.locale, 'm12.dr.col.rpo')} help={t(p.locale, 'm12.dr.rpoHelp')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={f.rpoSeconds}
            onChange={set('rpoSeconds')}
            required
          />
        )}
      </Field>
      <Field
        id="dr-evidence"
        label={t(p.locale, 'm12.dr.col.evidence')}
        help={t(p.locale, 'm12.dr.evidenceHelp')}
      >
        {(x) => <TextArea {...x} dir="ltr" value={f.evidence} onChange={set('evidence')} />}
      </Field>
      <Field id="dr-notes" label={t(p.locale, 'm12.dr.col.notes')}>
        {(x) => <TextArea {...x} value={f.notes} maxLength={2000} onChange={set('notes')} />}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.dr.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
