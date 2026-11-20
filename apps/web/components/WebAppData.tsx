'use client';
import { useEffect, useMemo, useState } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Icon, Ltr } from '@nuzm/ui';
import { pick, type ApiView, type EndpointView, type RoleView } from '../lib/appworkspace';
import type { Built } from '../lib/appworkspace-server';
import type { ProjectFile } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import {
  constraintText,
  looksDestructive,
  migrationFiles,
  parseTables,
  tableModels,
  type ColumnModel,
  type TableModel,
} from '../lib/webapp-data';
import { ApiDeps, AccessPanel, METHOD_TONE, NoBuildYet } from './AppBlueprint';
import { CodeLines } from './BuilderCode';
import { RecordsPane } from './BuilderData';
import { Gate } from './PanelLoad';
import { gone, useBuilt } from './WebAppLoad';

export type DataView = 'tables' | 'migrations' | 'api' | 'access' | 'records';
const VIEWS: { id: DataView; icon: 'grid' | 'code' | 'cloud' | 'lock' | 'data' }[] = [
  { id: 'tables', icon: 'grid' },
  { id: 'migrations', icon: 'code' },
  { id: 'api', icon: 'cloud' },
  { id: 'access', icon: 'lock' },
  { id: 'records', icon: 'data' },
];

/** One generated migration: its apply and reverse SQL, from the project's `db/migrations` files (or, with none, from the build's `db_schema` artifact). */
export interface MigrationRow {
  version: number;
  name: string;
  up: string | null;
  down: string | null;
  upPath: string;
  downPath: string;
  /** read from the project's files (and so openable in Code) */
  file: boolean;
  destructive: string[];
}
const pad = (v: number) => String(v).padStart(4, '0');

/**
 * The migrations of the head version: the `db/migrations/NNNN_name.sql` files (apply) and `.down.sql` files (reverse) the build wrote, read through the files API;
 * the destructive statements come from the build's `db_schema` artifact (the generator flags them), or from a plain scan when only the files are known. With no
 * migration files the artifact's own migrations are shown instead. Nothing here is executed.
 */
function useMigrations(projectId: string, versionId: string | null, built: Built, refresh: number) {
  const [rows, setRows] = useState<MigrationRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const schema = built.schema;
  useEffect(() => {
    let stop = false;
    setRows(null);
    setFailed(false);
    const fromArtifact = (): MigrationRow[] =>
      (schema?.migrations ?? []).map((m) => ({
        version: m.version,
        name: m.name,
        up: m.up,
        down: m.down,
        upPath: `db/migrations/${pad(m.version)}_${m.name}.sql`,
        downPath: `db/migrations/${pad(m.version)}_${m.name}.down.sql`,
        file: false,
        destructive: m.destructive,
      }));
    void (async () => {
      if (!versionId) return setRows(fromArtifact());
      const list = await bapi.get<{ items: ProjectFile[] }>(
        `/v1/builder/projects/${projectId}/files`,
        { query: { versionId } },
      );
      if (stop) return;
      if (!list.response.ok || !list.data) {
        setFailed(true);
        return setRows(fromArtifact());
      }
      const files = migrationFiles(list.data.items.map((f) => f.path)).slice(0, 30);
      if (files.length === 0) return setRows(fromArtifact());
      const read = async (path: string | null): Promise<string | null> => {
        if (!path) return null;
        const r = await bapi.get<{ content: string; encoding: string }>(
          `/v1/builder/projects/${projectId}/files/content`,
          { query: { path, versionId } },
        );
        return r.response.ok && r.data && r.data.encoding === 'utf8' ? r.data.content : null;
      };
      const out = await Promise.all(
        files.map(async (f): Promise<MigrationRow> => {
          const [up, down] = await Promise.all([read(f.upPath), read(f.downPath)]);
          const flagged = schema?.migrations.find((m) => m.version === f.version)?.destructive;
          return {
            version: f.version,
            name: f.name,
            up,
            down,
            upPath: f.upPath ?? `db/migrations/${pad(f.version)}_${f.name}.sql`,
            downPath: f.downPath ?? `db/migrations/${pad(f.version)}_${f.name}.down.sql`,
            file: true,
            destructive: flagged ?? (up && looksDestructive(up) ? ['DROP / DELETE'] : []),
          };
        }),
      );
      if (!stop) setRows(out);
    })();
    return () => {
      stop = true;
    };
  }, [projectId, versionId, refresh, schema]);
  return { rows, failed };
}

