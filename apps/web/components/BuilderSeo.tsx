'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Meter, Select } from '@nuzm/ui';
import {
  isBaseUrl,
  pageSeoOp,
  seoTone,
  siteSeoOp,
  type ProjectDetail,
  type SiteLocale,
} from '../lib/builder';
import { useProjectEditor } from '../lib/builder-client';
import { DiffView, ProblemNote, RiskList } from './BuilderBits';

const dirOf = (l: SiteLocale) => (l === 'ar' ? 'rtl' : 'ltr');

/** UI-M09-05: the SEO score report of the current version and the editing of site-level and page-level SEO (`setSeo` / `updatePage` ops with the base version). */
export function SeoPanel({
  locale,
  initial,
  canWrite,
}: {
  locale: Locale;
  initial: ProjectDetail;
  canWrite: boolean;
}) {
  const ed = useProjectEditor(initial);
  const { detail } = ed;
  const model = detail.siteModel;
  const L = model.locales as SiteLocale[];
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [done, setDone] = useState('');

  // drafts are re-seeded from the model whenever the version changes (key on the form)
  const siteInit = {
    title: Object.fromEntries(L.map((l) => [l, model.seo.siteTitle[l] ?? ''])),
    description: Object.fromEntries(L.map((l) => [l, model.seo.description[l] ?? ''])),
    baseUrl: model.seo.baseUrl ?? '',
  };
  const [site, setSite] = useState(siteInit);
  const [pageId, setPageId] = useState(model.pages[0]?.id ?? '');
  const page = model.pages.find((p) => p.id === pageId) ?? model.pages[0];
  const pageInit = {
    title: Object.fromEntries(L.map((l) => [l, page?.seo?.title?.[l] ?? ''])),
    description: Object.fromEntries(L.map((l) => [l, page?.seo?.description?.[l] ?? ''])),
    noindex: page?.seo?.noindex === true,
  };
  const [pg, setPg] = useState({ id: page?.id ?? '', ...pageInit });
  const pgNow = pg.id === page?.id ? pg : { id: page?.id ?? '', ...pageInit };
  // the drafts follow the saved version (after a save, or a reload that picked up someone else's change)
  useEffect(() => {
    setSite(siteInit);
    setPg({ id: page?.id ?? '', ...pageInit });
  }, [detail.versionId]);

  async function saveSite(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    for (const l of L) {
      if (!site.title[l]?.trim() || site.title[l]!.length > 70)
        next[`st-${l}`] = t(locale, 'bld.seo.err.title');
      if (!site.description[l]?.trim() || site.description[l]!.length > 200)
        next[`sd-${l}`] = t(locale, 'bld.seo.err.description');
    }
    if (site.baseUrl.trim() !== '' && !isBaseUrl(site.baseUrl.trim()))
      next.base = t(locale, 'bld.seo.err.baseUrl');
    setErrs(next);
    setDone('');
    if (Object.keys(next).length) return;
    if (await ed.apply([siteSeoOp(L, site)])) setDone(t(locale, 'bld.seo.saved'));
  }
  async function savePage(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    for (const key of ['title', 'description'] as const) {
      const filled = L.filter((l) => (pgNow[key][l] ?? '').trim() !== '').length;
      if (filled !== 0 && filled !== L.length)
        next[`p-${key}`] = t(locale, 'bld.seo.err.allOrNone');
    }
    setErrs(next);
    setDone('');
    if (Object.keys(next).length || !page) return;
    if (await ed.apply([pageSeoOp(page.id, L, pgNow)])) setDone(t(locale, 'bld.seo.saved'));
  }

  return (
    <>
      <section aria-labelledby="bld-seo-h">
        <h2 className="nz-h2" id="bld-seo-h">
          {t(locale, 'bld.seo.score')}
        </h2>
        <p className="nz-row">
          <Badge tone={seoTone(detail.seo.score)}>
            {t(locale, 'bld.seo.scoreValue', { score: detail.seo.score })}
          </Badge>
          <span className="nz-muted">
            {t(locale, 'bld.ws.version', { seq: detail.versionSeq })}
          </span>
        </p>
        <Meter label={t(locale, 'bld.seo.score')} percent={detail.seo.score} />
        <ul className="bld-list" aria-label={t(locale, 'bld.seo.checks')}>
          {detail.seo.checks.map((c) => (
            <li key={c.id}>
              <Badge tone={c.ok ? 'success' : 'warn'}>
                {t(locale, c.ok ? 'bld.seo.pass' : 'bld.seo.todo')}
              </Badge>{' '}
              <strong>{tDynamic(locale, `bld.seo.check.${c.id}`, c.id)}</strong>
              <div className="nz-muted">{locale === 'ar' ? c.message.ar : c.message.en}</div>
            </li>
          ))}
        </ul>
      </section>

      {!canWrite && <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>}
      <p role="status" aria-live="polite">
        {done}
      </p>
      {ed.stale && (
        <div role="alert" className="nz-banner" data-tone="warn">
          <p>{t(locale, 'bld.conflict.body')}</p>
          <Button variant="secondary" onClick={() => void ed.reload()}>
            {t(locale, 'bld.conflict.reload')}
          </Button>
        </div>
      )}
      {ed.problem && ed.problem.code !== 'base_outdated' && (
        <ProblemNote locale={locale} problem={ed.problem} />
      )}

      <form onSubmit={(e) => void saveSite(e)} key={`site-${detail.versionId}`} noValidate>
        <fieldset>
          <legend>{t(locale, 'bld.seo.site')}</legend>
          {L.map((l) => (
            <Field
              key={`st-${l}`}
              id={`bld-st-${l}`}
              label={`${t(locale, 'bld.seo.siteTitle')} (${t(locale, `bld.lang.${l}`)})`}
              help={t(locale, 'bld.seo.help.title')}
              error={errs[`st-${l}`]}
            >
              {(x) => (
                <Input
                  {...x}
                  lang={l}
                  dir={dirOf(l)}
                  readOnly={!canWrite}
                  value={site.title[l] ?? ''}
                  onChange={(e) =>
                    setSite((s) => ({ ...s, title: { ...s.title, [l]: e.target.value } }))
                  }
                />
              )}
            </Field>
          ))}
          {L.map((l) => (
            <Field
              key={`sd-${l}`}
              id={`bld-sd-${l}`}
              label={`${t(locale, 'bld.seo.siteDescription')} (${t(locale, `bld.lang.${l}`)})`}
              help={t(locale, 'bld.seo.help.description')}
              error={errs[`sd-${l}`]}
            >
              {(x) => (
                <textarea
                  {...x}
                  className="nz-input"
                  rows={2}
                  lang={l}
                  dir={dirOf(l)}
                  readOnly={!canWrite}
                  style={{ paddingBlock: 'var(--nuzm-space-2)' }}
                  value={site.description[l] ?? ''}
                  onChange={(e) =>
                    setSite((s) => ({
                      ...s,
                      description: { ...s.description, [l]: e.target.value },
                    }))
                  }
                />
              )}
            </Field>
          ))}
          <Field
            id="bld-base"
            label={t(locale, 'bld.seo.baseUrl')}
            help={t(locale, 'bld.seo.help.baseUrl')}
            error={errs.base}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                inputMode="url"
                readOnly={!canWrite}
                value={site.baseUrl}
                onChange={(e) => setSite((s) => ({ ...s, baseUrl: e.target.value }))}
              />
            )}
          </Field>
          {canWrite && (
            <Button type="submit" disabled={ed.busy}>
              {t(locale, 'bld.seo.saveSite')}
            </Button>
          )}
        </fieldset>
      </form>

      {page && (
        <form
          onSubmit={(e) => void savePage(e)}
          key={`page-${detail.versionId}-${page.id}`}
          noValidate
        >
          <fieldset>
            <legend>{t(locale, 'bld.seo.page')}</legend>
            <Field id="bld-seo-page" label={t(locale, 'bld.seo.pickPage')}>
              {(x) => (
                <Select {...x} value={page.id} onChange={(e) => setPageId(e.target.value)}>
                  {model.pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p.title[L[0]!] ?? p.slug) || p.slug}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {errs['p-title'] && (
              <span className="nz-error-text" role="alert">
                {errs['p-title']}
              </span>
            )}
            {L.map((l) => (
              <Field
                key={`pt-${l}`}
                id={`bld-pt-${l}`}
                label={`${t(locale, 'bld.seo.pageTitle')} (${t(locale, `bld.lang.${l}`)})`}
              >
                {(x) => (
                  <Input
                    {...x}
                    lang={l}
                    dir={dirOf(l)}
                    readOnly={!canWrite}
                    value={pgNow.title[l] ?? ''}
                    onChange={(e) =>
                      setPg({ ...pgNow, title: { ...pgNow.title, [l]: e.target.value } })
                    }
                  />
                )}
              </Field>
            ))}
            {errs['p-description'] && (
              <span className="nz-error-text" role="alert">
                {errs['p-description']}
              </span>
            )}
            {L.map((l) => (
              <Field
                key={`pd-${l}`}
                id={`bld-pd-${l}`}
                label={`${t(locale, 'bld.seo.pageDescription')} (${t(locale, `bld.lang.${l}`)})`}
              >
                {(x) => (
                  <textarea
                    {...x}
                    className="nz-input"
                    rows={2}
                    lang={l}
                    dir={dirOf(l)}
                    readOnly={!canWrite}
                    style={{ paddingBlock: 'var(--nuzm-space-2)' }}
                    value={pgNow.description[l] ?? ''}
                    onChange={(e) =>
                      setPg({
                        ...pgNow,
                        description: { ...pgNow.description, [l]: e.target.value },
                      })
                    }
                  />
                )}
              </Field>
            ))}
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={pgNow.noindex}
                  disabled={!canWrite}
                  onChange={(e) => setPg({ ...pgNow, noindex: e.target.checked })}
                />{' '}
                {t(locale, 'bld.seo.noindex')}
              </label>
            </p>
            {canWrite && (
              <Button type="submit" disabled={ed.busy}>
                {t(locale, 'bld.seo.savePage')}
              </Button>
            )}
          </fieldset>
        </form>
      )}

      {ed.last && (
        <section aria-labelledby="bld-seo-last" aria-live="polite">
          <h3 className="nz-h2" id="bld-seo-last">
            {t(locale, 'bld.diff.title', { seq: ed.last.newVersion.seq })}
          </h3>
          <DiffView locale={locale} diff={ed.last.diff} />
          <RiskList locale={locale} risks={ed.last.risks} />
        </section>
      )}
    </>
  );
}
