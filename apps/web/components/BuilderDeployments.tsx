'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, Select, Table } from '@nuzm/ui';
import {
  DEPLOY_ENVIRONMENTS,
  canRollback,
  isDeployActive,
  isPreviewUrl,
  type BuilderProblem,
  type DeployLog,
  type Deployment,
  type HostingSiteRef,
  type Page_,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { DeployBadge, ProblemNote, when } from './BuilderBits';
import { ConfirmDialog } from './DataUi';

interface Pending {
  approvalId: string;
  siteId: string;
  environment: string;
  costNote?: string;
  newPlan: boolean;
}

/** One deployment: state, URL, smoke results and the append-only log; both are re-read every 3 s while it is in flight. */
function DeploymentDetail({
  locale,
  d,
  siteName,
  onChanged,
}: {
  locale: Locale;
  d: Deployment;
  siteName: string;
  onChanged: (d: Deployment) => void;
}) {
  const [logs, setLogs] = useState<DeployLog[]>([]);
  const active = isDeployActive(d.state);
  const seq = useRef(0);
  useEffect(() => {
    seq.current = 0;
    setLogs([]);
  }, [d.id]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const l = await bapi.get<{ items: DeployLog[] }>(`/v1/deployments/${d.id}/logs`, {
        query: { after: seq.current },
      });
      if (!stop && l.response.ok && l.data && l.data.items.length > 0) {
        seq.current = Math.max(seq.current, ...l.data.items.map((x) => x.seq));
        setLogs((cur) => [...cur, ...l.data!.items]);
      }
      if (active) {
        const r = await bapi.get<Deployment>(`/v1/deployments/${d.id}`);
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
  }, [d.id, d.state, active]);

  const smoke = d.smoke;
  return (
    <section className="nz-card" aria-labelledby="bld-dep-h">
      <h3 className="nz-h2" id="bld-dep-h">
        {t(locale, 'bld.dep.detail', { site: siteName })}
      </h3>
      <p role="status" aria-live="polite" className="nz-row">
        <DeployBadge locale={locale} state={d.state} />
        <Badge>{tDynamic(locale, `bld.dep.env.${d.environment}`, d.environment)}</Badge>
        {d.rollbackOf && <Badge tone="warn">{t(locale, 'bld.dep.isRollback')}</Badge>}
      </p>
      <dl>
        <dt>{t(locale, 'bld.dep.url')}</dt>
        <dd>
          {d.url && isPreviewUrl(`${d.url}/`) ? (
            <a href={d.url} rel="noopener noreferrer" target="_blank">
              <Ltr>{d.url}</Ltr>
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>{t(locale, 'bld.dep.artifact')}</dt>
        <dd>{d.artifactHash ? <Ltr>{d.artifactHash.slice(0, 12)}</Ltr> : '—'}</dd>
        <dt>{t(locale, 'bld.dep.started')}</dt>
        <dd>{when(d.createdAt, locale)}</dd>
        <dt>{t(locale, 'bld.dep.finished')}</dt>
        <dd>{when(d.finishedAt, locale)}</dd>
      </dl>
      {(d as { simulated?: boolean }).simulated === true && (
        <Banner tone="warn">
          <strong>{t(locale, 'dep.simulated.title')}</strong> {t(locale, 'dep.simulated.body')}
        </Banner>
      )}
      {d.state === 'failed' && d.error?.code && (
        <Banner tone="danger">{t(locale, 'bld.dep.failed', { code: d.error.code })}</Banner>
      )}
      {d.state === 'rolled_back' && (
        <Banner tone="warn">{t(locale, 'bld.dep.rolledBackNote')}</Banner>
      )}
      <h4 className="nz-h2">{t(locale, 'bld.dep.smoke')}</h4>
      {smoke && smoke.results ? (
        <>
          <p>
            <Badge tone={smoke.ok ? 'success' : 'danger'}>
              {t(locale, smoke.ok ? 'bld.dep.smoke.ok' : 'bld.dep.smoke.failed')}
            </Badge>{' '}
            {smoke.phase && (
              <span className="nz-muted">
                {tDynamic(locale, `bld.dep.phase.${smoke.phase}`, smoke.phase)}
              </span>
            )}
            {smoke.tls !== null && smoke.tls !== undefined && (
              <> · {t(locale, smoke.tls ? 'bld.dep.tls.ok' : 'bld.dep.tls.no')}</>
            )}
          </p>
          <Table
            caption={t(locale, 'bld.dep.smoke')}
            rows={smoke.results}
            rowKey={(r) => r.path}
            columns={[
              {
                key: 'p',
                header: t(locale, 'bld.dep.smoke.path'),
                render: (r) => <Ltr>{r.path}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'bld.dep.smoke.status'),
                render: (r) => (
                  <Badge tone={r.status === 200 ? 'success' : 'danger'}>
                    <Ltr>{String(r.status)}</Ltr>
                  </Badge>
                ),
              },
            ]}
          />
        </>
      ) : (
        <p className="nz-muted">{t(locale, 'bld.dep.smoke.none')}</p>
      )}
      <h4 className="nz-h2">{t(locale, 'bld.dep.logs')}</h4>
      {logs.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bld.dep.logs.none')}</p>
      ) : (
        <pre className="bld-pre" tabIndex={0} aria-label={t(locale, 'bld.dep.logs')}>
          {logs.map((l) => `${l.at} ${l.level.toUpperCase()} ${l.message}`).join('\n')}
        </pre>
      )}
    </section>
  );
}

/**
 * UI-M09-08: publish a project to a hosting site, with the human approval in TWO steps. The first request asks for the approval (403 `approval_required`
 * with its id); a confirmation dialog shows what will be published and where, and only the explicit confirmation repeats the request with the approval id
 * and a NEW Idempotency-Key. Without a publish path (no hosting node: HG-05-01/02, HG-06-01) the API says `unsupported_capability` and the screen explains that.
 */
export function DeploymentsPanel({
  locale,
  projectId,
  projectName,
  headSeq,
  initial,
  sites,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  projectName: string;
  headSeq: number | null;
  initial: Deployment[];
  sites: HostingSiteRef[];
  canWrite: boolean;
}) {
  const call = useBuilderCall();
  const confirmCall = useBuilderCall();
  const rollbackCall = useBuilderCall();
  const cancelCall = useBuilderCall();
  const cancelKeys = useRef<Record<string, string>>({});
  const [items, setItems] = useState(initial);
  const [siteId, setSiteId] = useState(
    sites.find((s) => s.status === 'active')?.id ?? sites[0]?.id ?? '',
  );
  const [env, setEnv] = useState<string>('production');
  const [pending, setPending] = useState<Pending | null>(null);
  const [noPath, setNoPath] = useState(false);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const firstKey = useRef(newKey());
  const confirmKey = useRef<{ approvalId: string; key: string } | null>(null);
  const rollbackKeys = useRef<Record<string, string>>({});
  const siteName = (id?: string) => sites.find((s) => s.id === id)?.name ?? '—';
  const site = sites.find((s) => s.id === siteId);

  // the list is re-read every 3 s while a deployment is in flight
  const anyActive = items.some((d) => isDeployActive(d.state));
  useEffect(() => {
    if (!anyActive) return;
    const h = setInterval(() => {
      void bapi
        .get<Page_<Deployment>>('/v1/deployments', { query: { projectId, limit: 20 } })
        .then((r) => {
          if (r.response.ok && r.data) setItems(r.data.items);
        });
    }, 3000);
    return () => clearInterval(h);
  }, [anyActive, projectId]);

  const upsert = (d: Deployment) =>
    setItems((l) =>
      l.some((x) => x.id === d.id) ? l.map((x) => (x.id === d.id ? d : x)) : [d, ...l],
    );

  function requestApproval(e: FormEvent) {
    e.preventDefault();
    if (!siteId) return;
    setNoPath(false);
    void call.run(
      () =>
        bapi.post<Deployment>('/v1/deployments', {
          body: { projectId, target: siteId, environment: env },
          idempotencyKey: firstKey.current,
        }),
      (d) => {
        // a site that needed no approval step (not expected): treat the answer as the deployment itself
        upsert(d);
        setSelected(d.id);
        firstKey.current = newKey();
      },
      (p: BuilderProblem) => {
        firstKey.current = newKey();
        if (p.code === 'approval_required' && p.approvalId) {
          setPending({
            approvalId: p.approvalId,
            siteId,
            environment: env,
            costNote: p.costDisclosure?.note,
            newPlan: p.costDisclosure?.newHostingPlan === true,
          });
          return true;
        }
        if (p.code === 'unsupported_capability') {
          setNoPath(true);
          return true;
        }
        return false;
      },
    );
  }
  function confirm() {
    if (!pending) return;
    const p = pending;
    if (confirmKey.current?.approvalId !== p.approvalId)
      confirmKey.current = { approvalId: p.approvalId, key: newKey() }; // a NEW key for the second step
    void confirmCall.run(
      () =>
        bapi.post<Deployment>('/v1/deployments', {
          body: {
            projectId,
            target: p.siteId,
            environment: p.environment,
            approvalId: p.approvalId,
          },
          idempotencyKey: confirmKey.current!.key,
        }),
      (d) => {
        setPending(null);
        confirmKey.current = null;
        upsert(d);
        setSelected(d.id);
      },
      (pr) => {
        if (pr.status !== 599) {
          confirmKey.current = null; // a definite refusal ends this approval
          if (pr.code === 'unsupported_capability') setNoPath(true);
        }
        if (pr.status !== 599) setPending(null);
        return pr.code === 'unsupported_capability';
      },
    );
  }
  function rollback(d: Deployment) {
    rollbackKeys.current[d.id] ??= newKey();
    void rollbackCall.run(
      () =>
        bapi.post<Deployment>(`/v1/deployments/${d.id}/rollback`, {
          idempotencyKey: rollbackKeys.current[d.id],
        }),
      (nd) => {
        delete rollbackKeys.current[d.id];
        upsert(nd);
        setSelected(nd.id);
      },
    );
  }

  /** Cancel a queued or running deployment (stops before the switch; the live site is never touched). The answer is the deployment as it is now. */
  function cancel(d: Deployment) {
    cancelKeys.current[d.id] ??= newKey();
    void cancelCall.run(
      () =>
        bapi.post<Deployment>(`/v1/deployments/${d.id}/cancel`, {
          idempotencyKey: cancelKeys.current[d.id],
        }),
      (nd) => {
        delete cancelKeys.current[d.id];
        upsert(nd);
      },
    );
  }

  const sel = items.find((d) => d.id === selected) ?? null;
  return (
    <>
      {noPath && (
        <div role="alert">
          <EmptyState
            title={t(locale, 'bld.dep.noPath.title')}
            body={t(locale, 'bld.dep.noPath.body')}
          />
        </div>
      )}
      {canWrite ? (
        <form onSubmit={requestApproval} className="nz-card" aria-label={t(locale, 'bld.dep.form')}>
          <h2 className="nz-h2">{t(locale, 'bld.dep.form')}</h2>
          {sites.length === 0 ? (
            <p>
              {t(locale, 'bld.dep.noSites')}{' '}
              <a href={`/hosting/sites`}>{t(locale, 'bld.dep.toHosting')}</a>
            </p>
          ) : (
            <>
              <Field id="bld-dep-site" label={t(locale, 'bld.dep.site')}>
                {(x) => (
                  <Select {...x} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.primaryDomain ? ` — ${s.primaryDomain}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="bld-dep-env" label={t(locale, 'bld.dep.environment')}>
                {(x) => (
                  <Select {...x} value={env} onChange={(e) => setEnv(e.target.value)}>
                    {DEPLOY_ENVIRONMENTS.map((v) => (
                      <option key={v} value={v}>
                        {tDynamic(locale, `bld.dep.env.${v}`, v)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="nz-muted">
                {t(locale, 'bld.dep.willPublish', { name: projectName, seq: headSeq ?? 0 })}{' '}
                <a href={`/hosting/sites/${siteId}/domains`}>
                  {t(locale, 'bld.dep.domainHint')}
                </a>
              </p>
              {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
              <Button
                type="submit"
                disabled={call.busy || !siteId || (site !== undefined && site.status !== 'active')}
              >
                {t(locale, 'bld.dep.publish')}
              </Button>
              {site && site.status !== 'active' && (
                <p className="nz-muted">{t(locale, 'bld.dep.siteNotActive')}</p>
              )}
            </>
          )}
        </form>
      ) : (
        <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={t(locale, 'bld.dep.confirm.title')}
        onClose={() => setPending(null)}
      >
        {pending && (
          <>
            <dl>
              <dt>{t(locale, 'bld.dep.confirm.project')}</dt>
              <dd>
                <bdi dir="auto">{projectName}</bdi> (
                {t(locale, 'bld.ws.version', { seq: headSeq ?? 0 })})
              </dd>
              <dt>{t(locale, 'bld.dep.site')}</dt>
              <dd>
                <bdi dir="auto">{siteName(pending.siteId)}</bdi>
              </dd>
              <dt>{t(locale, 'bld.dep.environment')}</dt>
              <dd>{tDynamic(locale, `bld.dep.env.${pending.environment}`, pending.environment)}</dd>
              <dt>{t(locale, 'bld.dep.confirm.cost')}</dt>
              <dd>
                {t(locale, pending.newPlan ? 'bld.dep.cost.newPlan' : 'bld.dep.cost.none')}
                {pending.costNote ? (
                  <span className="nz-muted">
                    {' '}
                    <bdi dir="ltr" lang="en">
                      {pending.costNote}
                    </bdi>
                  </span>
                ) : null}
              </dd>
            </dl>
            <p>{t(locale, 'bld.dep.confirm.body')}</p>
            {confirmCall.problem && <ProblemNote locale={locale} problem={confirmCall.problem} />}
            <div className="nz-row">
              <Button disabled={confirmCall.busy} onClick={confirm}>
                {t(locale, 'bld.dep.confirm.go')}
              </Button>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {t(locale, 'action.cancel')}
              </Button>
            </div>
          </>
        )}
      </ConfirmDialog>

      <h2 className="nz-h2">{t(locale, 'bld.dep.list')}</h2>
      {rollbackCall.problem && <ProblemNote locale={locale} problem={rollbackCall.problem} />}
      {cancelCall.problem && <ProblemNote locale={locale} problem={cancelCall.problem} />}
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'bld.dep.empty.title')}
          body={t(locale, 'bld.dep.empty.body')}
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
              render: (d) => <DeployBadge locale={locale} state={d.state} />,
            },
            {
              key: 'e',
              header: t(locale, 'bld.dep.environment'),
              render: (d) => tDynamic(locale, `bld.dep.env.${d.environment}`, d.environment),
            },
            {
              key: 't',
              header: t(locale, 'bld.dep.site'),
              render: (d) => <bdi dir="auto">{siteName(d.target.hostingSiteId)}</bdi>,
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
                  {canWrite && isDeployActive(d.state) && (
                    <Button
                      variant="secondary"
                      disabled={cancelCall.busy}
                      onClick={() => cancel(d)}
                    >
                      {t(locale, 'dep.cancel')}
                    </Button>
                  )}
                  {canWrite && canRollback(d) && (
                    <Button
                      variant="danger"
                      disabled={rollbackCall.busy}
                      onClick={() => rollback(d)}
                    >
                      {t(locale, 'bld.dep.rollback')}
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
      {sel && (
        <DeploymentDetail
          key={sel.id}
          locale={locale}
          d={sel}
          siteName={siteName(sel.target.hostingSiteId)}
          onChanged={upsert}
        />
      )}
    </>
  );
}