/**
 * The Data panel of the web-app studio, the counterpart of the website studio's Data view: the generated database as tables (columns, keys, relations, who may do
 * what, which endpoints serve each one), the generated migrations with a SQL viewer for apply and reverse, the REST endpoints per entity, the role matrix, and
 * the records the project's own forms and collections hold. It reads what the build produced (its spec, schema and API artifacts and the migration files); the
 * platform has no API to browse the rows of the generated app's own database, and the view says so instead of inventing one.
 */
export function AppDataPane({
  locale,
  projectId,
  headVersionId,
  refresh,
  focus = null,
  onOpenFile,
}: {
  locale: Locale;
  projectId: string;
  headVersionId: string | null;
  refresh: number;
  /** a link from the chat: the view and (for tables) the table to show */
  focus?: { view?: DataView; table?: string; n: number } | null;
  onOpenFile?: (path: string) => void;
}) {
  const [view, setView] = useState<DataView>(focus?.view ?? 'tables');
  const [table, setTable] = useState<string | null>(focus?.table ?? null);
  const [built, retry] = useBuilt(projectId, refresh);
  useEffect(() => {
    if (!focus) return;
    if (focus.view) setView(focus.view);
    if (focus.table) setTable(focus.table);
  }, [focus?.n]);
  return (
    <div className="wsp-pane" data-pane="data">
      <h2 className="nz-sr">{t(locale, 'm10a.design.title')}</h2>
      <div className="wsp-subbar" role="tablist" aria-label={t(locale, 'm10a.design.title')}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
          >
            <Icon name={v.icon} size={15} />
            {t(locale, `wsp.data.view.${v.id}` as 'wsp.data.view.tables')}
          </button>
        ))}
      </div>
      <div className="wsp-scroll">
        {view === 'records' ? (
          <section className="wsp-sec" aria-label={t(locale, 'wsp.data.view.records')}>
            <p className="nz-muted">{t(locale, 'wsp.data.records.help')}</p>
            <RecordsPane
              locale={locale}
              projectId={projectId}
              empty={
                <EmptyState
                  title={t(locale, 'wsp.data.records.empty.title')}
                  body={t(locale, 'wsp.data.records.empty.body')}
                />
              }
            />
          </section>
        ) : (
          <Gate locale={locale} load={built} retry={retry} gone={gone(locale)}>
            {(b) =>
              b ? (
                <DataViews
                  locale={locale}
                  projectId={projectId}
                  headVersionId={headVersionId}
                  refresh={refresh}
                  built={b}
                  view={view}
                  table={table}
                  onTable={setTable}
                  onView={setView}
                  onOpenFile={onOpenFile}
                />
              ) : (
                <NoBuildYet locale={locale} />
              )
            }
          </Gate>
        )}
      </div>
    </div>
  );
}

