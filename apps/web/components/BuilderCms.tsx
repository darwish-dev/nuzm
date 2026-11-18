'use client';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import {
  CMS_FIELD_TYPES,
  FIELD_NAME,
  SLUG,
  cmsItemLabel,
  cmsValue,
  type CmsCollection,
  type CmsField,
  type SiteLocale,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';

const LOCS: SiteLocale[] = ['ar', 'en'];

type Raw = string | boolean | Record<string, string>;
const emptyRaw = (type: string): Raw =>
  type === 'boolean' ? false : type === 'localized_text' ? {} : '';

/** The typed editor of one new item: a control per collection field (text, number, boolean, date, text per language) and its publish state. */
function ItemEditor({
  locale,
  collection,
  onSaved,
  projectId,
}: {
  locale: Locale;
  collection: CmsCollection;
  projectId: string;
  onSaved: (list: CmsCollection[]) => void;
}) {
  const call = useBuilderCall();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<Record<string, Raw>>({});
  const [state, setState] = useState<'draft' | 'published'>('draft');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const val = (f: CmsField): Raw => raw[f.name] ?? emptyRaw(f.type);

  function submit(e: FormEvent) {
    e.preventDefault();
    const data: Record<string, unknown> = {};
    const next: Record<string, string> = {};
    for (const f of collection.fields) {
      if (f.type === 'boolean') {
        data[f.name] = val(f) === true;
        continue;
      }
      const v = cmsValue(f.type, val(f));
      if (v === null) next[f.name] = t(locale, 'bld.cms.err.type');
      else if (v === undefined) {
        if (f.required) next[f.name] = t(locale, 'bld.cms.err.required');
      } else data[f.name] = v;
    }
    setErrs(next);
    if (Object.keys(next).length) return;
    void call.run(
      () =>
        bapi.post<{ items: CmsCollection[] }>(`/v1/builder/projects/${projectId}/cms-collections`, {
          body: { collectionKey: collection.collectionKey, items: [{ data, state }] },
          idempotencyKey: newKey(),
        }),
      (r) => {
        setRaw({});
        setOpen(false);
        onSaved(r.items);
      },
    );
  }
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t(locale, 'bld.cms.addItem')}
      </Button>
    );
  return (
    <form onSubmit={submit} aria-label={t(locale, 'bld.cms.addItem')} noValidate>
      {collection.fields.map((f) => {
        const id = `bld-cms-${collection.collectionKey}-${f.name}`;
        const label = `${f.name}${f.required ? ' *' : ''}`;
        if (f.type === 'boolean')
          return (
            <p key={f.name}>
              <label>
                <input
                  type="checkbox"
                  checked={val(f) === true}
                  onChange={(e) => setRaw((r) => ({ ...r, [f.name]: e.target.checked }))}
                />{' '}
                <Ltr>{label}</Ltr>
              </label>
            </p>
          );
        if (f.type === 'localized_text')
          return (
            <fieldset key={f.name}>
              <legend>
                <Ltr>{label}</Ltr>
              </legend>
              {errs[f.name] && (
                <span className="nz-error-text" role="alert">
                  {errs[f.name]}
                </span>
              )}
              {LOCS.map((l) => (
                <Field key={l} id={`${id}-${l}`} label={t(locale, `bld.lang.${l}`)}>
                  {(x) => (
                    <Input
                      {...x}
                      lang={l}
                      dir={l === 'ar' ? 'rtl' : 'ltr'}
                      value={(val(f) as Record<string, string>)[l] ?? ''}
                      onChange={(e) =>
                        setRaw((r) => ({
                          ...r,
                          [f.name]: { ...(val(f) as Record<string, string>), [l]: e.target.value },
                        }))
                      }
                    />
                  )}
                </Field>
              ))}
            </fieldset>
          );
        return (
          <Field
            key={f.name}
            id={id}
            label={label}
            error={errs[f.name]}
            help={tDynamic(locale, `bld.cms.type.${f.type}`, f.type)}
          >
            {(x) => (
              <Input
                {...x}
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                dir={f.type === 'text' ? 'auto' : 'ltr'}
                value={val(f) as string}
                onChange={(e) => setRaw((r) => ({ ...r, [f.name]: e.target.value }))}
              />
            )}
          </Field>
        );
      })}
      <Field
        id={`bld-cms-${collection.collectionKey}-state`}
        label={t(locale, 'bld.cms.state')}
        help={t(locale, 'bld.cms.state.help')}
      >
        {(x) => (
          <Select
            {...x}
            value={state}
            onChange={(e) => setState(e.target.value as 'draft' | 'published')}
          >
            <option value="draft">{t(locale, 'bld.cms.state.draft')}</option>
            <option value="published">{t(locale, 'bld.cms.state.published')}</option>
          </Select>
        )}
      </Field>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <div className="nz-row">
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'action.save')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t(locale, 'action.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A new collection: key, name and 1..20 typed fields. */
function NewCollection({
  locale,
  projectId,
  onSaved,
}: {
  locale: Locale;
  projectId: string;
  onSaved: (list: CmsCollection[]) => void;
}) {
  const call = useBuilderCall();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<CmsField[]>([
    { name: 'title', type: 'text', required: true },
  ]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const setField = (i: number, patch: Partial<CmsField>) =>
    setFields((f) => f.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!SLUG.test(key.trim())) next.key = t(locale, 'bld.cms.err.key');
    if (name.trim().length < 1 || name.trim().length > 80)
      next.name = t(locale, 'bld.cms.err.name');
    const names = fields.map((f) => f.name.trim());
    if (
      fields.length < 1 ||
      names.some((n) => !FIELD_NAME.test(n)) ||
      new Set(names).size !== names.length
    )
      next.fields = t(locale, 'bld.cms.err.fields');
    setErrs(next);
    if (Object.keys(next).length) return;
    void call.run(
      () =>
        bapi.post<{ items: CmsCollection[] }>(`/v1/builder/projects/${projectId}/cms-collections`, {
          body: {
            collectionKey: key.trim(),
            name: name.trim(),
            fields: fields.map((f) => ({
              name: f.name.trim(),
              type: f.type,
              required: f.required === true,
            })),
          },
          idempotencyKey: newKey(),
        }),
      (r) => {
        setOpen(false);
        setKey('');
        setName('');
        onSaved(r.items);
      },
    );
  }
  if (!open)
    return (
      <p>
        <Button onClick={() => setOpen(true)}>{t(locale, 'bld.cms.newCollection')}</Button>
      </p>
    );
  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(locale, 'bld.cms.newCollection')}
      noValidate
    >
      <h2 className="nz-h2">{t(locale, 'bld.cms.newCollection')}</h2>
      <Field
        id="bld-ck"
        label={t(locale, 'bld.cms.key')}
        help={t(locale, 'bld.cms.key.help')}
        error={errs.key}
      >
        {(x) => <Input {...x} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />}
      </Field>
      <Field id="bld-cn" label={t(locale, 'bld.cms.name')} error={errs.name}>
        {(x) => (
          <Input {...x} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <fieldset>
        <legend>{t(locale, 'bld.cms.fields')}</legend>
        {errs.fields && (
          <span className="nz-error-text" role="alert">
            {errs.fields}
          </span>
        )}
        {fields.map((f, i) => (
          <div className="nz-row" key={i}>
            <Field id={`bld-cf-n-${i}`} label={t(locale, 'bld.cms.fieldName', { n: i + 1 })}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  value={f.name}
                  onChange={(e) => setField(i, { name: e.target.value })}
                />
              )}
            </Field>
            <Field id={`bld-cf-t-${i}`} label={t(locale, 'bld.cms.fieldType', { n: i + 1 })}>
              {(x) => (
                <Select
                  {...x}
                  value={f.type}
                  onChange={(e) => setField(i, { type: e.target.value })}
                >
                  {CMS_FIELD_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {tDynamic(locale, `bld.cms.type.${ty}`, ty)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <label>
              <input
                type="checkbox"
                checked={f.required === true}
                onChange={(e) => setField(i, { required: e.target.checked })}
              />{' '}
              {t(locale, 'bld.forms.required')}
            </label>
            <Button
              variant="secondary"
              disabled={fields.length <= 1}
              aria-label={t(locale, 'bld.cms.removeField', { n: i + 1 })}
              onClick={() => setFields((l) => l.filter((_, n) => n !== i))}
            >
              {t(locale, 'bld.forms.remove')}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          disabled={fields.length >= 20}
          onClick={() => setFields((l) => [...l, { name: '', type: 'text' }])}
        >
          {t(locale, 'bld.cms.addField')}
        </Button>
      </fieldset>
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

/** UI-M09-07: typed collections and their items with the publish state (only PUBLISHED items reach the built site), a typed item editor and new collections. Existing items cannot be edited: the API only adds them. */
export function CmsPanel({
  locale,
  projectId,
  initial,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  initial: CmsCollection[];
  canWrite: boolean;
}) {
  const [cols, setCols] = useState(initial);
  return (
    <>
      <Banner tone="warn">{t(locale, 'bld.cms.note')}</Banner>
      {canWrite && <NewCollection locale={locale} projectId={projectId} onSaved={setCols} />}
      {cols.length === 0 ? (
        <EmptyState
          title={t(locale, 'bld.cms.empty.title')}
          body={t(locale, 'bld.cms.empty.body')}
        />
      ) : (
        cols.map((c) => (
          <section key={c.id} className="nz-card" aria-labelledby={`bld-col-${c.id}`}>
            <h2 className="nz-h2" id={`bld-col-${c.id}`}>
              <bdi dir="auto">{c.name}</bdi> <Ltr>{c.collectionKey}</Ltr>
            </h2>
            <p className="nz-muted">
              {c.fields
                .map((f) => `${f.name} (${tDynamic(locale, `bld.cms.type.${f.type}`, f.type)})`)
                .join(' · ')}
            </p>
            {c.items.length === 0 ? (
              <p className="nz-muted">{t(locale, 'bld.cms.noItems')}</p>
            ) : (
              <Table
                caption={t(locale, 'bld.cms.items', { name: c.name })}
                rows={c.items}
                rowKey={(i) => i.id}
                columns={[
                  {
                    key: 'l',
                    header: t(locale, 'bld.cms.col.item'),
                    render: (i) => (
                      <bdi dir="auto">{cmsItemLabel(c.fields, i.data, locale) || '—'}</bdi>
                    ),
                  },
                  {
                    key: 's',
                    header: t(locale, 'bld.cms.col.state'),
                    render: (i) => (
                      <Badge tone={i.state === 'published' ? 'success' : undefined}>
                        {tDynamic(locale, `bld.cms.state.${i.state}`, i.state)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'u',
                    header: t(locale, 'bld.cms.col.updated'),
                    render: (i) => when(i.updatedAt, locale),
                  },
                ]}
              />
            )}
            {canWrite && (
              <ItemEditor locale={locale} collection={c} projectId={projectId} onSaved={setCols} />
            )}
          </section>
        ))
      )}
    </>
  );
}
