'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Ltr, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  ageMinutes,
  classifyResource,
  driftTone,
  loose,
  newKey,
  operationClassTone,
  resourceStateTone,
  shortId,
  type CloudResourceDto,
} from '../lib/providers';
import { JobPoller, ProviderResult, useProviderAction } from './ProviderBits';

/** The notice every cross-organization read carries: the API records the read in the audit log (admin.resources.listed). */
export const AuditedReadNotice = ({ locale }: { locale: Locale }) => (
  <Banner tone="warn">{t(locale, 'm05.adm.res.audited')}</Banner>
);

/** Force a reconciliation (202 + job). The reconciler never retries a provision without proof of absence and never deletes: that is stated next to the button. */
export function ReconcileButton(p: {
  locale: Locale;
  resourceId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useProviderAction(p.locale, p.mfaFactorId);
  const [job, setJob] = useState<string | null>(null);
  const [idem, setIdem] = useState(newKey());
  return (
    <div>
      <Button
        variant="secondary"
        disabled={a.busy}
        aria-label={t(p.locale, 'm05.adm.res.reconcileFor', { id: shortId(p.resourceId) })}
        onClick={() =>
          void a.run(
            () =>
              loose(browserApi()).POST('/v1/admin/resources/{id}/reconciliations', {
                params: { path: { id: p.resourceId } },
                headers: { 'Idempotency-Key': idem },
              }),
            (d) => {
              setJob((d as { operationId: string }).operationId);
              setIdem(newKey());
            },
            a.overrides,
          )
        }
      >
        {t(p.locale, 'm05.adm.res.reconcile')}
      </Button>
      <ProviderResult n={a.notice} problem={a.problem} locale={p.locale} />
      {job && <JobPoller key={job} locale={p.locale} jobId={job} onDone={() => router.refresh()} />}
      {a.panel}
    </div>
  );
}

/** UI-M05-12 / UI-M05-13: resource rows across organizations (drift and orphan state, open case) with the force-reconcile action for managers. */
export function ResourcesTable(p: {
  locale: Locale;
  rows: CloudResourceDto[];
  canManage: boolean;
  mfaFactorId: string | null;
  caption: string;
  /** Adds the operation class and age (operations monitor). */
  now?: Date;
}) {
  if (p.rows.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.res.empty.title')}
        body={t(p.locale, 'm05.adm.res.empty.body')}
      />
    );
  const now = p.now;
  return (
    <Table
      caption={p.caption}
      rows={p.rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'id',
          header: t(p.locale, 'm05.adm.res.col.resource'),
          render: (r) => (
            <span title={r.id}>
              <Ltr>{shortId(r.id)}</Ltr> <span className="nz-muted">{r.kind}</span>
            </span>
          ),
        },
        {
          key: 'o',
          header: t(p.locale, 'm05.adm.res.col.org'),
          render: (r) => (
            <span title={r.orgId}>
              <Ltr>{shortId(r.orgId)}</Ltr>
            </span>
          ),
        },
        {
          key: 'p',
          header: t(p.locale, 'm05.adm.col.provider'),
          render: (r) => (
            <span>
              <Ltr>{r.providerKey ?? shortId(r.providerAccountId)}</Ltr>{' '}
              <span className="nz-muted">
                <Ltr>{r.providerRegionId}</Ltr>
              </span>
            </span>
          ),
        },
        {
          key: 'c',
          header: t(p.locale, 'm05.adm.res.col.placement'),
          render: (r) => (
            <Ltr>
              {r.country} / {r.dataRegion}
            </Ltr>
          ),
        },
        {
          key: 's',
          header: t(p.locale, 'm05.adm.res.col.state'),
          render: (r) => (
            <Badge tone={resourceStateTone(r.state)}>
              {tDynamic(p.locale, `m05.adm.res.state.${r.state}`, r.state)}
            </Badge>
          ),
        },
        {
          key: 'd',
          header: t(p.locale, 'm05.adm.res.col.drift'),
          render: (r) => (
            <Badge tone={driftTone(r.driftState)}>
              {tDynamic(p.locale, `m05.adm.res.drift.${r.driftState}`, r.driftState)}
            </Badge>
          ),
        },
        ...(now
          ? [
              {
                key: 'cl',
                header: t(p.locale, 'm05.adm.ops.col.class'),
                render: (r: CloudResourceDto) => {
                  const c = classifyResource(r, now);
                  return (
                    <Badge tone={operationClassTone(c)}>
                      {t(p.locale, `m05.adm.ops.class.${c}`)}
                    </Badge>
                  );
                },
              },
              {
                key: 'age',
                header: t(p.locale, 'm05.adm.ops.col.age'),
                render: (r: CloudResourceDto) => {
                  const m = ageMinutes(r.createdAt, now);
                  return m === null ? '—' : t(p.locale, 'm05.adm.ops.minutes', { count: m });
                },
              },
            ]
          : []),
        {
          key: 'l',
          header: t(p.locale, 'm05.adm.res.col.lastSeen'),
          render: (r) => (r.lastSeenAt ? formatDateTime(r.lastSeenAt, p.locale) : '—'),
        },
        {
          key: 'case',
          header: t(p.locale, 'm05.adm.res.col.case'),
          render: (r) =>
            r.caseOpenedAt ? (
              <Badge tone="danger">{formatDateTime(r.caseOpenedAt, p.locale)}</Badge>
            ) : (
              '—'
            ),
        },
        ...(p.canManage
          ? [
              {
                key: 'x',
                header: t(p.locale, 'field.action'),
                render: (r: CloudResourceDto) => (
                  <ReconcileButton
                    locale={p.locale}
                    resourceId={r.id}
                    mfaFactorId={p.mfaFactorId}
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** Look one platform job up by id (verification, catalog sync or reconcile) and follow it: the monitor's substitute for a job list. */
export function JobLookup({ locale }: { locale: Locale }) {
  const [id, setId] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState('');
  return (
    <form
      className="nz-card"
      aria-label={t(locale, 'm05.adm.ops.lookup')}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!/^[0-9a-f-]{36}$/i.test(id.trim()))
          return setErr(t(locale, 'm05.adm.ops.lookup.invalid'));
        setErr('');
        setActive(id.trim().toLowerCase());
      }}
    >
      <h2 className="nz-h2">{t(locale, 'm05.adm.ops.lookup')}</h2>
      <p className="nz-muted">{t(locale, 'm05.adm.ops.lookup.help')}</p>
      <div className="nz-field">
        <label htmlFor="job-id">{t(locale, 'm05.adm.ops.lookup.id')}</label>
        <input
          id="job-id"
          className="nz-input"
          dir="ltr"
          value={id}
          onChange={(e) => setId(e.target.value)}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? 'job-id-err' : undefined}
        />
        {err && (
          <span className="nz-error-text" id="job-id-err" role="alert">
            {err}
          </span>
        )}
      </div>
      <Button type="submit">{t(locale, 'action.search')}</Button>
      {active && <JobPoller key={active} locale={locale} jobId={active} />}
    </form>
  );
}
