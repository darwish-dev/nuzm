'use client';
import { useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Icon, type IconName } from '@nuzm/ui';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import {
  STRENGTHS,
  addRule,
  addSection,
  removeRule,
  setRule,
  type ClaudeCodeStatus,
  type GithubConnection,
  type GithubStatus,
  type Instructions,
  type InstructionSection,
  type SearchResult,
  type SkillRecommendation,
  type StudioView,
} from '../lib/ai-studio';
import { ProblemNote } from './BuilderBits';
import { Gate } from './PanelLoad';
import type { AppCan } from './WebAppPanels';
import { gone, useApi } from './WebAppLoad';

const VIEWS: { id: StudioView; icon: IconName; label: MessageKey }[] = [
  { id: 'instructions', icon: 'list', label: 'ais.view.instructions' },
  { id: 'skills', icon: 'sparkle', label: 'ais.view.skills' },
  { id: 'github', icon: 'code', label: 'ais.view.github' },
  { id: 'files', icon: 'search', label: 'ais.view.files' },
  { id: 'claude', icon: 'desktop', label: 'ais.view.claude' },
];

/**
 * AI Studio (ADR-064) inside the web-app workspace: the project's instructions (`CLAUDE.md`), its Skills, its GitHub repository, a search over its files and the
 * Claude Code proof of concept. Every action goes through the API, which keeps the safe-diff checks, the audit and the tenant isolation; this panel decides nothing.
 */
export function AppStudioPanel({
  locale,
  projectId,
  can,
  refresh,
  onOpenFile,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  refresh: number;
  onOpenFile: (path: string) => void;
  /** a change wrote project files (sync, install, pull): the other panels read again */
  onChanged: () => void;
}) {
  const [view, setView] = useState<StudioView>('instructions');
  return (
    <div className="wsp-pane" data-pane="studio">
      <h2 className="nz-sr">{t(locale, 'ais.title')}</h2>
      <div className="wsp-subbar" role="tablist" aria-label={t(locale, 'ais.title')}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
          >
            <Icon name={v.icon} size={15} />
            {t(locale, v.label)}
          </button>
        ))}
      </div>
      <div className="wsp-scroll ais-body">
        {view === 'instructions' ? (
          <InstructionsView
            locale={locale}
            projectId={projectId}
            can={can}
            refresh={refresh}
            onChanged={onChanged}
          />
        ) : view === 'skills' ? (
          <SkillsView
            locale={locale}
            projectId={projectId}
            can={can}
            refresh={refresh}
            onChanged={onChanged}
          />
        ) : view === 'github' ? (
          <GithubView
            locale={locale}
            projectId={projectId}
            can={can}
            refresh={refresh}
            onChanged={onChanged}
          />
        ) : view === 'files' ? (
          <SearchView locale={locale} projectId={projectId} onOpenFile={onOpenFile} />
        ) : (
          <ClaudeView locale={locale} projectId={projectId} can={can} refresh={refresh} />
        )}
      </div>
    </div>
  );
}

