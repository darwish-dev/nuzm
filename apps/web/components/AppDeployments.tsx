'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import {
  approvalsOf,
  builderError,
  healthOf,
  isUuid,
  problemOf,
  safeHref,
  safeText,
  type ApprovalRef,
} from '../lib/appbuilder';
import {
  DEPLOY_ENVS,
  appCanRollback,
  appDeployTone,
  deployBody,
  isAppDeployActive,
  type DeployEnv,
  type TargetKind,
} from '../lib/appworkspace';
import type { HostingSiteRef } from '../lib/builder';
import { bapi, newKey } from '../lib/builder-client';
import { when } from './BuilderBits';
import { ConfirmDialog } from './DataUi';

/** A web-app deployment as `deploy.app_deployments` returns it (M10 §6; fields read defensively). */
export interface AppDeployment {
  id: string;
  projectId: string;
  versionId: string;
  environment: string;
  state: string;
  target: { type?: string; id?: string; kind?: string };
  failureCode?: string | null;
  url?: string | null;
  artifactSha256?: string | null;
  healthCheck?: Record<string, unknown> | null;
  migrations?: { version: number; destructive: boolean }[];
  rollbackOf?: string | null;
  previousDeploymentId?: string | null;
  /** present when the API says the publish path is the local stand-in */
  simulated?: boolean;
  createdAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
}
interface LogRow {
  seq: number;
  level: string;
  message: string;
  at: string;
}
interface Needs {
  action: 'deploy' | 'rollback';
  approvals: ApprovalRef[];
  rollbackId?: string;
}

const OTHER = '__other';

/**
 * A deployment made through the local in-memory stand-in is SIMULATED: nothing reached a real hosting node (HG-05/HG-06). The stand-in's URLs end in `.invalid` (the
 * reserved, never-resolvable TLD), which is what this reads; an API `simulated` flag wins when present. A real, live-verified publisher answers `simulated: false`.
 */
export function isSimulatedDeployment(d: { url?: string | null; simulated?: boolean }): boolean {
  if (typeof d.simulated === 'boolean') return d.simulated;
  if (!d.url) return false;
  try {
    return new URL(d.url).hostname.toLowerCase().endsWith('.invalid');
  } catch {
    return false;
  }
}

/** The refusal of a deploy/rollback call as a plain sentence in the page language (by error code, never the service's own text). */
function Err({ locale, status, code }: { locale: Locale; status: number; code?: string }) {
  // a network failure (599, uncertain) reads as "offline"
  const m = builderError(locale, { status: status === 599 ? 0 : status, code, fieldErrors: [] });
  return (
    <p role="alert" className="nz-error-text">
      {m.text}
      {m.detail ? <bdi dir="auto"> — {m.detail}</bdi> : null}
    </p>
  );
}

