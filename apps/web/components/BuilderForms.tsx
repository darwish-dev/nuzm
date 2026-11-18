'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  Ltr,
  Select,
  Table,
} from '@nuzm/ui';
import {
  FIELD_NAME,
  SLUG,
  type BuilderForm,
  type FormField,
  type Submission,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';
import { CopyButton } from './DataUi';

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea'] as const;
const HONEYPOT = 'website_url';

/** UI-M09-06 create form: key, name, 1..12 typed fields, optional notification address and retention. */
function CreateForm({ locale, projectId }: { locale: Locale; projectId: string }) {
  const router = useRouter();
  const call = useBuilderCall();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<(FormField & { required: boolean })[]>([
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true },
  ]);
  const [notify, setNotify] = useState('');
  const [days, setDays] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});

  const setField = (i: number, patch: Partial<FormField & { required: boolean }>) =>
    setFields((f) => f.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!SLUG.test(key.trim())) next.key = t(locale, 'bld.forms.err.key');
    if (name.trim().length < 1 || name.trim().length > 80)
      next.name = t(locale, 'bld.forms.err.name');
    const names = fields.map((f) => f.name.trim());
    if (
      fields.length < 1 ||
      names.some((n) => !FIELD_NAME.test(n) || n === HONEYPOT) ||
      new Set(names).size !== names.length
    )
      next.fields = t(locale, 'bld.forms.err.fields');
    if (notify.trim() !== '' && !/^[^@\s<>"]{1,64}@[^@\s<>"]{1,200}$/.test(notify.trim()))
      next.notify = t(locale, 'bld.forms.err.notify');
    if (days.trim() !== '' && !/^\d{1,4}$/.test(days.trim()))
      next.days = t(locale, 'bld.forms.err.days');
    else if (days.trim() !== '' && (Number(days) < 1 || Number(days) > 3650))
      next.days = t(locale, 'bld.forms.err.days');
    setErrs(next);
    if (Object.keys(next).length) return;
    void call.run(
      () =>
        bapi.post<BuilderForm>(`/v1/builder/projects/${projectId}/forms`, {
          body: {
            formKey: key.trim(),
            name: name.trim(),
            fields: fields.map((f) => ({
              name: f.name.trim(),
              type: f.type,
              required: f.required,
            })),
            ...(notify.trim() ? { notifyEmail: notify.trim() } : {}),
            ...(days.trim() ? { retentionDays: Number(days) } : {}),
          },
          idempotencyKey: newKey(),
        }),
      () => {
        setOpen(false);
        setKey('');
        setName('');
        router.refresh();
      },
    );
  }
  if (!open)
    return (
      <p>
        <Button onClick={() => setOpen(true)}>{t(locale, 'bld.forms.create')}</Button>
      </p>
    );
  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(locale, 'bld.forms.create')}
      noValidate
    >
      <h2 className="nz-h2">{t(locale, 'bld.forms.create')}</h2>
      <Field
        id="bld-fk"
        label={t(locale, 'bld.forms.key')}
        help={t(locale, 'bld.forms.key.help')}
        error={errs.key}
      >
        {(x) => <Input {...x} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />}
      </Field>
      <Field id="bld-fn" label={t(locale, 'bld.forms.name')} error={errs.name}>
        {(x) => (
          <Input {...x} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <fieldset>
        <legend>{t(locale, 'bld.forms.fields')}</legend>
        {errs.fields && (
          <span className="nz-error-text" role="alert">
            {errs.fields}
          </span>
        )}
        {fields.map((f, i) => (
          <div className="nz-row" key={i}>
            <Field id={`bld-ff-n-${i}`} label={t(locale, 'bld.forms.fieldName', { n: i + 1 })}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  value={f.name}
                  onChange={(e) => setField(i, { name: e.target.value })}
                />
              )}
            </Field>
            <Field id={`bld-ff-t-${i}`} label={t(locale, 'bld.forms.fieldType', { n: i + 1 })}>
              {(x) => (
                <Select
                  {...x}
                  value={f.type}
                  onChange={(e) => setField(i, { type: e.target.value })}
                >
                  {FIELD_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {tDynamic(locale, `bld.forms.type.${ty}`, ty)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <label>
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => setField(i, { required: e.target.checked })}
              />{' '}
              {t(locale, 'bld.forms.required')}
            </label>
            <Button
              variant="secondary"
              disabled={fields.length <= 1}
              onClick={() => setFields((l) => l.filter((_, n) => n !== i))}
              aria-label={t(locale, 'bld.forms.removeField', { n: i + 1 })}
            >
              {t(locale, 'bld.forms.remove')}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          disabled={fields.length >= 12}
          onClick={() => setFields((l) => [...l, { name: '', type: 'text', required: false }])}
        >
          {t(locale, 'bld.forms.addField')}
        </Button>
      </fieldset>
      <Field
        id="bld-fe"
        label={t(locale, 'bld.forms.notify')}
        help={t(locale, 'bld.forms.notify.help')}
        error={errs.notify}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            type="email"
            value={notify}
            onChange={(e) => setNotify(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="bld-fd"
        label={t(locale, 'bld.forms.retention')}
        help={t(locale, 'bld.forms.retention.help')}
        error={errs.days}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        )}
      </Field>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <div className="nz-row">
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'action.create')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t(locale, 'action.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** UI-M09-06: forms of the project (counts, spam blocked, public endpoint), the submissions table (personal data: masked for roles without `builder:submissions:read`) and form creation. */
export function FormsPanel({
  locale,
  projectId,
  forms,
  submissions,
  nextCursor,
  formId,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  forms: BuilderForm[];
  submissions: Submission[];
  nextCursor: string | null;
  formId: string;
  canWrite: boolean;
}) {
  const masked = submissions.some((s) => s.masked);
  const base = `/${locale}/builder/projects/${projectId}/forms`;
  return (
    <>
      {canWrite && <CreateForm locale={locale} projectId={projectId} />}
      {forms.length === 0 ? (
        <EmptyState
          title={t(locale, 'bld.forms.empty.title')}
          body={t(locale, 'bld.forms.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'bld.forms.list')}
          rows={forms}
          rowKey={(f) => f.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'bld.forms.col.name'),
              render: (f) => (
                <>
                  <bdi dir="auto">{f.name}</bdi> <Ltr>{f.formKey}</Ltr>
                </>
              ),
            },
            { key: 'f', header: t(locale, 'bld.forms.col.fields'), render: (f) => f.fields.length },
            {
              key: 's',
              header: t(locale, 'bld.forms.col.submissions'),
              render: (f) => <a href={`${base}?formId=${f.id}`}>{f.submissions}</a>,
            },
            {
              key: 'b',
              header: t(locale, 'bld.forms.col.spam'),
              render: (f) => f.spamBlocked,
            },
            {
              key: 'e',
              header: t(locale, 'bld.forms.col.endpoint'),
              render: (f) => (
                <>
                  <Ltr>{f.endpoint}</Ltr>{' '}
                  <CopyButton
                    locale={locale}
                    text={f.endpoint}
                    label={t(locale, 'bld.forms.copyEndpoint', { name: f.name })}
                  />
                </>
              ),
            },
            {
              key: 'x',
              header: t(locale, 'bld.forms.col.state'),
              render: (f) => (
                <Badge tone={f.enabled ? 'success' : undefined}>
                  {t(locale, f.enabled ? 'bld.forms.enabled' : 'bld.forms.disabled')}
                </Badge>
              ),
            },
          ]}
        />
      )}
      <h2 className="nz-h2">{t(locale, 'bld.forms.submissions')}</h2>
      {formId && (
        <p>
          <a href={base}>{t(locale, 'bld.forms.clearFilter')}</a>
        </p>
      )}
      {masked && <Banner tone="warn">{t(locale, 'bld.forms.masked')}</Banner>}
      {submissions.length === 0 ? (
        <EmptyState
          title={t(locale, 'bld.forms.noSubmissions')}
          body={t(locale, 'state.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'bld.forms.submissions')}
          rows={submissions}
          rowKey={(s) => s.id}
          columns={[
            {
              key: 'f',
              header: t(locale, 'bld.forms.col.form'),
              render: (s) => <Ltr>{s.formKey}</Ltr>,
            },
            {
              key: 'c',
              header: t(locale, 'bld.forms.col.received'),
              render: (s) => when(s.createdAt, locale),
            },
            {
              key: 'v',
              header: t(locale, 'bld.forms.col.values'),
              render: (s) => (
                <dl>
                  {Object.entries(s.fields).map(([k, v]) => (
                    <div key={k}>
                      <dt>
                        <Ltr>{k}</Ltr>
                      </dt>
                      <dd>
                        <bdi dir="auto">{v}</bdi>
                      </dd>
                    </div>
                  ))}
                </dl>
              ),
            },
            {
              key: 'x',
              header: t(locale, 'bld.forms.col.expires'),
              render: (s) => when(s.expiresAt, locale),
            },
          ]}
        />
      )}
      {nextCursor && (
        <ButtonLink
          variant="secondary"
          href={`${base}?${formId ? `formId=${formId}&` : ''}cursor=${encodeURIComponent(nextCursor)}`}
        >
          {t(locale, 'action.loadMore')}
        </ButtonLink>
      )}
    </>
  );
}
