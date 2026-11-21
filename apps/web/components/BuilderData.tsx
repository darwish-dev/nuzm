'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import {
  type BuilderForm,
  type CmsCollection,
  type Page_,
  type SiteLocale,
  type SiteModel,
  type Submission,
  type Version,
} from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';

type Table = {
  id: string;
  kind: 'form' | 'cms';
  name: string;
  count: number;
  columns: string[];
  rows: Record<string, string>[];
  masked: boolean;
};

const cell = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);

/**
 * The tables a project collects: its forms (submissions such as leads) and its content collections, as cards with a browsable table of rows. Read-only; each table
 * links to its full screen for creating forms and collections. Values come from the API as text and are shown as text only (masked values stay masked: the API
 * decides who sees what). `empty` replaces the "no tables yet" state (a web app has no forms or collections of its own).
 */
export function RecordsPane({
  locale,
  projectId,
  empty,
}: {
  locale: Locale;
  projectId: string;
  empty?: ReactNode;
}) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const base = `/builder/projects/${projectId}`;
  useEffect(() => {
    let stop = false;
    void (async () => {
      const forms = await bapi.get<{ items: BuilderForm[] }>(
        `/v1/builder/projects/${projectId}/forms`,
      );
      const cms = await bapi.get<{ items: CmsCollection[] }>(
        `/v1/builder/projects/${projectId}/cms-collections`,
      );
      const out: Table[] = [];
      if (forms.response.ok && forms.data)
        for (const f of forms.data.items) {
          const subs = await bapi.get<Page_<Submission>>(
            `/v1/builder/projects/${projectId}/form-submissions`,
            { query: { limit: 50, formId: f.id } },
          );
          const items = subs.response.ok && subs.data ? subs.data.items : [];
          out.push({
            id: `form:${f.id}`,
            kind: 'form',
            name: f.name,
            count: f.submissions,
            columns: [...f.fields.map((x) => x.name), 'createdAt'],
            rows: items.map((s) => ({ ...s.fields, createdAt: when(s.createdAt, locale) })),
            masked: items.some((s) => s.masked),
          });
        }
      if (cms.response.ok && cms.data)
        for (const c of cms.data.items)
          out.push({
            id: `cms:${c.id}`,
            kind: 'cms',
            name: c.name,
            count: c.items.length,
            columns: [...c.fields.map((x) => x.name), 'state'],
            rows: c.items.map((i) => ({
              ...Object.fromEntries(c.fields.map((x) => [x.name, cell(i.data[x.name])])),
              state: i.state,
            })),
            masked: false,
          });
      if (stop) return;
      setTables(out);
      setSelected((cur) => cur ?? out[0]?.id ?? null);
    })();
    return () => {
      stop = true;
    };
  }, [projectId, locale]);

  const current = useMemo(() => tables?.find((x) => x.id === selected) ?? null, [tables, selected]);
  return (
    <>
      {tables === null ? (
        <p role="status" aria-busy="true" className="nz-muted">
          {t(locale, 'state.loading')}
        </p>
      ) : tables.length === 0 ? (
        (empty ?? (
          <div className="bwd-empty">
            <Icon name="data" size={26} />
            <strong>{t(locale, 'bld.dx.empty.title')}</strong>
            <p className="nz-muted">{t(locale, 'bld.dx.empty.body')}</p>
            <span className="bwd-links">
              <a href={`${base}/forms`}>{t(locale, 'bld.tab.forms')}</a>
              <a href={`${base}/cms`}>{t(locale, 'bld.tab.cms')}</a>
            </span>
          </div>
        ))
      ) : (
        <>
          <ul className="bwd-cards">
            {tables.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  aria-pressed={selected === x.id}
                  onClick={() => setSelected(x.id)}
                >
                  <Icon name={x.kind === 'form' ? 'mail' : 'grid'} size={18} />
                  <span className="bwd-card-name">
                    <bdi dir="auto">{x.name}</bdi>
                    <small>{t(locale, `bld.dx.kind.${x.kind}` as 'bld.dx.kind.form')}</small>
                  </span>
                  <span className="bwd-card-count">
                    {t(locale, x.kind === 'form' ? 'bld.dx.rows' : 'bld.dx.items', {
                      n: x.count,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <div className="bwd-table">
              <div className="bwd-table-head">
                <strong>
                  <bdi dir="auto">{current.name}</bdi>
                </strong>
                <a href={`${base}/${current.kind === 'form' ? 'forms' : 'cms'}`}>
                  {t(locale, 'bld.dx.manage')}
                </a>
              </div>
              {current.masked && <p className="nz-muted">{t(locale, 'bld.dx.masked')}</p>}
              {current.rows.length === 0 ? (
                <p className="nz-muted">{t(locale, 'bld.dx.noRows')}</p>
              ) : (
                <div className="bwd-scroll">
                  <table>
                    <thead>
                      <tr>
                        {current.columns.map((c) => (
                          <th key={c} scope="col">
                            {c === 'createdAt'
                              ? t(locale, 'bld.dx.col.date')
                              : c === 'state'
                                ? t(locale, 'bld.dx.col.state')
                                : c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {current.rows.map((r, i) => (
                        <tr key={i}>
                          {current.columns.map((c) => (
                            <td key={c}>
                              <bdi dir="auto">{cell(r[c])}</bdi>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The Data view: what the site has collected or stores, as tables (form submissions such as leads, and content collections), the images it uses, and the
 * history of its versions. Read-only here; each table links to its full screen for creating forms and collections. Values come from the API as text and are
 * shown as text only (masked values stay masked: the API decides who sees what).
 */
export function DataPane({
  locale,
  projectId,
  model,
  siteLocale,
}: {
  locale: Locale;
  projectId: string;
  model: SiteModel;
  siteLocale: SiteLocale;
}) {
  const call = useBuilderCall();
  const [tab, setTab] = useState<'tables' | 'files' | 'history'>('tables');
  const [versions, setVersions] = useState<Version[] | null>(null);
  const base = `/builder/projects/${projectId}`;

  useEffect(() => {
    if (tab !== 'history' || versions) return;
    void call.run(
      () =>
        bapi.get<Page_<Version>>(`/v1/builder/projects/${projectId}/versions`, {
          query: { limit: 50 },
        }),
      (p) => setVersions(p.items),
    );
  }, [tab, versions, projectId]);

  const assets = model.assets ?? [];
  const TABS = ['tables', 'files', 'history'] as const;

  return (
    <div className="bwd">
      <div className="bwd-tabs" role="tablist" aria-label={t(locale, 'bld.ws.data')}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(locale, `bld.dx.tab.${id}` as 'bld.dx.tab.tables')}
          </button>
        ))}
      </div>

      {tab === 'tables' && (
        <section className="bwd-body" aria-label={t(locale, 'bld.dx.tab.tables')}>
          <h2>{t(locale, 'bld.dx.tables.title')}</h2>
          <p className="nz-muted">{t(locale, 'bld.dx.tables.help')}</p>
          <RecordsPane locale={locale} projectId={projectId} />
        </section>
      )}

      {tab === 'files' && (
        <section className="bwd-body" aria-label={t(locale, 'bld.dx.tab.files')}>
          <h2>{t(locale, 'bld.dx.files.title')}</h2>
          <p className="nz-muted">{t(locale, 'bld.dx.files.help')}</p>
          {assets.length === 0 ? (
            <p className="nz-muted">{t(locale, 'bld.dx.files.empty')}</p>
          ) : (
            <ul className="bwd-assets">
              {assets.map((a) => (
                <li key={a.id}>
                  <span className="bwd-asset-ph" aria-hidden="true">
                    <Icon name="grid" size={22} />
                  </span>
                  <span>
                    <bdi dir="auto">{a.alt[siteLocale] || a.label || a.id}</bdi>
                    <small dir="ltr">
                      {t(
                        locale,
                        a.source === 'upload' ? 'bld.dx.files.upload' : 'bld.dx.files.placeholder',
                      )}
                      {a.width && a.height ? ` · ${a.width}×${a.height}` : ''}
                      {a.mime ? ` · ${a.mime}` : ''}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="bwd-body" aria-label={t(locale, 'bld.dx.tab.history')}>
          <h2>{t(locale, 'bld.dx.history.title')}</h2>
          <p className="nz-muted">{t(locale, 'bld.dx.history.help')}</p>
          {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
          {versions === null && !call.problem ? (
            <p role="status" aria-busy="true" className="nz-muted">
              {t(locale, 'state.loading')}
            </p>
          ) : (
            <ol className="bwd-history">
              {(versions ?? []).map((v) => (
                <li key={v.id} data-current={v.isHead ? 'true' : undefined}>
                  <span className="bwd-v">{t(locale, 'bld.ws.version', { seq: v.seq })}</span>
                  <span>
                    {v.label ? <bdi dir="auto">{v.label} · </bdi> : null}
                    <small>{when(v.createdAt, locale)}</small>
                  </span>
                  {v.isHead && (
                    <span className="bws-chip">{t(locale, 'bld.dx.history.current')}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
          <a href={`${base}/versions`}>{t(locale, 'bld.dx.history.manage')}</a>
        </section>
      )}
    </div>
  );
}
