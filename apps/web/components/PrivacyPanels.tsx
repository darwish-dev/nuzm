'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { errorText } from '../lib/actions';
import { browserApi } from '../lib/client';
import {
  DSR_TYPES,
  RESIDENCY_MODES,
  formatCountries,
  parseCountries,
  requestBody,
  type DsrType,
  type ResidencyMode,
} from '../lib/privacy';
import { NoticeText } from './Feedback';

type Notice = { tone: 'error' | 'ok'; text: string } | null;
const key = () => crypto.randomUUID();
const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={3} {...p} />
);

/** UI-M04-01: withdraw a consent (applies at once; the row stays in the history). */
export function WithdrawButton({ locale, id }: { locale: Locale; id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function go() {
    setBusy(true);
    setN(null);
    const r = await browserApi().DELETE('/v1/compliance/consents/{id}', {
      params: { path: { id } },
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text: errorText(
          locale,
          r.response.status,
          (r.error as { code?: string } | undefined)?.code,
        ),
      });
    setN({ tone: 'ok', text: t(locale, 'pv.consents.withdrawn') });
    router.refresh();
  }
  return (
    <>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void go()}>
        {t(locale, 'pv.consents.withdraw')}
      </Button>
      <NoticeText notice={n} />
    </>
  );
}

