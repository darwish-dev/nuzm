'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import {
  INSERTABLE,
  draftOps,
  deleteOp,
  findSection,
  insertOp,
  inspectorFields,
  moveOp,
  nextSectionId,
  outlineOf,
  sampleSection,
  styleOf,
  type BuilderProblem,
  type ChangeResult,
  type InspectorField,
  type Op,
  type SiteLocale,
  type SiteModel,
  type StyleDraft,
} from '../lib/builder';
import { DiffView, ProblemNote, RiskList } from './BuilderBits';
import { ConfirmDialog } from './DataUi';

export interface Selection {
  pageId: string;
  sectionId: string;
}

/** The text and style fields of ONE component, remounted (via `key`) whenever the selection or the version changes so the draft never outlives its base. */
function SectionForm({
  locale,
  model,
  selection,
  canWrite,
  busy,
  apply,
  onDeleted,
}: {
  locale: Locale;
  model: SiteModel;
  selection: Selection;
  canWrite: boolean;
  busy: boolean;
  apply: (ops: Op[]) => Promise<boolean>;
  onDeleted: () => void;
}) {
  const section = findSection(model, selection.pageId, selection.sectionId)!;
  const fields = useMemo(() => inspectorFields(section, model.locales), [section, model.locales]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [style, setStyle] = useState<StyleDraft>(styleOf(section));
  const [confirm, setConfirm] = useState(false);
  const ops = draftOps(selection.pageId, section, fields, values, style);
  const page = model.pages.find((p) => p.id === selection.pageId)!;
  const index = page.sections.findIndex((s) => s.id === section.id);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ops.length > 0) void apply(ops);
  };
  const label = (f: InspectorField) =>
    `${tDynamic(locale, `bld.prop.${f.name}`, f.name)} (${t(locale, `bld.lang.${f.locale!}`)})`;
  const groups: { group: string | null; fields: InspectorField[] }[] = [];
  for (const f of fields) {
    const g = groups.find((x) => x.group === f.group);
    if (g) g.fields.push(f);
    else groups.push({ group: f.group, fields: [f] });
  }
  const input = (f: InspectorField, idx: number) => {
    const id = `bld-f-${f.key.replace(/[^a-z0-9]/gi, '-')}`;
    const value = values[f.key] ?? f.initial;
    const common = {
      value,
      readOnly: !canWrite,
      onChange: (e: { target: { value: string } }) =>
        setValues((v) => ({ ...v, [f.key]: e.target.value })),
    };
    const lab = f.kind === 'loc' ? label(f) : tDynamic(locale, `bld.prop.${f.name}`, f.name);
    return (
      <Field key={`${f.key}-${idx}`} id={id} label={lab}>
        {(x) =>
          f.multiline ? (
            <textarea
              {...x}
              {...common}
              className="nz-input"
              rows={3}
              style={{ paddingBlock: 'var(--nuzm-space-2)' }}
              lang={f.locale}
              dir={f.locale === 'ar' ? 'rtl' : f.locale ? 'ltr' : 'auto'}
            />
          ) : (
            <Input
              {...x}
              {...common}
              lang={f.locale}
              dir={f.locale === 'ar' ? 'rtl' : f.locale ? 'ltr' : 'auto'}
            />
          )
        }
      </Field>
    );
  };
  return (
    <form
      onSubmit={submit}
      aria-label={t(locale, 'bld.insp.form', {
        type: tDynamic(locale, `bld.section.${section.type}`, section.type),
      })}
    >
      <p className="nz-row">
        <strong>{tDynamic(locale, `bld.section.${section.type}`, section.type)}</strong>
        <Ltr>{section.id}</Ltr>
      </p>
      {groups.map((g) => (
        <fieldset key={g.group ?? 'top'}>
          {g.group && (
            <legend>{t(locale, 'bld.insp.item', { n: Number(g.group.split('.')[1]) + 1 })}</legend>
          )}
          {g.fields.map((f, i) => input(f, i))}
        </fieldset>
      ))}
      {fields.length === 0 && <p className="nz-muted">{t(locale, 'bld.insp.noText')}</p>}
      <fieldset>
        <legend>{t(locale, 'bld.insp.style')}</legend>
        <Field id="bld-st-bg" label={t(locale, 'bld.style.background')}>
          {(x) => (
            <Select
              {...x}
              value={style.background}
              disabled={!canWrite}
              onChange={(e) => setStyle((s) => ({ ...s, background: e.target.value }))}
            >
              <option value="">{t(locale, 'bld.style.unset')}</option>
              {['default', 'muted', 'primary'].map((v) => (
                <option key={v} value={v}>
                  {t(locale, `bld.style.value.${v}` as 'bld.style.value.default')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="bld-st-align" label={t(locale, 'bld.style.align')}>
          {(x) => (
            <Select
              {...x}
              value={style.align}
              disabled={!canWrite}
              onChange={(e) => setStyle((s) => ({ ...s, align: e.target.value }))}
            >
              <option value="">{t(locale, 'bld.style.unset')}</option>
              {['start', 'center'].map((v) => (
                <option key={v} value={v}>
                  {t(locale, `bld.style.value.${v}` as 'bld.style.value.start')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </fieldset>
      {canWrite && (
        <div className="nz-row">
          <Button type="submit" disabled={busy || ops.length === 0}>
            {t(locale, 'bld.insp.apply')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || index <= 0}
            onClick={() => void apply([moveOp(selection.pageId, section.id, index - 1)])}
          >
            {t(locale, 'bld.insp.moveUp')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || index >= page.sections.length - 1}
            onClick={() => void apply([moveOp(selection.pageId, section.id, index + 1)])}
          >
            {t(locale, 'bld.insp.moveDown')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>
            {t(locale, 'bld.insp.delete')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={t(locale, 'bld.insp.delete.title')}
        onClose={() => setConfirm(false)}
      >
        <p>{t(locale, 'bld.insp.delete.body')}</p>
        <div className="nz-row">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              void apply([deleteOp(selection.pageId, section.id)]).then((ok) => {
                setConfirm(false);
                if (ok) onDeleted();
              });
            }}
          >
            {t(locale, 'bld.insp.delete.confirm')}
          </Button>
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
      </ConfirmDialog>
    </form>
  );
}

/**
 * UI-M09-03 right panel: the outline of the site (every component of every page as a button: keyboard operable, the current one marked), the property
 * inspector of the selected component (text per site language and simple props; each Apply sends ops with the base version), undo / redo (the inverse ops
 * the server returned), and the result of the last change (safe diff, risk flags, a stale-base banner with reload / rebase, validation issues).
 */
export function Inspector({
  locale,
  model,
  versionId,
  selection,
  onSelect,
  canWrite,
  busy,
  apply,
  canUndo,
  canRedo,
  undo,
  redo,
  last,
  problem,
  conflict,
  onReload,
  onRebase,
}: {
  locale: Locale;
  model: SiteModel;
  versionId: string;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  canWrite: boolean;
  busy: boolean;
  apply: (ops: Op[]) => Promise<boolean>;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  last: ChangeResult | null;
  problem: BuilderProblem | null;
  conflict: { headSeq?: number } | null;
  onReload: () => void;
  onRebase: () => void;
}) {
  const outline = outlineOf(model, locale as SiteLocale);
  const selected = selection
    ? findSection(model, selection.pageId, selection.sectionId)
    : undefined;
  const [type, setType] = useState<string>(INSERTABLE[0]);
  const pages = model.pages;
  const insertTypes = INSERTABLE.filter((x) => sampleSection(model, x, 'probe') !== null);
  const targetPage = selection?.pageId ?? pages[0]?.id;

  const add = () => {
    if (!targetPage) return;
    const s = sampleSection(model, type, nextSectionId(model, type));
    if (s) void apply([insertOp(targetPage, s)]);
  };
  return (
    <div>
      <h2 className="nz-h2">{t(locale, 'bld.insp.title')}</h2>
      {!canWrite && <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>}
      {canWrite && (
        <div className="nz-row" role="group" aria-label={t(locale, 'bld.insp.history')}>
          <Button variant="secondary" disabled={!canUndo || busy} onClick={undo}>
            {t(locale, 'bld.insp.undo')}
          </Button>
          <Button variant="secondary" disabled={!canRedo || busy} onClick={redo}>
            {t(locale, 'bld.insp.redo')}
          </Button>
        </div>
      )}
      {conflict && (
        <div role="alert" className="nz-banner" data-tone="warn">
          <p>
            {conflict.headSeq !== undefined
              ? t(locale, 'bld.conflict.bodyAt', { seq: conflict.headSeq })
              : t(locale, 'bld.conflict.body')}
          </p>
          <div className="nz-row">
            <Button variant="secondary" disabled={busy} onClick={onReload}>
              {t(locale, 'bld.conflict.reload')}
            </Button>
            <Button disabled={busy} onClick={onRebase}>
              {t(locale, 'bld.conflict.rebase')}
            </Button>
          </div>
        </div>
      )}
      {problem && problem.code !== 'base_outdated' && (
        <ProblemNote locale={locale} problem={problem} />
      )}
      <nav aria-label={t(locale, 'bld.outline.label')}>
        <h3 className="nz-h2">{t(locale, 'bld.outline.title')}</h3>
        <ul className="bld-list">
          {pages.map((p) => (
            <li key={p.id}>
              <strong>{outline.find((o) => o.pageId === p.id)?.pageLabel ?? p.slug}</strong>
              <ul className="bld-list">
                {outline
                  .filter((o) => o.pageId === p.id)
                  .map((o) => {
                    const on = selection?.sectionId === o.sectionId;
                    return (
                      <li key={o.sectionId}>
                        <button
                          type="button"
                          className="nz-btn"
                          data-variant={on ? 'primary' : 'secondary'}
                          aria-current={on ? 'true' : undefined}
                          onClick={() => onSelect({ pageId: o.pageId, sectionId: o.sectionId })}
                        >
                          {tDynamic(locale, `bld.section.${o.type}`, o.type)}
                          {o.label ? ` — ${o.label.slice(0, 30)}` : ''}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
      {canWrite && insertTypes.length > 0 && (
        <div className="nz-row">
          <Field id="bld-insert-type" label={t(locale, 'bld.insp.insertType')}>
            {(x) => (
              <Select {...x} value={type} onChange={(e) => setType(e.target.value)}>
                {insertTypes.map((x2) => (
                  <option key={x2} value={x2}>
                    {tDynamic(locale, `bld.section.${x2}`, x2)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="secondary" disabled={busy} onClick={add}>
            {t(locale, 'bld.insp.insert')}
          </Button>
        </div>
      )}
      {selection && selected ? (
        <SectionForm
          key={`${selection.sectionId}:${versionId}`}
          locale={locale}
          model={model}
          selection={selection}
          canWrite={canWrite}
          busy={busy}
          apply={apply}
          onDeleted={() => onSelect(null)}
        />
      ) : (
        <p className="nz-muted">{t(locale, 'bld.insp.select')}</p>
      )}
      {last && (
        <section aria-labelledby="bld-last-h" aria-live="polite">
          <h3 className="nz-h2" id="bld-last-h">
            {t(locale, 'bld.diff.title', { seq: last.newVersion.seq })}
          </h3>
          <DiffView locale={locale} diff={last.diff} />
          <RiskList locale={locale} risks={last.risks} />
        </section>
      )}
    </div>
  );
}
