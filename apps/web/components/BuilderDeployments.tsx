'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  Select,
  Skeleton,
  Table,
} from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  canRollback,
  deploymentTone,
  healthOf,
  isLiveDeployment,
  isUuid,
  safeText,
  safeHref,
  settle,
  type ApprovalRef,
  type Deployment,
} from '../lib/builder';
import { newKey } from '../lib/data';
import { Code, Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { ConfirmDialog, Note } from './DataUi';

const POLL_MS = 3000;
type Log = NonNullable<Schemas['DeploymentLogs']['items']>[number];

/** 403 `approval_required`: the approvals a deploy or rollback is waiting for, each with the hash it is bound to, and the way to decide them. */
export function ApprovalNeeded({ locale, items }: { locale: Locale; items: ApprovalRef[] }) {
  return (
    <Banner tone="warn">
      <p style={{ margin: 0 }}>
        <strong>{t(locale, 'm10.dep.approvalNeeded')}</strong>{' '}
        {t(locale, 'm10.dep.approvalNeededBody')}
      </p>
      <ul>
        {items.map((a) => (
          <li key={a.id}>
            <Word locale={locale} prefix="m10.apr.type" value={a.type} /> —{' '}
            {t(locale, 'm10.apr.scopeHash')}: <Ltr>{a.scopeHash}</Ltr>
          </li>
        ))}
      </ul>
      <a href={`/${locale}/approvals`}>{t(locale, 'm10.dep.openApprovals')}</a>
    </Banner>
  );
}

/** The health gate of a deployment: attempts, and whether the previous release was restored automatically. */
export function HealthGate({ locale, d }: { locale: Locale; d: Deployment }) {
  const h = healthOf(d.healthCheck);
  if (!h) return <p className="nz-muted">{t(locale, 'm10.dep.noHealth')}</p>;
  return (
    <dl>
      {h.attempts !== null && (
        <>
          <dt>{t(locale, 'm10.dep.attempts')}</dt>
          <dd>
            <Ltr>{String(h.attempts)}</Ltr>
          </dd>
        </>
      )}
      <dt>{t(locale, 'm10.dep.gate')}</dt>
      <dd>
        <Badge tone={d.state === 'failed' ? 'danger' : d.state === 'live' ? 'success' : 'warn'}>
          {t(
            locale,
            d.state === 'failed'
              ? 'm10.dep.gateFailed'
              : d.state === 'live'
                ? 'm10.dep.gatePassed'
                : 'm10.dep.gatePending',
          )}
        </Badge>
      </dd>
      <dt>{t(locale, 'm10.dep.autoRollback')}</dt>
      <dd>
        {h.autoRolledBack
          ? t(locale, 'm10.dep.restored', { id: (h.restoredDeploymentId ?? '').slice(0, 8) })
          : t(locale, 'm10.dep.notRestored')}
      </dd>
    </dl>
  );
}

/**
 * UI-M10-09: deployments of a project: list, detail with the health-gate result and logs, create (target and environment; 403 `approval_required` lists the
 * approvals) and rollback behind a confirmation (approval_required and invalid_state handled).
 */
export function Deployments({
  locale,
  projectId,
  initial,
  versions,
  headVersionId,
  canCreate,
  canRoll,
  mfaFactorId,
}: {
  locale: Locale;
  projectId: string;
  initial: Deployment[];
  versions: { id: string; label?: string | null }[];
  headVersionId: string | null;
  canCreate: boolean;
  canRoll: boolean;
  mfaFactorId: string | null;
}) {
  const create = useBuilderCall(locale, mfaFactorId);
  const roll = useBuilderCall(locale, mfaFactorId);
  const [items, setItems] = useState<Deployment[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [logsError, setLogsError] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [targetType, setTargetType] = useState<'site' | 'instance'>('site');
  const [targetId, setTargetId] = useState('');
  const [env, setEnv] = useState<'production' | 'staging'>('staging');
  const [versionId, setVersionId] = useState(headVersionId ?? '');
  const [errors, setErrors] = useState<{ target?: string }>({});
  const [needed, setNeeded] = useState<ApprovalRef[]>([]);
  const [rollNeeded, setRollNeeded] = useState<ApprovalRef[]>([]);
  const [confirmRoll, setConfirmRoll] = useState(false);
  const [createKey, setCreateKey] = useState(newKey());
  const [rollKey, setRollKey] = useState(newKey());
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const live = items.some((d) => isLiveDeployment(d.state));
  useEffect(() => {
    alive.current = true;
    if (!live) return;
    const id = setTimeout(async () => {
      const r = await settle(() =>
        browserApi().GET('/v1/deployments', { params: { query: { projectId } } }),
      );
      if (!alive.current) return;
      if (r.response.ok && r.data) {
        setOffline(false);
        setItems((r.data as { items: Deployment[] }).items);
      } else setOffline(true);
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
  }, [live, tick]);

  const current = items.find((d) => d.id === selected) ?? null;
  const currentId = current?.id;
  const currentState = current?.state;
  useEffect(() => {
    if (!currentId) return setLogs(null);
    let on = true;
    setLogsLoading(true);
    setLogsError(false);
    void settle(() =>
      browserApi().GET('/v1/deployments/{id}/logs', { params: { path: { id: currentId } } }),
    ).then((r) => {
      if (!on) return;
      setLogsLoading(false);
      if (r.response.ok && r.data) setLogs((r.data as Schemas['DeploymentLogs']).items);
      else {
        setLogs(null);
        setLogsError(true);
      }
    });
    return () => {
      on = false;
    };
  }, [currentId, currentState]);

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!isUuid(targetId)) return setErrors({ target: t(locale, 'm10.dep.err.target') });
    setErrors({});
    setNeeded([]);
    void create.run(
      () =>
        browserApi().POST('/v1/deployments', {
          params: { header: { 'Idempotency-Key': createKey } },
          body: {
            projectId,
            ...(versionId ? { versionId } : {}),
            target: { type: targetType, id: targetId.trim().toLowerCase() },
            env,
          },
        }),
      (d) => {
        setCreateKey(newKey());
        const x = d as Deployment;
        setItems((cur) => [x, ...cur.filter((c) => c.id !== x.id)]);
        setSelected(x.id);
      },
      (f) => {
        setCreateKey(newKey());
        if (f.problem.code === 'approval_required') {
          setNeeded(f.approvals);
          return true;
        }
      },
    );
  }

  function rollback() {
    if (!current) return;
    setRollNeeded([]);
    void roll.run(
      () =>
        browserApi().POST('/v1/deployments/{id}/rollback', {
          params: { path: { id: current.id }, header: { 'Idempotency-Key': rollKey } },
        }),
      (d) => {
        setConfirmRoll(false);
        setRollKey(newKey());
        const x = d as Deployment;
        setItems((cur) => [x, ...cur.filter((c) => c.id !== x.id)]);
        setSelected(x.id);
        roll.setNotice({ tone: 'ok', text: t(locale, 'm10.dep.rollbackStarted') });
      },
      (f) => {
        setRollKey(newKey());
        if (f.problem.code === 'approval_required') {
          setConfirmRoll(false);
          setRollNeeded(f.approvals);
          return true;
        }
        if (f.problem.code === 'invalid_state' || f.problem.status === 409) setConfirmRoll(false);
      },
    );
  }

  return (
    <>
      {canCreate ? (
        <form
          onSubmit={submit}
          noValidate
          className="nz-card"
          aria-label={t(locale, 'm10.dep.new')}
          style={{ maxInlineSize: 640 }}
        >
          <h2 className="nz-h2">{t(locale, 'm10.dep.new')}</h2>
          <Field id="dep-type" label={t(locale, 'm10.dep.targetType')}>
            {(x) => (
              <Select
                {...x}
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as 'site' | 'instance')}
              >
                <option value="site">{t(locale, 'm10.dep.target.site')}</option>
                <option value="instance">{t(locale, 'm10.dep.target.instance')}</option>
              </Select>
            )}
          </Field>
          <Field
            id="dep-target"
            label={t(locale, 'm10.dep.targetId')}
            help={t(locale, 'm10.dep.targetHelp')}
            error={errors.target}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              />
            )}
          </Field>
          <Field
            id="dep-env"
            label={t(locale, 'm10.dep.env')}
            help={env === 'production' ? t(locale, 'm10.dep.prodHelp') : undefined}
          >
            {(x) => (
              <Select
                {...x}
                value={env}
                onChange={(e) => setEnv(e.target.value as 'production' | 'staging')}
              >
                <option value="staging">{t(locale, 'm10.dep.env.staging')}</option>
                <option value="production">{t(locale, 'm10.dep.env.production')}</option>
              </Select>
            )}
          </Field>
          <Field id="dep-version" label={t(locale, 'm10.dep.version')}>
            {(x) => (
              <Select {...x} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                <option value="">{t(locale, 'm10.dep.versionHead')}</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id.slice(0, 8)}
                    {v.label ? ` · ${safeText(v.label, 40)}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {needed.length > 0 && <ApprovalNeeded locale={locale} items={needed} />}
          <Note n={create.notice} />
          <Button type="submit" disabled={create.busy}>
            {t(locale, 'm10.dep.create')}
          </Button>
        </form>
      ) : (
        <p className="nz-muted">{t(locale, 'm10.dep.noCreate')}</p>
      )}
      {offline && <Banner tone="warn">{t(locale, 'm10.err.offline')}</Banner>}
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm10.dep.title')}
      </h2>
      {items.length === 0 ? (
        <EmptyState title={t(locale, 'm10.dep.empty')} body={t(locale, 'm10.dep.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm10.dep.title')}
          rows={items}
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'id',
              header: t(locale, 'm10.dep.col.id'),
              render: (d) => (
                <button
                  type="button"
                  className="nz-btn"
                  data-variant={d.id === selected ? 'primary' : 'secondary'}
                  aria-current={d.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(d.id)}
                >
                  <Ltr>{d.id.slice(0, 8)}</Ltr>
                </button>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'm10.dep.env'),
              render: (d) => t(locale, `m10.dep.env.${d.environment}`),
            },
            {
              key: 'tg',
              header: t(locale, 'm10.dep.col.target'),
              render: (d) => (
                <>
                  <Word locale={locale} prefix="m10.dep.target" value={d.target?.type ?? ''} />{' '}
                  <Ltr>{(d.target?.id ?? '').slice(0, 8)}</Ltr>
                </>
              ),
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (d) => (
                <Badge tone={deploymentTone(d.state)}>
                  <Word locale={locale} prefix="m10.dep.state" value={d.state} />
                </Badge>
              ),
            },
            {
              key: 'w',
              header: t(locale, 'field.created'),
              render: (d) => (d.createdAt ? formatDateTime(d.createdAt, locale) : '—'),
            },
          ]}
        />
      )}
      {current && (
        <Card aria-label={t(locale, 'm10.dep.detail')} style={{ marginBlockStart: 16 }}>
          <h2 className="nz-h2">
            {t(locale, 'm10.dep.detail')} <Ltr>{current.id.slice(0, 8)}</Ltr>
          </h2>
          <dl>
            <dt>{t(locale, 'field.status')}</dt>
            <dd>
              <Badge tone={deploymentTone(current.state)}>
                <Word locale={locale} prefix="m10.dep.state" value={current.state} />
              </Badge>
            </dd>
            <dt>{t(locale, 'm10.dep.env')}</dt>
            <dd>{t(locale, `m10.dep.env.${current.environment}`)}</dd>
            {current.failureCode && (
              <>
                <dt>{t(locale, 'm10.dep.failure')}</dt>
                <dd>
                  <Ltr>{current.failureCode}</Ltr>
                </dd>
              </>
            )}
            {safeHref(current.url) && (
              <>
                <dt>URL</dt>
                <dd>
                  <a href={safeHref(current.url)} rel="noreferrer noopener">
                    <Ltr>{current.url}</Ltr>
                  </a>
                </dd>
              </>
            )}
            {current.artifactSha256 && (
              <>
                <dt>{t(locale, 'm10.dep.artifact')}</dt>
                <dd>
                  <Ltr>{current.artifactSha256}</Ltr>
                </dd>
              </>
            )}
            {current.rollbackOf && (
              <>
                <dt>{t(locale, 'm10.dep.rollbackOf')}</dt>
                <dd>
                  <Ltr>{current.rollbackOf.slice(0, 8)}</Ltr>
                </dd>
              </>
            )}
            {(current.migrations ?? []).length > 0 && (
              <>
                <dt>{t(locale, 'm10.dep.migrations')}</dt>
                <dd>
                  {(current.migrations ?? []).map((m, i) => (
                    <Badge key={i} tone={m.destructive ? 'danger' : undefined}>
                      <Ltr>{`#${m.version ?? '?'}`}</Ltr>{' '}
                      {m.destructive ? t(locale, 'm10.dep.destructive') : ''}
                    </Badge>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <h3 className="nz-h3">{t(locale, 'm10.dep.health')}</h3>
          <HealthGate locale={locale} d={current} />
          <h3 className="nz-h3">{t(locale, 'm10.dep.logs')}</h3>
          {logsLoading ? (
            <Skeleton lines={3} label={t(locale, 'state.loading')} />
          ) : logsError ? (
            <p role="alert" className="nz-error-text">
              {t(locale, 'state.error.title')}
            </p>
          ) : logs && logs.length > 0 ? (
            <Code label={t(locale, 'm10.dep.logs')}>
              {logs.map((l) => `${l.level ?? 'info'} ${safeText(l.message, 400)}`).join('\n')}
            </Code>
          ) : (
            <p className="nz-muted">{t(locale, 'm10.dep.noLogs')}</p>
          )}
          {canRoll && canRollback(current) && (
            <p>
              <Button variant="danger" disabled={roll.busy} onClick={() => setConfirmRoll(true)}>
                {t(locale, 'm10.dep.rollback')}
              </Button>
            </p>
          )}
          {rollNeeded.length > 0 && <ApprovalNeeded locale={locale} items={rollNeeded} />}
          <Note n={roll.notice} />
          <ConfirmDialog
            open={confirmRoll}
            title={t(locale, 'm10.dep.rollbackTitle')}
            onClose={() => setConfirmRoll(false)}
          >
            <p>{t(locale, 'm10.dep.rollbackBody', { id: current.id.slice(0, 8) })}</p>
            {current.environment === 'production' && (
              <Banner tone="warn">{t(locale, 'm10.dep.rollbackProd')}</Banner>
            )}
            <Note n={roll.notice} />
            <div className="nz-row">
              <Button variant="danger" disabled={roll.busy} onClick={rollback}>
                {t(locale, 'm10.dep.rollbackConfirm')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmRoll(false)}>
                {t(locale, 'action.cancel')}
              </Button>
            </div>
          </ConfirmDialog>
        </Card>
      )}
      {create.panel}
      {roll.panel}
    </>
  );
}