/** UI-M04-03: open a request. A request about someone else is for administrators and needs a written identity check. */
export function NewRequestForm({ locale, canManage }: { locale: Locale; canManage: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<DsrType>('access');
  const [subject, setSubject] = useState('');
  const [attestation, setAttestation] = useState('');
  const [text, setText] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  const [idem, setIdem] = useState(key());
  async function submit(e: FormEvent) {
    e.preventDefault();
    const b = requestBody({ type, subject, attestation, text, displayName });
    if (!b.body)
      return setN({
        tone: 'error',
        text:
          b.error === 'attestation' ? t(locale, 'pv.req.identity') : t(locale, 'err.validation'),
      });
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/compliance/data-subject-requests', {
      params: { header: { 'Idempotency-Key': idem } },
      body: b.body as { type: DsrType },
    });
    setBusy(false);
    if (!r.response.ok) {
      const code = (r.error as { code?: string } | undefined)?.code;
      return setN({
        tone: 'error',
        text:
          r.response.status === 403
            ? t(locale, 'pv.req.forbidden')
            : code === 'dsr_identity_unverified'
              ? t(locale, 'pv.req.identity')
              : errorText(locale, r.response.status, code),
      });
    }
    setIdem(key());
    setN({ tone: 'ok', text: t(locale, 'pv.req.sent') });
    const id = (r.data as { id?: string } | undefined)?.id;
    router.push(id ? `/${locale}/privacy/requests/${id}` : `/${locale}/privacy/requests`);
    router.refresh();
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'pv.req.new')}
      style={{ maxInlineSize: 560 }}
    >
      <Field id="rq-type" label={t(locale, 'pv.req.type')}>
        {(x) => (
          <Select {...x} value={type} onChange={(e) => setType(e.target.value as DsrType)}>
            {DSR_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(locale, `pv.req.type.${k}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {type === 'correction' && (
        <Field id="rq-name" label={t(locale, 'pv.req.patchName')}>
          {(x) => (
            <Input
              {...x}
              value={displayName}
              maxLength={120}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field id="rq-text" label={t(locale, 'pv.req.details')}>
        {(x) => (
          <TextArea
            {...x}
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      {canManage && (
        <>
          <Field id="rq-subject" label={t(locale, 'pv.req.subject')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={subject}
                maxLength={128}
                onChange={(e) => setSubject(e.target.value)}
              />
            )}
          </Field>
          {subject.trim() !== '' && (
            <Field id="rq-attest" label={t(locale, 'pv.req.attest')}>
              {(x) => (
                <TextArea
                  {...x}
                  value={attestation}
                  maxLength={500}
                  onChange={(e) => setAttestation(e.target.value)}
                />
              )}
            </Field>
          )}
        </>
      )}
      <Button type="submit" disabled={busy}>
        {t(locale, 'pv.req.submit')}
      </Button>
      <NoticeText notice={n} />
    </form>
  );
}

/** UI-M04-06: request an organization export. Pending, ready, expired and "no store here" are all shown. */
export function ExportRequestButton({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  const [idem, setIdem] = useState(key());
  async function go() {
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/compliance/data-exports', {
      params: { header: { 'Idempotency-Key': idem } },
      body: { scope: 'org' },
    });
    setBusy(false);
    if (!r.response.ok) {
      const code = (r.error as { code?: string } | undefined)?.code;
      const text = JSON.stringify(r.error ?? '');
      return setN({
        tone: 'error',
        text: text.includes('no_export_sink')
          ? t(locale, 'pv.exp.noSink')
          : code === 'quota_exceeded' || text.includes('quota_exceeded')
            ? t(locale, 'pv.exp.quota')
            : errorText(locale, r.response.status, code),
      });
    }
    setIdem(key());
    setN({ tone: 'ok', text: t(locale, 'pv.exp.requested') });
    router.refresh();
  }
  return (
    <div className="nz-card">
      <Button type="button" disabled={busy} onClick={() => void go()}>
        {t(locale, 'pv.exp.request')}
      </Button>
      <NoticeText notice={n} />
    </div>
  );
}

/** UI-M05-05 (residency): view and tighten the policy. Sends the version it showed as If-Match; the API refuses to loosen the platform floor. */
export function ResidencyForm(p: {
  locale: Locale;
  version: number;
  mode: ResidencyMode;
  countries: Record<string, string[]>;
  floorClasses: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<ResidencyMode>(p.mode);
  const [countries, setCountries] = useState(formatCountries(p.countries));
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseCountries(countries);
    if (!parsed) return setN({ tone: 'error', text: t(p.locale, 'err.validation') });
    setBusy(true);
    setN(null);
    const r = await browserApi().PUT('/v1/compliance/residency-policy', {
      params: p.version > 0 ? { header: { 'If-Match': `"${p.version}"` } } : {},
      body: { mode, allowedCountriesByClass: mode === 'allow_listed' ? parsed : {} },
    });
    setBusy(false);
    if (!r.response.ok) {
      const code = (r.error as { code?: string } | undefined)?.code;
      return setN({
        tone: 'error',
        text:
          code === 'policy_below_floor'
            ? t(p.locale, 'pv.res.below')
            : r.response.status === 412
              ? t(p.locale, 'pv.res.stale')
              : errorText(p.locale, r.response.status, code),
      });
    }
    setN({ tone: 'ok', text: t(p.locale, 'pv.res.saved') });
    router.refresh();
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'pv.res.title')}
      style={{ maxInlineSize: 560 }}
    >
      <p className="nz-muted">
        {p.version === 0
          ? t(p.locale, 'pv.res.default')
          : t(p.locale, 'pv.res.version', { n: p.version })}
      </p>
      <Field id="rs-mode" label={t(p.locale, 'pv.res.mode')}>
        {(x) => (
          <Select
            {...x}
            value={mode}
            disabled={!p.canEdit}
            onChange={(e) => setMode(e.target.value as ResidencyMode)}
          >
            {RESIDENCY_MODES.map((k) => (
              <option key={k} value={k}>
                {tDynamic(p.locale, `pv.res.mode.${k}`, k)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {mode === 'allow_listed' && (
        <Field
          id="rs-countries"
          label={t(p.locale, 'pv.res.countries')}
          help={t(p.locale, 'pv.res.countriesHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={countries}
              disabled={!p.canEdit}
              onChange={(e) => setCountries(e.target.value)}
            />
          )}
        </Field>
      )}
      {p.canEdit ? (
        <Button type="submit" disabled={busy}>
          {t(p.locale, 'pv.res.save')}
        </Button>
      ) : (
        <p className="nz-muted">{t(p.locale, 'pv.res.readOnly')}</p>
      )}
      <NoticeText notice={n} />
    </form>
  );
}
