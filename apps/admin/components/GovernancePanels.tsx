'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { createReviewBody, decisionBody, publishPolicyBody, putRetentionBody } from '../lib/ops';
import { Note, useStaffAction } from './BillingAdminPanels';

const key = () => crypto.randomUUID();
const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={3} {...p} />
);

// ---- UI-M12-10: create an access review campaign ------------------------------------------------------------------------------

export function AccessReviewCreateForm(p: { locale: Locale; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({ orgId: '', reviewers: '', dueAt: '' });
  const [idem, setIdem] = useState(key());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = createReviewBody(f);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.ar.invalid') });
    const body = b.body;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/access-reviews', {
          params: { header: { 'Idempotency-Key': idem } },
          body,
        }),
      (data) => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.ar.created') });
        setIdem(key());
        const id = (data as { id?: string } | undefined)?.id;
        if (id) router.push(`/${p.locale}/access-reviews/${id}`);
        else router.refresh();
      },
      { 404: t(p.locale, 'm12.ar.orgNotFound'), 422: t(p.locale, 'm12.ar.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.ar.create.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.ar.create.title')}</h2>
      <p className="nz-muted">{t(p.locale, 'm12.ar.create.help')}</p>
      <Field id="ar-org" label={t(p.locale, 'm12.ar.create.org')}>
        {(x) => <Input {...x} dir="ltr" value={f.orgId} onChange={set('orgId')} required />}
      </Field>
      <Field
        id="ar-rev"
        label={t(p.locale, 'm12.ar.create.reviewers')}
        help={t(p.locale, 'm12.ar.create.reviewersHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.reviewers} onChange={set('reviewers')} required />}
      </Field>
      <Field id="ar-due" label={t(p.locale, 'm12.ar.col.due')}>
        {(x) => (
          <Input {...x} type="datetime-local" value={f.dueAt} onChange={set('dueAt')} required />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.ar.create.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M12-11: keep or revoke one member, with a reason ----------------------------------------------------------------------

export function ReviewDecision(p: {
  locale: Locale;
  mfaFactorId: string | null;
  reviewId: string;
  itemId: string;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [reason, setReason] = useState('');
  const [idem, setIdem] = useState(key());
  function decide(decision: 'keep' | 'revoke') {
    const b = decisionBody(p.itemId, decision, reason);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.ar.reasonNeeded') });
    const body = b.body;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/access-reviews/{id}/decisions', {
          params: { path: { id: p.reviewId }, header: { 'Idempotency-Key': idem } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.ar.decided') });
        setIdem(key());
        router.refresh();
      },
      {
        403: t(p.locale, 'm12.ar.notReviewer'),
        409: t(p.locale, 'm12.ar.decisionConflict'),
        422: t(p.locale, 'm12.ar.reasonNeeded'),
      },
    );
  }
  return (
    <div>
      <Field id={`rd-${p.itemId}`} label={t(p.locale, 'm12.ar.reason')}>
        {(x) => (
          <Input
            {...x}
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div className="nz-row">
        <Button variant="secondary" disabled={a.busy} onClick={() => decide('keep')}>
          {t(p.locale, 'm12.ar.keep')}
        </Button>
        <Button variant="danger" disabled={a.busy} onClick={() => decide('revoke')}>
          {t(p.locale, 'm12.ar.revoke')}
        </Button>
      </div>
      <Note n={a.notice} />
      {a.panel}
    </div>
  );
}

// ---- UI-M12-12: publish a policy version --------------------------------------------------------------------------------------

export function PolicyPublishForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  /** Current version per policy key: the If-Match of a publish ("0" for a key that has none). */
  versions: Record<string, number>;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    policyKey: '',
    title: '',
    bodyRef: '',
    effectiveFrom: '',
    approvedBy: '',
    approvalRef: '',
    changeNote: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const current = p.versions[f.policyKey.trim()] ?? 0;
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = publishPolicyBody(f);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.pol.invalid') });
    const body = b.body;
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/policy-versions', {
          params: { header: { 'If-Match': `"${current}"` } },
          body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.pol.published') });
        setF({ ...f, title: '', bodyRef: '', approvedBy: '', approvalRef: '', changeNote: '' });
        router.refresh();
      },
      { 412: t(p.locale, 'm12.pol.stale'), 422: t(p.locale, 'm12.pol.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.pol.form.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.pol.form.title')}</h2>
      <Field id="pp-key" label={t(p.locale, 'm12.pol.col.key')}>
        {(x) => (
          <>
            <Input
              {...x}
              dir="ltr"
              list="pp-keys"
              value={f.policyKey}
              onChange={set('policyKey')}
              required
            />
            <datalist id="pp-keys">
              {Object.keys(p.versions).map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <p className="nz-muted">{t(p.locale, 'm12.pol.form.current', { version: current })}</p>
      <Field id="pp-title" label={t(p.locale, 'm12.pol.col.title')}>
        {(x) => <Input {...x} value={f.title} maxLength={200} onChange={set('title')} required />}
      </Field>
      <Field
        id="pp-ref"
        label={t(p.locale, 'm12.pol.col.ref')}
        help={t(p.locale, 'm12.pol.form.refHelp')}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.bodyRef}
            maxLength={300}
            onChange={set('bodyRef')}
            required
          />
        )}
      </Field>
      <Field id="pp-eff" label={t(p.locale, 'm12.pol.col.effective')}>
        {(x) => (
          <Input
            {...x}
            type="date"
            value={f.effectiveFrom}
            onChange={set('effectiveFrom')}
            required
          />
        )}
      </Field>
      <Field
        id="pp-appr"
        label={t(p.locale, 'm12.pol.form.approver')}
        help={t(p.locale, 'm12.pol.form.approverHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.approvedBy} onChange={set('approvedBy')} />}
      </Field>
      <Field id="pp-aref" label={t(p.locale, 'm12.pol.form.approvalRef')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.approvalRef}
            maxLength={300}
            onChange={set('approvalRef')}
          />
        )}
      </Field>
      <Field id="pp-note" label={t(p.locale, 'm12.pol.form.note')}>
        {(x) => (
          <TextArea {...x} value={f.changeNote} maxLength={1000} onChange={set('changeNote')} />
        )}
      </Field>
      <p className="nz-muted">{t(p.locale, 'm12.pol.form.draftNote')}</p>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.pol.form.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M12-14: set an audit retention class (a new policy version; nothing is archived or deleted) ---------------------------

export function RetentionForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  minimumDays: number | null;
  policies: { dataClass: string; version: number }[];
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState({
    dataClass: '',
    retainDays: '',
    archiveAfterDays: '',
    basis: '',
    status: 'proposal',
    documentRef: '',
    changeNote: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const existing = p.policies.find((x) => x.dataClass === f.dataClass.trim());
  function submit(e: FormEvent) {
    e.preventDefault();
    const b = putRetentionBody(f, p.minimumDays, existing?.version ?? null);
    if (!b.body)
      return a.setNotice({
        tone: 'error',
        text: t(p.locale, b.error === 'minimum' ? 'm12.ret.belowMinimum' : 'm12.ret.invalid'),
      });
    const body = b.body;
    void a.run(
      () => browserApi().PUT('/v1/admin/audit-retention', { body }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.ret.saved') });
        router.refresh();
      },
      {
        409: t(p.locale, 'm12.ret.conflict'),
        422: t(p.locale, 'm12.ret.refused'),
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.ret.form.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.ret.form.title')}</h2>
      <Field id="rt-class" label={t(p.locale, 'm12.ret.col.class')}>
        {(x) => (
          <>
            <Input
              {...x}
              dir="ltr"
              list="rt-classes"
              value={f.dataClass}
              onChange={set('dataClass')}
              required
            />
            <datalist id="rt-classes">
              {p.policies.map((x2) => (
                <option key={x2.dataClass} value={x2.dataClass} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field
        id="rt-retain"
        label={t(p.locale, 'm12.ret.col.retain')}
        help={
          p.minimumDays === null
            ? undefined
            : t(p.locale, 'm12.ret.form.retainHelp', { days: p.minimumDays })
        }
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={f.retainDays}
            onChange={set('retainDays')}
            required
          />
        )}
      </Field>
      <Field id="rt-archive" label={t(p.locale, 'm12.ret.col.archive')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={f.archiveAfterDays}
            onChange={set('archiveAfterDays')}
            required
          />
        )}
      </Field>
      <Field id="rt-basis" label={t(p.locale, 'm12.ret.col.basis')}>
        {(x) => <Input {...x} value={f.basis} maxLength={500} onChange={set('basis')} required />}
      </Field>
      <Field id="rt-status" label={t(p.locale, 'm12.ret.col.status')}>
        {(x) => (
          <Select {...x} value={f.status} onChange={set('status')}>
            <option value="proposal">{t(p.locale, 'm12.ret.status.proposal')}</option>
            <option value="approved">{t(p.locale, 'm12.ret.status.approved')}</option>
          </Select>
        )}
      </Field>
      <Field
        id="rt-doc"
        label={t(p.locale, 'm12.ret.col.doc')}
        help={t(p.locale, 'm12.ret.form.docHelp')}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.documentRef}
            maxLength={200}
            onChange={set('documentRef')}
          />
        )}
      </Field>
      <Field id="rt-note" label={t(p.locale, 'm12.pol.form.note')}>
        {(x) => (
          <TextArea {...x} value={f.changeNote} maxLength={500} onChange={set('changeNote')} />
        )}
      </Field>
      {existing && (
        <p className="nz-muted">
          {t(p.locale, 'm12.ret.form.version', { version: existing.version })}
        </p>
      )}
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.ret.form.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