function DataViews({
  locale,
  projectId,
  headVersionId,
  refresh,
  built,
  view,
  table,
  onTable,
  onView,
  onOpenFile,
}: {
  locale: Locale;
  projectId: string;
  headVersionId: string | null;
  refresh: number;
  built: Built;
  view: DataView;
  table: string | null;
  onTable: (name: string) => void;
  onView: (v: DataView) => void;
  onOpenFile?: (path: string) => void;
}) {
  const { rows, failed } = useMigrations(projectId, headVersionId, built, refresh);
  const roles: RoleView[] = useMemo(
    () => (built.api?.rbac.length ? built.api.rbac : (built.spec?.roles ?? [])),
    [built.api, built.spec],
  );
  const models = useMemo(
    () =>
      rows
        ? tableModels(
            parseTables(rows.map((r) => r.up).filter((x): x is string => x !== null)),
            built.spec,
            built.api?.endpoints ?? [],
            roles,
          )
        : null,
    [rows, built.spec, built.api, roles],
  );
  if (view === 'api')
    return (
      <ApiEndpointsView
        locale={locale}
        api={built.api}
        models={models ?? []}
        basePath={built.spec?.api.basePath ?? ''}
      />
    );
  if (view === 'access')
    return (
      <section className="wsp-sec" aria-label={t(locale, 'm10a.access.title')}>
        {roles.length > 0 ? (
          <AccessPanel
            locale={locale}
            roles={roles}
            entities={built.spec?.entities.map((e) => e.name) ?? []}
          />
        ) : (
          <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>
        )}
      </section>
    );
  if (rows === null || models === null)
    return (
      <p role="status" aria-busy="true" className="nz-muted">
        {t(locale, 'state.loading')}
      </p>
    );
  return (
    <>
      {failed && <Banner tone="warn">{t(locale, 'wsp.data.filesFailed')}</Banner>}
      {view === 'tables' ? (
        <TablesView
          locale={locale}
          models={models}
          selected={table}
          onSelect={onTable}
          onMigrations={() => onView('migrations')}
        />
      ) : (
        <MigrationsView locale={locale} rows={rows} onOpenFile={onOpenFile} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ tables */

function ColumnRules({ locale, c }: { locale: Locale; c: ColumnModel }) {
  return (
    <span className="wsp-rules">
      {constraintText(c).map((x) => (
        <Badge key={x} tone={x === 'PRIMARY KEY' ? 'success' : undefined}>
          <Ltr>{x}</Ltr>
        </Badge>
      ))}
      {c.references && (
        <Badge>
          <Ltr>{`→ ${c.references.table}.${c.references.column}`}</Ltr>
        </Badge>
      )}
      {c.pii && <Badge tone="warn">{t(locale, 'm10a.spec.pii')}</Badge>}
      {c.enumValues.length > 0 && (
        <span className="wsp-enum" dir="ltr">
          {c.enumValues.join(' | ')}
        </span>
      )}
    </span>
  );
}

function TablesView({
  locale,
  models,
  selected,
  onSelect,
  onMigrations,
}: {
  locale: Locale;
  models: TableModel[];
  selected: string | null;
  onSelect: (name: string) => void;
  onMigrations: () => void;
}) {
  if (models.length === 0)
    return (
      <EmptyState
        title={t(locale, 'wsp.data.tables.none.title')}
        body={t(locale, 'wsp.data.tables.none.body')}
      />
    );
  const cur = models.find((m) => m.name === selected) ?? models[0]!;
  const columns = models.reduce((n, m) => n + m.columns.length, 0);
  const relations = models.reduce((n, m) => n + m.outgoing.length, 0);
  return (
    <section className="wsp-sec" aria-label={t(locale, 'wsp.data.view.tables')}>
      <p className="wsp-summary" role="status">
        {t(locale, 'wsp.data.summary', { tables: models.length, columns, relations })}
        <button type="button" className="wsp-link" onClick={onMigrations}>
          {t(locale, 'wsp.data.seeMigrations')}
        </button>
      </p>
      <div className="wsp-split">
        <ul className="wsp-list" aria-label={t(locale, 'm10a.data.tables')}>
          {models.map((m) => (
            <li key={m.name}>
              <button
                type="button"
                aria-pressed={cur.name === m.name}
                onClick={() => onSelect(m.name)}
              >
                <Icon name="grid" size={16} />
                <span className="wsp-list-name">
                  <Ltr>{m.name}</Ltr>
                  {m.entity && (
                    <small>
                      <bdi dir="auto">{pick(m.entity.label, locale, m.entity.name)}</bdi>
                    </small>
                  )}
                </span>
                <span className="wsp-list-count">{m.columns.length}</span>
              </button>
            </li>
          ))}
        </ul>
        <article className="wsp-detail" aria-label={cur.name}>
          <header className="wsp-detail-head">
            <h3 className="nz-h2">
              <Ltr>{cur.name}</Ltr>
            </h3>
            {cur.entity && (
              <span className="wsp-badges">
                <Badge>
                  {tDynamic(locale, `m10a.own.${cur.entity.ownership}`, cur.entity.ownership)}
                </Badge>
                {cur.entity.audit && <Badge tone="success">{t(locale, 'm10a.spec.audited')}</Badge>}
              </span>
            )}
          </header>
          <div
            className="wsp-tablewrap"
            role="region"
            tabIndex={0}
            aria-label={t(locale, 'wsp.data.columns')}
          >
            <table className="wsp-table">
              <caption className="nz-sr">{t(locale, 'wsp.data.columns')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(locale, 'wsp.data.col.name')}</th>
                  <th scope="col">{t(locale, 'm10a.spec.type')}</th>
                  <th scope="col">{t(locale, 'm10a.spec.flags')}</th>
                </tr>
              </thead>
              <tbody>
                {cur.columns.map((c) => (
                  <tr key={c.name} data-system={c.field ? undefined : 'true'}>
                    <th scope="row">
                      <Ltr>{c.name}</Ltr>
                      {c.label && (
                        <small>
                          <bdi dir="auto">{pick(c.label, locale)}</bdi>
                        </small>
                      )}
                    </th>
                    <td>
                      <Ltr>{c.type}</Ltr>
                    </td>
                    <td>
                      <ColumnRules locale={locale} c={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wsp-grid2">
            <section aria-labelledby="wsp-rel-h">
              <h4 className="wsp-h4" id="wsp-rel-h">
                {t(locale, 'wsp.data.relations')}
              </h4>
              {cur.outgoing.length + cur.incoming.length === 0 ? (
                <p className="nz-muted">{t(locale, 'wsp.data.relations.none')}</p>
              ) : (
                <ul className="wsp-plain">
                  {cur.outgoing.map((o) => (
                    <li key={`o:${o.column}`}>
                      <Ltr>{o.column}</Ltr> →{' '}
                      <button type="button" className="wsp-link" onClick={() => onSelect(o.table)}>
                        <Ltr>{o.table}</Ltr>
                      </button>
                      {o.onDelete && (
                        <small className="nz-muted">
                          {' '}
                          · <Ltr>{`ON DELETE ${o.onDelete}`}</Ltr>
                        </small>
                      )}
                    </li>
                  ))}
                  {cur.incoming.map((i) => (
                    <li key={`i:${i.table}:${i.column}`}>
                      <button type="button" className="wsp-link" onClick={() => onSelect(i.table)}>
                        <Ltr>{`${i.table}.${i.column}`}</Ltr>
                      </button>{' '}
                      → {t(locale, 'wsp.data.relations.here')}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="wsp-acc-h">
              <h4 className="wsp-h4" id="wsp-acc-h">
                {t(locale, 'wsp.data.access')}
              </h4>
              {cur.access.length === 0 ? (
                <p className="nz-muted">{t(locale, 'wsp.data.access.none')}</p>
              ) : (
                <ul className="wsp-plain">
                  {cur.access.map((a) => (
                    <li key={a.role}>
                      <Ltr>{a.role}</Ltr>{' '}
                      <small className="nz-muted">
                        {tDynamic(locale, `m10a.scope.${a.scope}`, a.scope)}
                      </small>
                      <span className="wsp-badges">
                        {a.actions.map((x) => (
                          <Badge key={x}>{tDynamic(locale, `m10a.crud.${x}`, x)}</Badge>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <section aria-labelledby="wsp-ep-h">
            <h4 className="wsp-h4" id="wsp-ep-h">
              {t(locale, 'wsp.data.endpoints')}
            </h4>
            <Endpoints locale={locale} list={cur.endpoints} />
          </section>
          {cur.indexes.length > 0 && (
            <section aria-labelledby="wsp-idx-h">
              <h4 className="wsp-h4" id="wsp-idx-h">
                {t(locale, 'wsp.data.indexes')}
              </h4>
              <p className="wsp-chips" dir="ltr">
                {cur.indexes.map((x) => (
                  <code key={x}>{x}</code>
                ))}
              </p>
            </section>
          )}
        </article>
      </div>
    </section>
  );
}

function Endpoints({ locale, list }: { locale: Locale; list: EndpointView[] }) {
  if (list.length === 0) return <p className="nz-muted">{t(locale, 'wsp.data.endpoints.none')}</p>;
  return (
    <ul className="wsp-endpoints">
      {list.map((e) => (
        <li key={`${e.method} ${e.path}`}>
          <Badge tone={METHOD_TONE[e.method]}>
            <Ltr>{e.method}</Ltr>
          </Badge>
          <Ltr>{e.path}</Ltr>
          {e.summary && (
            <small className="nz-muted">
              <bdi dir="auto">{e.summary}</bdi>
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ migrations */

function MigrationsView({
  locale,
  rows,
  onOpenFile,
}: {
  locale: Locale;
  rows: MigrationRow[];
  onOpenFile?: (path: string) => void;
}) {
  const [version, setVersion] = useState<number | null>(null);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [copied, setCopied] = useState(false);
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'wsp.data.mig.none.title')}
        body={t(locale, 'wsp.data.mig.none.body')}
      />
    );
  const cur = rows.find((r) => r.version === version) ?? rows[0]!;
  const text = dir === 'up' ? cur.up : cur.down;
  const path = dir === 'up' ? cur.upPath : cur.downPath;
  const copy = () => {
    if (text === null) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const anyDestructive = rows.some((r) => r.destructive.length > 0);
  return (
    <section className="wsp-sec" aria-label={t(locale, 'm10a.data.migrations')}>
      {anyDestructive && <Banner tone="warn">{t(locale, 'm10a.data.destructiveNote')}</Banner>}
      <div className="wsp-split">
        <ol className="wsp-list" aria-label={t(locale, 'm10a.data.migrations')}>
          {rows.map((r) => (
            <li key={r.version}>
              <button
                type="button"
                aria-pressed={cur.version === r.version}
                onClick={() => setVersion(r.version)}
              >
                <Icon name="code" size={16} />
                <span className="wsp-list-name">
                  <Ltr>{`${pad(r.version)}_${r.name}`}</Ltr>
                  <small>
                    {t(locale, r.down === null ? 'wsp.data.mig.upOnly' : 'wsp.data.mig.upDown')}
                    {r.destructive.length > 0 && (
                      <>
                        {' · '}
                        <span className="wsp-danger">
                          {t(locale, 'm10a.data.destructive', { count: r.destructive.length })}
                        </span>
                      </>
                    )}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <article className="wsp-detail wsp-viewer" aria-label={`${pad(cur.version)}_${cur.name}`}>
          <header className="wsp-viewer-bar">
            <div className="wsp-seg" role="group" aria-label={t(locale, 'wsp.data.mig.direction')}>
              {(['up', 'down'] as const).map((d) => (
                <button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir(d)}>
                  {t(locale, d === 'up' ? 'm10a.data.up' : 'm10a.data.down')}
                </button>
              ))}
            </div>
            <span dir="ltr" className="bwc-path" title={path}>
              {path}
            </span>
            {cur.file && onOpenFile && (
              <button type="button" className="bwc-copy" onClick={() => onOpenFile(path)}>
                {t(locale, 'wsp.data.mig.openInCode')}
              </button>
            )}
            {text !== null && (
              <button type="button" className="bwc-copy bwc-copy-next" onClick={copy}>
                {t(locale, copied ? 'bld.cx.copied' : 'bld.cx.copy')}
              </button>
            )}
          </header>
          {cur.destructive.length > 0 && (
            <ul className="wsp-destructive" aria-label={t(locale, 'm10a.data.destructiveList')}>
              {cur.destructive.map((d, i) => (
                <li key={i}>
                  <Ltr>{d}</Ltr>
                </li>
              ))}
            </ul>
          )}
          {text === null ? (
            <p className="nz-muted bwc-pad">{t(locale, 'wsp.data.mig.missing')}</p>
          ) : (
            <CodeLines locale={locale} content={text} path={path} />
          )}
        </article>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ API */

function ApiEndpointsView({
  locale,
  api,
  models,
  basePath,
}: {
  locale: Locale;
  api: ApiView | null;
  models: TableModel[];
  basePath: string;
}) {
  if (!api) return <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>;
  const used = new Set(models.flatMap((m) => m.endpoints.map((e) => `${e.method} ${e.path}`)));
  const other = api.endpoints.filter((e) => !used.has(`${e.method} ${e.path}`));
  return (
    <section className="wsp-sec" aria-label={t(locale, 'm10a.api.title')}>
      <p className="wsp-summary" role="status">
        {t(locale, 'wsp.data.api.summary', { n: api.endpoints.length })}
        {basePath && (
          <>
            {' '}
            <Ltr>{basePath}</Ltr>
          </>
        )}
      </p>
      {api.endpoints.length === 0 && (
        <p className="nz-muted">{t(locale, 'm10a.api.noEndpoints')}</p>
      )}
      {models
        .filter((m) => m.endpoints.length > 0)
        .map((m) => (
          <section key={m.name} className="wsp-card" aria-label={m.name}>
            <h3 className="wsp-h4">
              <Ltr>{m.name}</Ltr>
              {m.entity && (
                <small className="nz-muted">
                  {' '}
                  · <bdi dir="auto">{pick(m.entity.label, locale, m.entity.name)}</bdi>
                </small>
              )}
            </h3>
            <Endpoints locale={locale} list={m.endpoints} />
          </section>
        ))}
      {other.length > 0 && (
        <section className="wsp-card" aria-label={t(locale, 'wsp.data.api.other')}>
          <h3 className="wsp-h4">{t(locale, 'wsp.data.api.other')}</h3>
          <Endpoints locale={locale} list={other} />
        </section>
      )}
      <ApiDeps locale={locale} api={api} />
    </section>
  );
}