function Detail({
  locale,
  d,
  onChanged,
}: {
  locale: Locale;
  d: AppDeployment;
  onChanged: (d: AppDeployment) => void;
}) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const active = isAppDeployActive(d.state);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const l = await bapi.get<{ items: LogRow[] }>(`/v1/deployments/${d.id}/logs`);
      if (!stop && l.response.ok && l.data) setLogs(l.data.items.slice(-200));
      if (active) {
        const r = await bapi.get<AppDeployment>(`/v1/deployments/${d.id}`);
        if (!stop && r.response.ok && r.data && r.data.state !== d.state) onChanged(r.data);
      }
    };
    void tick();
    if (!active) return () => void (stop = true);
    const h = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [d.id, d.state]);
  const health = healthOf(d.healthCheck);
  const url = safeHref(d.url);
  const failure = d.failureCode ? safeText(d.failureCode, 60) : '';
  return (
    <section className="nz-card" aria-labelledby="m10a-dep-h">
      <h3 className="nz-h2" id="m10a-dep-h">
        {t(locale, 'm10a.dep.detail')}
      </h3>
      <p className="nz-row" role="status" aria-live="polite">
        <Badge tone={appDeployTone(d.state)}>
          {tDynamic(locale, `m10a.dep.state.${d.state}`, d.state)}
        </Badge>
        <Badge>{tDynamic(locale, `bld.dep.env.${d.environment}`, d.environment)}</Badge>
        {d.rollbackOf && <Badge tone="warn">{t(locale, 'bld.dep.isRollback')}</Badge>}
      </p>
      {isSimulatedDeployment(d) && (
        <Banner tone="warn">
          <strong>{t(locale, 'dep.simulated.title')}</strong> {t(locale, 'dep.simulated.body')}
        </Banner>
      )}
      {d.state === 'failed' && (
        <Banner tone="danger">{t(locale, 'bld.dep.failed', { code: failure || '—' })}</Banner>
      )}
      {d.state === 'rolled_back' && (
        <Banner tone="warn">{t(locale, 'bld.dep.rolledBackNote')}</Banner>
      )}
      <dl>
        <dt>{t(locale, 'bld.dep.url')}</dt>
        <dd>
          {url ? (
            <a href={url} rel="noopener noreferrer" target="_blank">
              <Ltr>{url}</Ltr>
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>{t(locale, 'm10a.dep.target')}</dt>
        <dd>
          <Ltr>
            {`${d.target?.type ?? d.target?.kind ?? ''} ${(d.target?.id ?? '').slice(0, 8)}`.trim() ||
              '—'}
          </Ltr>
        </dd>
        <dt>{t(locale, 'bld.dep.artifact')}</dt>
        <dd>{d.artifactSha256 ? <Ltr>{d.artifactSha256.slice(0, 12)}</Ltr> : '—'}</dd>
        <dt>{t(locale, 'bld.dep.started')}</dt>
        <dd>{when(d.createdAt, locale)}</dd>
        <dt>{t(locale, 'bld.dep.finished')}</dt>
        <dd>{when(d.finishedAt, locale)}</dd>
      </dl>

      <h4 className="nz-h3">{t(locale, 'm10a.dep.health')}</h4>
      {health ? (
        <>
          <p>
            <Badge tone={health.autoRolledBack ? 'danger' : 'success'}>
              {t(locale, health.autoRolledBack ? 'm10a.dep.healthFailed' : 'm10a.dep.healthOk')}
            </Badge>{' '}
            {health.attempts !== null && (
              <span className="nz-muted">
                {t(locale, 'm10a.dep.healthAttempts', { count: health.attempts })}
              </span>
            )}
          </p>
          {health.autoRolledBack && (
            <Banner tone="warn">{t(locale, 'm10a.dep.autoRolledBack')}</Banner>
          )}
          {health.checkedUrl && (
            <p className="nz-muted">
              <Ltr>{health.checkedUrl}</Ltr>
            </p>
          )}
        </>
      ) : (
        <p className="nz-muted">
          {t(locale, active ? 'm10a.dep.healthPending' : 'm10a.dep.healthNone')}
        </p>
      )}

      {d.migrations && d.migrations.length > 0 && (
        <>
          <h4 className="nz-h3">{t(locale, 'm10a.dep.migrations')}</h4>
          <ul className="bld-list">
            {d.migrations.map((m) => (
              <li key={m.version}>
                <Ltr>{String(m.version).padStart(4, '0')}</Ltr>{' '}
                {m.destructive && <Badge tone="danger">{t(locale, 'm10a.dep.destructive')}</Badge>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="nz-h3">{t(locale, 'bld.dep.logs')}</h4>
      {logs.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bld.dep.logs.none')}</p>
      ) : (
        <pre className="bld-pre" dir="ltr" tabIndex={0} aria-label={t(locale, 'bld.dep.logs')}>
          {logs
            .map(
              (l) => `${l.at.slice(11, 19)} ${l.level.toUpperCase()} ${safeText(l.message, 400)}`,
            )
            .join('\n')}
        </pre>
      )}
    </section>
  );
}

/**
 * UI-M10-09 (web apps): deploy a version to a hosting site / compute instance, with the human approvals a production deploy, destructive migration or paid
 * resource needs (the first request answers 403 `approval_required` with the approvals; they are decided in the inbox, then the same request is repeated),
 * the health-gate result, and rollback behind a confirmation. Targets are never invented: only the organization's hosting sites, or an id the person types.
 */
export function AppDeployments({
  locale,
  projectId,
  versionId,
  headSeq,
  initial,
  sites,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  versionId: string | null;
  headSeq: number | null;
  initial: AppDeployment[];
  sites: HostingSiteRef[];
  canWrite: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [target, setTarget] = useState(
    sites.find((s) => s.status === 'active')?.id ?? sites[0]?.id ?? OTHER,
  );
  const [otherKind, setOtherKind] = useState<TargetKind>('site');
  const [otherId, setOtherId] = useState('');
  const [env, setEnv] = useState<DeployEnv>('staging');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ status: number; code?: string } | null>(null);
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [confirmRb, setConfirmRb] = useState<AppDeployment | null>(null);
  const [idErr, setIdErr] = useState(false);
  const keys = useRef<Record<string, string>>({});

  const anyActive = items.some((d) => isAppDeployActive(d.state));
  useEffect(() => {
    if (!anyActive) return;
    const h = setInterval(() => {
      void bapi
        .get<{ items: AppDeployment[] }>('/v1/deployments', { query: { projectId, limit: 20 } })
        .then((r) => {
          if (r.response.ok && r.data) setItems(r.data.items);
        });
    }, 3000);
    return () => clearInterval(h);
  }, [anyActive, projectId]);

  const upsert = (d: AppDeployment) =>
    setItems((l) =>
      l.some((x) => x.id === d.id) ? l.map((x) => (x.id === d.id ? d : x)) : [d, ...l],
    );
  /** A release that finished may have superseded an earlier one (or been rolled back): read the list again so no row shows a stale "live". */
  const refreshList = () =>
    void bapi
      .get<{ items: AppDeployment[] }>('/v1/deployments', { query: { projectId, limit: 20 } })
      .then((r) => {
        if (r.response.ok && r.data) setItems(r.data.items);
      });
  const changed = (d: AppDeployment) => {
    upsert(d);
    if (!isAppDeployActive(d.state)) refreshList();
  };
  const siteName = (id?: string) => sites.find((s) => s.id === id)?.name;

  async function call(action: 'deploy' | 'rollback', rollbackId?: string) {
    setBusy(true);
    setFail(null);
    // a retry of the SAME action keeps its key (an uncertain network failure never starts a second deployment); a new attempt after approvals takes a new one
    const kid = action === 'deploy' ? `deploy:${target}:${env}:${versionId}` : `rb:${rollbackId}`;
    keys.current[kid] ??= newKey();
    const r =
      action === 'deploy'
        ? await bapi.post<AppDeployment>('/v1/deployments', {
            body: deployBody({
              projectId,
              versionId,
              kind: target === OTHER ? otherKind : 'site',
              targetId: target === OTHER ? otherId.trim() : target,
              env,
            }),
            idempotencyKey: keys.current[kid],
          })
        : await bapi.post<AppDeployment>(`/v1/deployments/${rollbackId}/rollback`, {
            idempotencyKey: keys.current[kid],
          });
    setBusy(false);
    if (r.response.ok && r.data) {
      delete keys.current[kid];
      setNeeds(null);
      upsert(r.data);
      setSelected(r.data.id);
      if (action === 'rollback') {
        // the rolled-back deployment changed state too: read the list again so no row shows a stale "live"
        const l = await bapi.get<{ items: AppDeployment[] }>('/v1/deployments', {
          query: { projectId, limit: 20 },
        });
        if (l.response.ok && l.data) setItems(l.data.items);
      }
      return;
    }
    const p = problemOf(r);
    if (p.status !== 599 && p.status !== 0) delete keys.current[kid];
    const approvals = approvalsOf(r.error);
    if (p.code === 'approval_required' && approvals.length > 0) {
      setNeeds({ action, approvals, rollbackId });
      return;
    }
    if (p.code === 'health_gate_failed') {
      // the release was rolled back by the gate: show the list as it is now
      const l = await bapi.get<{ items: AppDeployment[] }>('/v1/deployments', {
        query: { projectId, limit: 20 },
      });
      if (l.response.ok && l.data) setItems(l.data.items);
    }
    setFail({ status: p.status, code: p.code });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (target === OTHER && !isUuid(otherId)) {
      setIdErr(true);
      return;
    }
    setIdErr(false);
    setNeeds(null);
    void call('deploy');
  }

  const sel = items.find((d) => d.id === selected) ?? null;
  const noTarget = sites.length === 0;

  return (
    <>
      {canWrite ? (
        <form className="nz-card" aria-labelledby="m10a-dep-new" onSubmit={submit} noValidate>
          <h2 className="nz-h2" id="m10a-dep-new">
            {t(locale, 'm10a.dep.new')}
          </h2>
          <p className="nz-muted">
            {headSeq !== null
              ? t(locale, 'm10a.dep.version', { seq: headSeq })
              : t(locale, 'm10a.dep.noVersion')}
          </p>
          {noTarget && <Banner tone="warn">{t(locale, 'm10a.dep.noSites')}</Banner>}
          <Field id="m10a-dep-target" label={t(locale, 'm10a.dep.target')}>
            {(x) => (
              <Select {...x} value={target} onChange={(e) => setTarget(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status !== 'active' ? ` (${s.status})` : ''}
                  </option>
                ))}
                <option value={OTHER}>{t(locale, 'm10a.dep.otherTarget')}</option>
              </Select>
            )}
          </Field>
          {target === OTHER && (
            <>
              <Field id="m10a-dep-kind" label={t(locale, 'm10a.dep.kind')}>
                {(x) => (
                  <Select
                    {...x}
                    value={otherKind}
                    onChange={(e) => setOtherKind(e.target.value as TargetKind)}
                  >
                    <option value="site">{t(locale, 'm10a.dep.kind.site')}</option>
                    <option value="instance">{t(locale, 'm10a.dep.kind.instance')}</option>
                  </Select>
                )}
              </Field>
              <Field
                id="m10a-dep-id"
                label={t(locale, 'm10a.dep.targetId')}
                error={idErr ? t(locale, 'm10a.dep.targetIdErr') : undefined}
              >
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    value={otherId}
                    onChange={(e) => {
                      setOtherId(e.target.value);
                      setIdErr(false);
                    }}
                  />
                )}
              </Field>
            </>
          )}
          <Field id="m10a-dep-env" label={t(locale, 'bld.dep.environment')}>
            {(x) => (
              <Select {...x} value={env} onChange={(e) => setEnv(e.target.value as DeployEnv)}>
                {DEPLOY_ENVS.map((v) => (
                  <option key={v} value={v}>
                    {tDynamic(locale, `bld.dep.env.${v}`, v)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {env === 'production' && (
            <p className="nz-muted">{t(locale, 'm10a.dep.productionNote')}</p>
          )}
          {fail && !needs && <Err locale={locale} {...fail} />}
          <Button type="submit" disabled={busy || !versionId} aria-busy={busy}>
            {busy ? t(locale, 'state.loading') : t(locale, 'm10a.dep.create')}
          </Button>
        </form>
      ) : (
        <p className="nz-muted">{t(locale, 'm10a.dep.noPermission')}</p>
      )}

      {needs && (
        <section className="nz-card" aria-labelledby="m10a-dep-needs" role="alert">
          <h3 className="nz-h2" id="m10a-dep-needs">
            {t(locale, 'm10a.dep.approvalNeeded')}
          </h3>
          <p>{t(locale, 'm10a.dep.approvalBody')}</p>
          <ul className="bld-list">
            {needs.approvals.map((a) => (
              <li key={a.id}>
                <Badge tone="warn">{tDynamic(locale, `m10.apr.type.${a.type}`, a.type)}</Badge>{' '}
                <span className="nz-muted">
                  <Ltr>{a.scopeHash.slice(0, 12)}</Ltr>
                </span>
              </li>
            ))}
          </ul>
          <div className="nz-row">
            <a className="nz-btn" data-variant="primary" href={`/${locale}/approvals`}>
              {t(locale, 'm10a.dep.openApprovals')}
            </a>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void call(needs.action, needs.rollbackId)}
            >
              {t(locale, 'm10a.dep.retryAfter')}
            </Button>
          </div>
        </section>
      )}

      <h2 className="nz-h2">{t(locale, 'bld.dep.list')}</h2>
      {fail && needs && <Err locale={locale} {...fail} />}
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'm10a.dep.empty.title')}
          body={t(locale, 'm10a.dep.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'bld.dep.list')}
          rows={items}
          rowKey={(d) => d.id}
          columns={[
            {
              key: 's',
              header: t(locale, 'bld.dep.col.state'),
              render: (d) => (
                <Badge tone={appDeployTone(d.state)}>
                  {tDynamic(locale, `m10a.dep.state.${d.state}`, d.state)}
                </Badge>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'bld.dep.environment'),
              render: (d) => tDynamic(locale, `bld.dep.env.${d.environment}`, d.environment),
            },
            {
              key: 't',
              header: t(locale, 'm10a.dep.target'),
              render: (d) => (
                <bdi dir="auto">{siteName(d.target?.id) ?? (d.target?.id ?? '—').slice(0, 8)}</bdi>
              ),
            },
            {
              key: 'c',
              header: t(locale, 'bld.dep.started'),
              render: (d) => when(d.createdAt, locale),
            },
            {
              key: 'a',
              header: t(locale, 'bld.dep.col.actions'),
              render: (d) => (
                <span className="nz-row">
                  <Button
                    variant="secondary"
                    aria-pressed={selected === d.id}
                    onClick={() => setSelected(d.id)}
                  >
                    {t(locale, 'bld.dep.details')}
                  </Button>
                  {canWrite && appCanRollback(d) && (
                    <Button variant="danger" disabled={busy} onClick={() => setConfirmRb(d)}>
                      {t(locale, 'bld.dep.rollback')}
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
      {sel && <Detail key={sel.id} locale={locale} d={sel} onChanged={changed} />}

      <ConfirmDialog
        open={confirmRb !== null}
        title={t(locale, 'm10a.dep.rollbackTitle')}
        onClose={() => setConfirmRb(null)}
      >
        {confirmRb && (
          <>
            <p>
              {t(locale, 'm10a.dep.rollbackBody', {
                env: tDynamic(
                  locale,
                  `bld.dep.env.${confirmRb.environment}`,
                  confirmRb.environment,
                ),
              })}
            </p>
            {confirmRb.environment === 'production' && (
              <p className="nz-muted">{t(locale, 'm10a.dep.rollbackApproval')}</p>
            )}
            <p className="nz-muted">{t(locale, 'm10a.dep.rollbackData')}</p>
            <div className="nz-row">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const id = confirmRb.id;
                  setConfirmRb(null);
                  void call('rollback', id);
                }}
              >
                {t(locale, 'm10a.dep.rollbackConfirm')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmRb(null)}>
                {t(locale, 'action.cancel')}
              </Button>
            </div>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