const Card = ({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) => (
  <section className="ais-card">
    <header className="ais-card-h">
      <h3 className="nz-h2">{title}</h3>
      {aside}
    </header>
    {children}
  </section>
);

// ---- instructions ------------------------------------------------------------------------------------------------------------------
function InstructionsView({
  locale,
  projectId,
  can,
  refresh,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  refresh: number;
  onChanged: () => void;
}) {
  const [n, setN] = useState(0);
  const [load, retry] = useApi<Instructions>(
    `/v1/builder/projects/${projectId}/instructions`,
    undefined,
    refresh + n,
  );
  return (
    <Gate locale={locale} load={load} retry={retry} gone={gone(locale)}>
      {(d) => (
        <InstructionsEditor
          key={`${d.version}`}
          locale={locale}
          projectId={projectId}
          initial={d}
          canWrite={can.write}
          onSaved={() => setN((x) => x + 1)}
          onChanged={onChanged}
        />
      )}
    </Gate>
  );
}

function InstructionsEditor({
  locale,
  projectId,
  initial,
  canWrite,
  onSaved,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  initial: Instructions;
  canWrite: boolean;
  onSaved: () => void;
  onChanged: () => void;
}) {
  const [project, setProject] = useState<InstructionSection[]>(initial.projectLayer);
  const [customer, setCustomer] = useState<InstructionSection[]>(initial.customerLayer);
  const [block, setBlock] = useState(initial.customerBlock);
  const [showMd, setShowMd] = useState(false);
  const [note, setNote] = useState<MessageKey | null>(null);
  const call = useBuilderCall();
  const base = `/v1/builder/projects/${projectId}/instructions`;
  const dirty =
    JSON.stringify(project) !== JSON.stringify(initial.projectLayer) ||
    JSON.stringify(customer) !== JSON.stringify(initial.customerLayer) ||
    block !== initial.customerBlock;
  const save = () =>
    call.run(
      () =>
        bapi.put<Instructions>(base, {
          body: { projectLayer: project, customerLayer: customer, customerBlock: block },
          ifMatch: `"${initial.version}"`,
        }),
      () => {
        setNote('ais.ins.saved');
        onSaved();
      },
    );
  const sync = () =>
    call.run(
      () => bapi.post<{ changed: boolean }>(`${base}/sync`, { body: {}, idempotencyKey: newKey() }),
      (r) => {
        setNote(r.changed ? 'ais.ins.synced' : 'ais.ins.inSync');
        if (r.changed) onChanged();
      },
    );
  return (
    <div className="ais-stack">
      <Card
        title={t(locale, 'ais.ins.title')}
        aside={
          <span className="nz-muted">
            {t(locale, 'ais.ins.version', { version: String(initial.version) })}
          </span>
        }
      >
        <p className="nz-muted">{t(locale, 'ais.ins.help')}</p>
        {initial.conflicts.length > 0 && (
          <Banner tone="warn">
            {t(locale, 'ais.ins.conflicts', { n: String(initial.conflicts.length) })}
          </Banner>
        )}
        <details className="ais-baseline">
          <summary>{t(locale, 'ais.ins.baseline')}</summary>
          {initial.baseline.map((l, i) =>
            l.sections.map((s) => (
              <div key={`${i}-${s.id}`}>
                <strong>
                  <bdi dir="auto">{s.title}</bdi>
                </strong>
                <ul>
                  {s.rules.map((r, j) => (
                    <li key={j}>
                      <Badge
                        tone={
                          r.strength === 'never'
                            ? 'danger'
                            : r.strength === 'must'
                              ? 'warn'
                              : undefined
                        }
                      >
                        {r.strength}
                      </Badge>{' '}
                      <bdi dir="auto">{r.text}</bdi>
                    </li>
                  ))}
                </ul>
              </div>
            )),
          )}
        </details>
      </Card>
      <LayerEditor
        locale={locale}
        title={t(locale, 'ais.ins.project')}
        value={project}
        onChange={setProject}
        disabled={!canWrite}
        prefix="p"
      />
      <LayerEditor
        locale={locale}
        title={t(locale, 'ais.ins.customer')}
        value={customer}
        onChange={setCustomer}
        disabled={!canWrite}
        prefix="c"
      />
      <Card title={t(locale, 'ais.ins.block')}>
        <label className="nz-sr" htmlFor="ais-block">
          {t(locale, 'ais.ins.block')}
        </label>
        <textarea
          id="ais-block"
          className="nz-input ais-textarea"
          dir="auto"
          rows={5}
          maxLength={20000}
          value={block}
          disabled={!canWrite}
          onChange={(e) => setBlock(e.target.value)}
        />
      </Card>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {note && !call.problem && (
        <p role="status" className="nz-muted">
          {t(locale, note)}
        </p>
      )}
      <div className="nz-row ais-actions">
        {canWrite && (
          <button
            type="button"
            className="nz-btn"
            data-variant="primary"
            disabled={!dirty || call.busy}
            onClick={() => void save()}
          >
            {t(locale, 'ais.ins.save')}
          </button>
        )}
        {canWrite && initial.canSync && (
          <button
            type="button"
            className="nz-btn"
            data-variant="secondary"
            disabled={dirty || call.busy}
            onClick={() => void sync()}
          >
            {t(locale, 'ais.ins.sync')}
          </button>
        )}
        <button
          type="button"
          className="nz-btn"
          data-variant="secondary"
          onClick={() => setShowMd((x) => !x)}
          aria-expanded={showMd}
        >
          {t(locale, showMd ? 'ais.ins.hidePreview' : 'ais.ins.preview')}
        </button>
      </div>
      {showMd && (
        <pre className="ais-md" dir="ltr">
          {initial.markdown}
        </pre>
      )}
      <InstructionHistory
        locale={locale}
        projectId={projectId}
        version={initial.version}
        canWrite={canWrite}
        onRestored={onSaved}
      />
    </div>
  );
}

function LayerEditor({
  locale,
  title,
  value,
  onChange,
  disabled,
  prefix,
}: {
  locale: Locale;
  title: string;
  value: InstructionSection[];
  onChange: (v: InstructionSection[]) => void;
  disabled: boolean;
  prefix: string;
}) {
  return (
    <Card
      title={title}
      aside={
        !disabled && (
          <button
            type="button"
            className="nz-btn"
            data-variant="secondary"
            onClick={() => onChange(addSection(value, t(locale, 'ais.ins.newSection')))}
          >
            {t(locale, 'ais.ins.addSection')}
          </button>
        )
      }
    >
      {value.length === 0 && <p className="nz-muted">{t(locale, 'ais.ins.emptyLayer')}</p>}
      {value.map((s, si) => (
        <fieldset key={s.id} className="ais-section" disabled={disabled}>
          <legend className="nz-sr">{s.title}</legend>
          <label className="nz-sr" htmlFor={`${prefix}-${si}-title`}>
            {t(locale, 'ais.ins.sectionTitle')}
          </label>
          <input
            id={`${prefix}-${si}-title`}
            className="nz-input ais-section-title"
            dir="auto"
            maxLength={80}
            value={s.title}
            onChange={(e) =>
              onChange(value.map((x, i) => (i === si ? { ...x, title: e.target.value } : x)))
            }
          />
          {s.rules.map((r, ri) => (
            <div key={ri} className="ais-rule">
              <label className="nz-sr" htmlFor={`${prefix}-${si}-${ri}-s`}>
                {t(locale, 'ais.ins.strength')}
              </label>
              <select
                id={`${prefix}-${si}-${ri}-s`}
                className="nz-input"
                value={r.strength}
                onChange={(e) =>
                  onChange(
                    setRule(value, si, ri, {
                      strength: e.target.value as (typeof STRENGTHS)[number],
                    }),
                  )
                }
              >
                {STRENGTHS.map((x) => (
                  <option key={x} value={x}>
                    {t(locale, `ais.strength.${x}` as MessageKey)}
                  </option>
                ))}
              </select>
              <label className="nz-sr" htmlFor={`${prefix}-${si}-${ri}-t`}>
                {t(locale, 'ais.ins.rule')}
              </label>
              <input
                id={`${prefix}-${si}-${ri}-t`}
                className="nz-input"
                dir="auto"
                value={r.text}
                onChange={(e) => onChange(setRule(value, si, ri, { text: e.target.value }))}
              />
              <button
                type="button"
                className="nz-btn"
                data-variant="secondary"
                aria-label={t(locale, 'ais.ins.removeRule')}
                onClick={() => onChange(removeRule(value, si, ri))}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <div className="nz-row">
            <button
              type="button"
              className="nz-btn"
              data-variant="secondary"
              onClick={() => onChange(addRule(value, si))}
            >
              {t(locale, 'ais.ins.addRule')}
            </button>
            <button
              type="button"
              className="nz-btn"
              data-variant="danger"
              onClick={() => onChange(value.filter((_, i) => i !== si))}
            >
              {t(locale, 'ais.ins.removeSection')}
            </button>
          </div>
        </fieldset>
      ))}
    </Card>
  );
}

function InstructionHistory({
  locale,
  projectId,
  version,
  canWrite,
  onRestored,
}: {
  locale: Locale;
  projectId: string;
  version: number;
  canWrite: boolean;
  onRestored: () => void;
}) {
  const [load, retry] = useApi<{ items: { version: number; createdAt: string }[] }>(
    `/v1/builder/projects/${projectId}/instructions/versions`,
    undefined,
    version,
  );
  const call = useBuilderCall();
  return (
    <Card title={t(locale, 'ais.ins.history')}>
      <Gate locale={locale} load={load} retry={retry} gone={gone(locale)}>
        {(h) =>
          h.items.length === 0 ? (
            <p className="nz-muted">{t(locale, 'ais.ins.noHistory')}</p>
          ) : (
            <ul className="ais-list">
              {h.items.map((v) => (
                <li key={v.version}>
                  <span>
                    <strong>v{v.version}</strong>{' '}
                    <span className="nz-muted">
                      <time dateTime={v.createdAt}>
                        {new Date(v.createdAt).toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-GB')}
                      </time>
                    </span>
                  </span>
                  {canWrite && v.version !== version && (
                    <button
                      type="button"
                      className="nz-btn"
                      data-variant="secondary"
                      disabled={call.busy}
                      onClick={() =>
                        void call.run(
                          () =>
                            bapi.post(
                              `/v1/builder/projects/${projectId}/instructions/versions/${v.version}/restore`,
                              { body: {} },
                            ),
                          onRestored,
                        )
                      }
                    >
                      {t(locale, 'ais.ins.restore')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Gate>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
    </Card>
  );
}

// ---- skills ------------------------------------------------------------------------------------------------------------------------
function SkillsView({
  locale,
  projectId,
  can,
  refresh,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  refresh: number;
  onChanged: () => void;
}) {
  const [n, setN] = useState(0);
  const [installed, retryI] = useApi<{
    items: { skillId: string; slug: string; version: string; reason: string }[];
  }>(`/v1/builder/projects/${projectId}/skills`, undefined, refresh + n);
  const [rec, retryR] = useApi<SkillRecommendation>(
    `/v1/builder/projects/${projectId}/skills/recommendations`,
    undefined,
    refresh + n,
  );
  const call = useBuilderCall();
  const [overwrite, setOverwrite] = useState<null | (() => void)>(null);
  const done = () => {
    setOverwrite(null);
    setN((x) => x + 1);
    onChanged();
  };
  const install = (body: Record<string, unknown>) =>
    call.run(
      () =>
        bapi.post(`/v1/builder/projects/${projectId}/skills`, { body, idempotencyKey: newKey() }),
      done,
      (p) => {
        if (p.status === 409 && p.issues.some((i) => i.path === 'path')) {
          setOverwrite(() => () => void install({ ...body, overwrite: true }));
          return true;
        }
      },
    );
  const remove = (skillId: string, force = false) =>
    call.run(
      () =>
        bapi.del(`/v1/builder/projects/${projectId}/skills/${skillId}`, {
          query: force ? { overwrite: 'true' } : {},
        }),
      done,
      (p) => {
        if (p.status === 409) {
          setOverwrite(() => () => void remove(skillId, true));
          return true;
        }
      },
    );
  return (
    <div className="ais-stack">
      {overwrite && (
        <div role="alertdialog" aria-labelledby="ais-ow" className="ais-confirm">
          <p id="ais-ow">{t(locale, 'ais.sk.overwrite')}</p>
          <div className="nz-row">
            <button type="button" className="nz-btn" data-variant="danger" onClick={overwrite}>
              {t(locale, 'ais.sk.overwriteYes')}
            </button>
            <button
              type="button"
              className="nz-btn"
              data-variant="secondary"
              onClick={() => setOverwrite(null)}
            >
              {t(locale, 'ais.cancel')}
            </button>
          </div>
        </div>
      )}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <Card title={t(locale, 'ais.sk.installed')}>
        <Gate locale={locale} load={installed} retry={retryI} gone={gone(locale)}>
          {(l) =>
            l.items.length === 0 ? (
              <EmptyState
                title={t(locale, 'ais.sk.none.title')}
                body={t(locale, 'ais.sk.none.body')}
              />
            ) : (
              <ul className="ais-list">
                {l.items.map((s) => (
                  <li key={s.skillId}>
                    <span>
                      <Icon name="sparkle" size={15} /> <bdi dir="ltr">{s.slug}</bdi>{' '}
                      <span className="nz-muted">{s.version}</span>{' '}
                      <Badge>{t(locale, `ais.sk.reason.${s.reason}` as MessageKey)}</Badge>
                    </span>
                    {can.write && (
                      <button
                        type="button"
                        className="nz-btn"
                        data-variant="secondary"
                        disabled={call.busy}
                        onClick={() => void remove(s.skillId)}
                      >
                        {t(locale, 'ais.sk.remove')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Gate>
      </Card>
      <Card
        title={t(locale, 'ais.sk.recommended')}
        aside={
          can.write && (
            <button
              type="button"
              className="nz-btn"
              data-variant="primary"
              disabled={call.busy}
              onClick={() => void install({ auto: true })}
            >
              {t(locale, 'ais.sk.installAll')}
            </button>
          )
        }
      >
        <p className="nz-muted">{t(locale, 'ais.sk.help')}</p>
        <Gate locale={locale} load={rec} retry={retryR} gone={gone(locale)}>
          {(r) => (
            <>
              <ul className="ais-list">
                {r.install
                  .filter((s) => !r.installed.includes(s))
                  .map((s) => (
                    <li key={s}>
                      <span>
                        <bdi dir="ltr">{s}</bdi>{' '}
                        <span className="nz-muted">{r.reasons[s] ?? ''}</span>
                      </span>
                      {can.write && (
                        <button
                          type="button"
                          className="nz-btn"
                          data-variant="secondary"
                          disabled={call.busy}
                          onClick={() => void install({ skills: [s] })}
                        >
                          {t(locale, 'ais.sk.install')}
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
              {r.install.every((s) => r.installed.includes(s)) && (
                <p className="nz-muted">{t(locale, 'ais.sk.allInstalled')}</p>
              )}
              {r.blocked.length > 0 && (
                <details>
                  <summary>{t(locale, 'ais.sk.blocked', { n: String(r.blocked.length) })}</summary>
                  <ul className="ais-list">
                    {r.blocked.map((b) => (
                      <li key={b.slug}>
                        <bdi dir="ltr">{b.slug}</bdi> <span className="nz-muted">{b.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </Gate>
      </Card>
    </div>
  );
}

// ---- GitHub ------------------------------------------------------------------------------------------------------------------------
function GithubView({
  locale,
  projectId,
  can,
  refresh,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  refresh: number;
  onChanged: () => void;
}) {
  const [n, setN] = useState(0);
  const [conn, retryC] = useApi<GithubConnection>('/v1/builder/github', undefined, refresh + n);
  const bump = () => setN((x) => x + 1);
  return (
    <Gate locale={locale} load={conn} retry={retryC} gone={gone(locale)}>
      {(c) =>
        !c.available ? (
          <EmptyState
            title={t(locale, 'ais.gh.unavailable.title')}
            body={t(locale, 'ais.gh.unavailable.body')}
          />
        ) : !c.connection ? (
          <Card title={t(locale, 'ais.gh.connect.title')}>
            <p className="nz-muted">{t(locale, 'ais.gh.connect.body')}</p>
            {c.adapter === 'fake' && <Banner tone="warn">{t(locale, 'ais.gh.fake')}</Banner>}
            {can.write && c.installUrl && (
              <a
                className="nz-btn"
                data-variant="primary"
                href={c.installUrl}
                rel="noopener noreferrer"
              >
                {t(locale, 'ais.gh.connect')}
              </a>
            )}
          </Card>
        ) : (
          <ProjectGithub
            locale={locale}
            projectId={projectId}
            can={can}
            conn={c}
            n={n}
            onChange={bump}
            onChanged={onChanged}
          />
        )
      }
    </Gate>
  );
}

function ProjectGithub({
  locale,
  projectId,
  can,
  conn,
  n,
  onChange,
  onChanged,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  conn: GithubConnection;
  n: number;
  onChange: () => void;
  onChanged: () => void;
}) {
  const base = `/v1/builder/projects/${projectId}/github`;
  const [st, retryS] = useApi<GithubStatus>(base, undefined, n);
  const [repos] = useApi<{ items: { fullName: string; private: boolean }[] }>(
    '/v1/builder/github/repositories',
    undefined,
    n,
  );
  const [pick, setPick] = useState('');
  const [branch, setBranch] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const call = useBuilderCall();
  const act = (fn: () => ReturnType<typeof bapi.post>, ok: (d: Record<string, unknown>) => void) =>
    call.run(
      fn as () => Promise<Awaited<ReturnType<typeof bapi.post<Record<string, unknown>>>>>,
      (d) => {
        ok(d);
        onChange();
      },
    );
  return (
    <div className="ais-stack">
      <Card
        title={t(locale, 'ais.gh.connected')}
        aside={
          can.write && (
            <button
              type="button"
              className="nz-btn"
              data-variant="secondary"
              disabled={call.busy}
              onClick={() =>
                void act(
                  () => bapi.del('/v1/builder/github'),
                  () => undefined,
                )
              }
            >
              {t(locale, 'ais.gh.disconnect')}
            </button>
          )
        }
      >
        <p>
          <Icon name="organization" size={15} />{' '}
          <bdi dir="ltr">{conn.connection!.accountLogin}</bdi>{' '}
          <Badge tone={conn.connection!.state === 'active' ? 'success' : 'warn'}>
            {conn.connection!.state}
          </Badge>
        </p>
        {conn.adapter === 'fake' && <Banner tone="warn">{t(locale, 'ais.gh.fake')}</Banner>}
      </Card>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {msg && !call.problem && (
        <p role="status" className="nz-muted">
          {msg}
        </p>
      )}
      <Gate locale={locale} load={st} retry={retryS} gone={gone(locale)}>
        {(s) =>
          !s.linked ? (
            <Card title={t(locale, 'ais.gh.link.title')}>
              {repos.state === 'ready' && repos.data.items.length === 0 ? (
                <p className="nz-muted">{t(locale, 'ais.gh.noRepos')}</p>
              ) : (
                <div className="nz-row">
                  <label className="nz-sr" htmlFor="ais-repo">
                    {t(locale, 'ais.gh.repo')}
                  </label>
                  <select
                    id="ais-repo"
                    className="nz-input"
                    value={pick}
                    onChange={(e) => setPick(e.target.value)}
                    disabled={!can.write}
                  >
                    <option value="">{t(locale, 'ais.gh.pickRepo')}</option>
                    {repos.state === 'ready' &&
                      repos.data.items.map((r) => (
                        <option key={r.fullName} value={r.fullName}>
                          {r.fullName}
                        </option>
                      ))}
                  </select>
                  {can.write && (
                    <button
                      type="button"
                      className="nz-btn"
                      data-variant="primary"
                      disabled={!pick || call.busy}
                      onClick={() =>
                        void act(
                          () => bapi.post(`${base}/link`, { body: { fullName: pick } }),
                          () => undefined,
                        )
                      }
                    >
                      {t(locale, 'ais.gh.link')}
                    </button>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <Card
              title={s.linked.fullName}
              aside={
                <Badge tone={s.linked.private ? undefined : 'warn'}>
                  {t(locale, s.linked.private ? 'ais.gh.private' : 'ais.gh.public')}
                </Badge>
              }
            >
              <dl className="ais-dl">
                <dt>{t(locale, 'ais.gh.branch')}</dt>
                <dd>
                  <bdi dir="ltr">{s.linked.defaultBranch}</bdi>
                </dd>
                <dt>{t(locale, 'ais.gh.lastSync')}</dt>
                <dd>
                  <bdi dir="ltr">{s.linked.lastSyncedSha?.slice(0, 7) ?? '—'}</bdi>
                </dd>
                <dt>{t(locale, 'ais.gh.state')}</dt>
                <dd>
                  {s.localChanged && <Badge tone="warn">{t(locale, 'ais.gh.localChanged')}</Badge>}{' '}
                  {s.remoteChanged && (
                    <Badge tone="warn">{t(locale, 'ais.gh.remoteChanged')}</Badge>
                  )}
                  {!s.localChanged && !s.remoteChanged && (
                    <Badge tone="success">{t(locale, 'ais.gh.inSync')}</Badge>
                  )}
                </dd>
              </dl>
              {can.write && (
                <>
                  <div className="nz-row ais-actions">
                    <button
                      type="button"
                      className="nz-btn"
                      data-variant="secondary"
                      disabled={call.busy}
                      onClick={() =>
                        void call.run(
                          () =>
                            bapi.post<{ files: number }>(`${base}/pull`, {
                              body: confirmReplace ? { replace: true } : {},
                              idempotencyKey: newKey(),
                            }),
                          (d) => {
                            setConfirmReplace(false);
                            setMsg(t(locale, 'ais.gh.pulled', { n: String(d.files) }));
                            onChange();
                            onChanged();
                          },
                          (p) => {
                            if (p.status === 409 && s.localChanged) {
                              setConfirmReplace(true);
                              return true;
                            }
                          },
                        )
                      }
                    >
                      {t(locale, confirmReplace ? 'ais.gh.pullReplace' : 'ais.gh.pull')}
                    </button>
                    <label className="nz-sr" htmlFor="ais-branch">
                      {t(locale, 'ais.gh.branch')}
                    </label>
                    <input
                      id="ais-branch"
                      className="nz-input"
                      dir="ltr"
                      placeholder="nuzm/my-change"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                    <button
                      type="button"
                      className="nz-btn"
                      data-variant="primary"
                      disabled={call.busy || !s.linked.lastSyncedSha}
                      onClick={() =>
                        void call.run(
                          () =>
                            bapi.post<{ branch: string; changed: number }>(`${base}/push`, {
                              body: branch ? { branch } : {},
                              idempotencyKey: newKey(),
                            }),
                          (d) => {
                            setBranch(d.branch);
                            setMsg(t(locale, 'ais.gh.pushed', { branch: d.branch }));
                            onChange();
                          },
                        )
                      }
                    >
                      {t(locale, 'ais.gh.push')}
                    </button>
                    {branch && branch !== s.linked.defaultBranch && (
                      <button
                        type="button"
                        className="nz-btn"
                        data-variant="secondary"
                        disabled={call.busy}
                        onClick={() =>
                          void call.run(
                            () =>
                              bapi.post<{ url: string }>(`${base}/pulls`, {
                                body: { head: branch },
                                idempotencyKey: newKey(),
                              }),
                            (d) => {
                              setMsg(t(locale, 'ais.gh.prOpened', { url: d.url }));
                              onChange();
                            },
                          )
                        }
                      >
                        {t(locale, 'ais.gh.openPr')}
                      </button>
                    )}
                  </div>
                  {confirmReplace && <Banner tone="warn">{t(locale, 'ais.gh.replaceWarn')}</Banner>}
                  {!s.linked.lastSyncedSha && (
                    <p className="nz-muted">{t(locale, 'ais.gh.pullFirst')}</p>
                  )}
                </>
              )}
              <PullRequests locale={locale} base={base} n={n} />
              {can.write && (
                <button
                  type="button"
                  className="nz-btn"
                  data-variant="secondary"
                  disabled={call.busy}
                  onClick={() =>
                    void act(
                      () => bapi.del(`${base}/link`),
                      () => undefined,
                    )
                  }
                >
                  {t(locale, 'ais.gh.unlink')}
                </button>
              )}
            </Card>
          )
        }
      </Gate>
    </div>
  );
}

function PullRequests({ locale, base, n }: { locale: Locale; base: string; n: number }) {
  const [prs] = useApi<{ items: { number: number; title: string; url: string; head: string }[] }>(
    `${base}/pulls`,
    undefined,
    n,
  );
  if (prs.state !== 'ready' || prs.data.items.length === 0) return null;
  return (
    <>
      <h4 className="nz-h2">{t(locale, 'ais.gh.prs')}</h4>
      <ul className="ais-list">
        {prs.data.items.map((p) => (
          <li key={p.number}>
            <a href={p.url} target="_blank" rel="noopener noreferrer">
              #{p.number} <bdi dir="auto">{p.title}</bdi>
            </a>
            <span className="nz-muted">
              <bdi dir="ltr">{p.head}</bdi>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- file search -------------------------------------------------------------------------------------------------------------------
function SearchView({
  locale,
  projectId,
  onOpenFile,
}: {
  locale: Locale;
  projectId: string;
  onOpenFile: (path: string) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const call = useBuilderCall();
  return (
    <div className="ais-stack">
      <Card title={t(locale, 'ais.fs.title')}>
        <p className="nz-muted">{t(locale, 'ais.fs.help')}</p>
        <form
          className="nz-row"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void call.run(
              () =>
                bapi.get<SearchResult>(`/v1/builder/projects/${projectId}/files/search`, {
                  query: { q },
                }),
              setRes,
            );
          }}
        >
          <label className="nz-sr" htmlFor="ais-q">
            {t(locale, 'ais.fs.query')}
          </label>
          <input
            id="ais-q"
            className="nz-input"
            dir="auto"
            maxLength={200}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t(locale, 'ais.fs.query')}
          />
          <button
            type="submit"
            className="nz-btn"
            data-variant="primary"
            disabled={q.trim().length < 2 || call.busy}
          >
            <Icon name="search" size={15} /> {t(locale, 'ais.fs.search')}
          </button>
        </form>
      </Card>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {res &&
        (res.paths.length === 0 && res.matches.length === 0 ? (
          <EmptyState title={t(locale, 'ais.fs.none.title')} body={t(locale, 'ais.fs.none.body')} />
        ) : (
          <Card
            title={t(locale, 'ais.fs.results', {
              n: String(res.matches.length + res.paths.length),
            })}
          >
            <ul className="ais-list">
              {res.paths.map((p) => (
                <li key={`p:${p}`}>
                  <button type="button" className="ais-link" onClick={() => onOpenFile(p)}>
                    <Icon name="code" size={14} /> <bdi dir="ltr">{p}</bdi>
                  </button>
                </li>
              ))}
              {res.matches.map((m, i) => (
                <li key={`m:${m.path}:${m.line}:${i}`}>
                  <button type="button" className="ais-link" onClick={() => onOpenFile(m.path)}>
                    <bdi dir="ltr">
                      {m.path}:{m.line}
                    </bdi>
                  </button>
                  <code dir="ltr" className="ais-preview">
                    {m.preview}
                  </code>
                </li>
              ))}
            </ul>
            {res.truncated && <p className="nz-muted">{t(locale, 'ais.fs.truncated')}</p>}
          </Card>
        ))}
    </div>
  );
}

// ---- Claude Code (proof of concept) -------------------------------------------------------------------------------------------------
function ClaudeView({
  locale,
  projectId,
  can,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  refresh: number;
}) {
  const [n, setN] = useState(0);
  const base = `/v1/builder/projects/${projectId}/claude-code`;
  const [st, retry] = useApi<ClaudeCodeStatus>(base, undefined, refresh + n);
  const [boxes] = useApi<{ items: { id: string; state: string }[] }>(
    `/v1/builder/projects/${projectId}/sandboxes`,
    undefined,
    refresh + n,
    can.sandbox,
  );
  const [sid, setSid] = useState('');
  const call = useBuilderCall();
  return (
    <Gate locale={locale} load={st} retry={retry} gone={gone(locale)}>
      {(s) => (
        <div className="ais-stack">
          <Card
            title={t(locale, 'ais.cc.title')}
            aside={<Badge tone="warn">{t(locale, 'ais.cc.poc')}</Badge>}
          >
            <p className="nz-muted">{t(locale, 'ais.cc.help')}</p>
            <ul className="ais-facts">
              <li>
                <Icon name="lock" size={14} /> {t(locale, 'ais.cc.noCredentials')}
              </li>
              <li>
                <Icon name="wallet" size={14} /> {t(locale, 'ais.cc.noFallback')}
              </li>
            </ul>
            {!s.available && (
              <Banner tone="warn">
                {t(
                  locale,
                  s.reason === 'compliance_pending' ? 'ais.cc.compliance' : 'ais.cc.flagOff',
                )}
              </Banner>
            )}
          </Card>
          {s.available && (
            <Card title={t(locale, 'ais.cc.session')}>
              {s.session && (
                <p>
                  <Badge
                    tone={
                      s.session.state === 'ERROR'
                        ? 'danger'
                        : s.session.state === 'STOPPED'
                          ? undefined
                          : 'warn'
                    }
                  >
                    {t(locale, `ais.cc.state.${s.session.state}` as MessageKey)}
                  </Badge>{' '}
                  {s.session.binaryVersion && <bdi dir="ltr">{s.session.binaryVersion}</bdi>}
                </p>
              )}
              {s.session?.state === 'AUTHENTICATION_REQUIRED' && (
                <p className="nz-muted">{t(locale, 'ais.cc.signInNote')}</p>
              )}
              {can.sandbox ? (
                <div className="nz-row">
                  <label className="nz-sr" htmlFor="ais-sbx">
                    {t(locale, 'ais.cc.sandbox')}
                  </label>
                  <select
                    id="ais-sbx"
                    className="nz-input"
                    value={sid}
                    onChange={(e) => setSid(e.target.value)}
                  >
                    <option value="">{t(locale, 'ais.cc.pickSandbox')}</option>
                    {boxes.state === 'ready' &&
                      boxes.data.items
                        .filter((b) => b.state === 'ready')
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.id.slice(0, 8)}
                          </option>
                        ))}
                  </select>
                  <button
                    type="button"
                    className="nz-btn"
                    data-variant="primary"
                    disabled={!sid || call.busy}
                    onClick={() =>
                      void call.run(
                        () => bapi.post(`${base}/sessions`, { body: { sandboxId: sid } }),
                        () => setN((x) => x + 1),
                      )
                    }
                  >
                    {t(locale, 'ais.cc.start')}
                  </button>
                  {s.session && s.session.state !== 'STOPPED' && (
                    <button
                      type="button"
                      className="nz-btn"
                      data-variant="secondary"
                      disabled={call.busy}
                      onClick={() =>
                        void call.run(
                          () => bapi.del(`${base}/sessions`),
                          () => setN((x) => x + 1),
                        )
                      }
                    >
                      {t(locale, 'ais.cc.stop')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="nz-muted">{t(locale, 'state.forbidden.title')}</p>
              )}
              {boxes.state === 'ready' && !boxes.data.items.some((b) => b.state === 'ready') && (
                <p className="nz-muted">{t(locale, 'ais.cc.noSandbox')}</p>
              )}
              {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
            </Card>
          )}
        </div>
      )}
    </Gate>
  );
}
