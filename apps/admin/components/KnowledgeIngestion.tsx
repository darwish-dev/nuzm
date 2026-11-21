'use client';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { formatDateTime, t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  formatBytes,
  isCancellable,
  isKnownReason,
  evidenceText,
  isRetryable,
  jobTone,
  levelTone,
  licenseTone,
  severityTone,
  statusTone,
  type IngestFile,
  type IngestFinding,
  type IngestJob,
  type IngestLog,
  type KnowledgeVersion,
  type ManDetection,
  type ManProject,
  type ProjectManifestView,
  type ReviewState,
} from '../lib/knowledge';

/**
 * Processing and review of one library version (SCR-K-02): the jobs the isolated ingestion worker ran, their logs, the scan findings, the file inventory, and the review
 * gate in front of activation. Every section handles loading, empty, error and forbidden states. Nothing here can show file content or a matched secret: the API never
 * returns either.
 */
type Remote<T> = { s: 'loading' } | { s: 'error'; status: number } | { s: 'ok'; data: T };
type Page<T> = { items: T[]; nextCursor: string | null };
type Notice = { tone: 'ok' | 'error'; text: string } | null;
const BASE = '/v1/admin/knowledge/resources/{id}';

function useRemote<T>(
  load: () => Promise<{ ok: boolean; status: number; data: T | null }>,
  deps: unknown[],
) {
  const [r, set] = useState<Remote<T>>({ s: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set({ s: 'loading' });
    load()
      .then(
        (x) =>
          live &&
          set(
            x.ok && x.data !== null ? { s: 'ok', data: x.data } : { s: 'error', status: x.status },
          ),
      )
      .catch(() => live && set({ s: 'error', status: 0 }));
    return () => {
      live = false;
    };
    // `deps` is the explicit dependency list of the caller (a data-loading hook), so `load` is intentionally not listed
  }, [...deps, tick]);
  return [r, () => setTick((n) => n + 1)] as const;
}

function Frame<T>({
  locale,
  r,
  reload,
  children,
}: {
  locale: Locale;
  r: Remote<T>;
  reload: () => void;
  children: (d: T) => ReactNode;
}) {
  if (r.s === 'loading')
    return (
      <p className="nz-muted" role="status">
        {t(locale, 'ki.loading')}
      </p>
    );
  if (r.s === 'error')
    return (
      <div role="alert">
        <p className="nz-error-text">
          {t(locale, r.status === 403 ? 'ki.forbidden' : 'ki.load.error')}
        </p>
        {r.status !== 403 && (
          <Button variant="secondary" onClick={reload}>
            {t(locale, 'ki.retry.load')}
          </Button>
        )}
      </div>
    );
  return <>{children(r.data)}</>;
}

export function KnowledgeIngestion({
  locale,
  resourceId,
  versions,
  currentVersionId,
  canManage,
  canPublish,
}: {
  locale: Locale;
  resourceId: string;
  versions: KnowledgeVersion[];
  currentVersionId: string | null;
  canManage: boolean;
  canPublish: boolean;
}) {
  const [versionId, setVersionId] = useState(currentVersionId ?? versions[0]?.id ?? '');
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);
  if (!versionId) return null;
  return (
    <section className="kni" aria-label={t(locale, 'ki.title')}>
      <Card>
        <h2 className="nz-h2">{t(locale, 'ki.title')}</h2>
        <p className="nz-muted">{t(locale, 'ki.intro')}</p>
        <div className="kni-toolbar">
          <Field id="kni-version" label={t(locale, 'ki.version')}>
            {(a) => (
              <Select {...a} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    #{v.seq} · {t(locale, `kn.status.${v.state}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>
      <ReviewSection
        key={`r-${versionId}`}
        locale={locale}
        resourceId={resourceId}
        versionId={versionId}
        canManage={canManage}
        canPublish={canPublish}
        rev={rev}
        onChange={bump}
      />
      <JobsSection
        key={`j-${versionId}`}
        locale={locale}
        resourceId={resourceId}
        versionId={versionId}
        canManage={canManage}
        rev={rev}
        onChange={bump}
      />
      <ManifestSection
        key={`m-${versionId}`}
        locale={locale}
        resourceId={resourceId}
        versionId={versionId}
        rev={rev}
      />
      <FindingsSection
        key={`f-${versionId}`}
        locale={locale}
        resourceId={resourceId}
        versionId={versionId}
        rev={rev}
      />
      <FilesSection
        key={`i-${versionId}`}
        locale={locale}
        resourceId={resourceId}
        versionId={versionId}
        rev={rev}
      />
    </section>
  );
}

// ---- review -----------------------------------------------------------------------------------------------------------------------
function ReviewSection({
  locale,
  resourceId,
  versionId,
  canManage,
  canPublish,
  rev,
  onChange,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  canManage: boolean;
  canPublish: boolean;
  rev: number;
  onChange: () => void;
}) {
  const [r, reload] = useRemote<ReviewState>(async () => {
    const x = await browserApi().GET(
      `${BASE}/versions/{versionId}/review` as never,
      { params: { path: { id: resourceId, versionId } } } as never,
    );
    return {
      ok: x.response.ok,
      status: x.response.status,
      data: (x.data as unknown as ReviewState) ?? null,
    };
  }, [resourceId, versionId, rev]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState({ findingsReviewed: false, licenseReviewed: false });
  const [rejecting, setRejecting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const call = async (path: string, body: object, done: MessageKey) => {
    setBusy(true);
    setNotice(null);
    const x = await browserApi().POST(
      path as never,
      {
        params: {
          path: { id: resourceId, versionId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body,
      } as never,
    );
    setBusy(false);
    if (!x.response.ok) {
      const s = x.response.status;
      setNotice({
        tone: 'error',
        text: t(
          locale,
          s === 403
            ? 'kn.err.forbidden'
            : s === 404
              ? 'kn.err.notFound'
              : s === 409
                ? 'kn.err.conflict'
                : s === 422
                  ? 'kn.err.refused'
                  : 'kn.err.generic',
        ),
      });
      return false;
    }
    setNotice({ tone: 'ok', text: t(locale, done) });
    setChecks({ findingsReviewed: false, licenseReviewed: false });
    setRejecting(false);
    onChange();
    return true;
  };
  const approve = () =>
    call(
      `${BASE}/reviews`,
      { versionId, decision: 'approve', checklist: checks },
      'ki.done.approved',
    );
  const activate = () => call(`${BASE}/activation`, { versionId }, 'ki.done.activated');
  const reject = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const note = String(
      (e.currentTarget.elements.namedItem('note') as HTMLInputElement).value,
    ).trim();
    if (note.length < 10) return setNoteError(t(locale, 'ki.reject.short'));
    setNoteError(null);
    await call(`${BASE}/reviews`, { versionId, decision: 'reject', note }, 'ki.done.rejected');
  };
  const retry = () => call(`${BASE}/versions/{versionId}/reprocessing`, {}, 'ki.retry.done');

  return (
    <Card aria-label={t(locale, 'ki.review')}>
      <h2 className="nz-h2">{t(locale, 'ki.review')}</h2>
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'nz-error-text' : ''}
        >
          {notice.text}
        </p>
      )}
      <Frame locale={locale} r={r} reload={reload}>
        {(s) => (
          <>
            <dl className="kni-facts">
              <div>
                <dt>{t(locale, 'kn.col.status')}</dt>
                <dd>
                  <Badge tone={statusTone(s.state)}>
                    {t(locale, `kn.status.${s.state}` as MessageKey)}
                  </Badge>
                </dd>
              </div>
              {s.stateReason && (
                <div>
                  <dt>{t(locale, 'ki.reason')}</dt>
                  <dd>
                    {isKnownReason(s.stateReason) ? (
                      t(locale, `ki.reason.${s.stateReason}` as MessageKey)
                    ) : (
                      <>
                        {t(locale, 'ki.reason.archive')} <Ltr>{s.stateReason}</Ltr>
                      </>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t(locale, 'ki.prov')}</dt>
                <dd>{t(locale, `ki.prov.${s.provenanceClass}` as MessageKey)}</dd>
              </div>
              <div>
                <dt>{t(locale, 'ki.license')}</dt>
                <dd>
                  {s.licenseProposal ? (
                    <>
                      <Badge tone={licenseTone(s.licenseProposal.verdict)}>
                        {t(locale, `kn.lic.${s.licenseProposal.verdict}` as MessageKey)}
                      </Badge>{' '}
                      {s.licenseProposal.spdx && <Ltr>{s.licenseProposal.spdx}</Ltr>}
                    </>
                  ) : (
                    t(locale, 'ki.license.none')
                  )}
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'ki.findings')}</dt>
                <dd>
                  {(['block', 'warn', 'info'] as const).map((k) => (
                    <span key={k}>
                      <Badge tone={severityTone(k)}>
                        {t(locale, `ki.sev.${k}` as MessageKey)}: <Ltr>{String(s.findings[k])}</Ltr>
                      </Badge>{' '}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'ki.approvals')}</dt>
                <dd>
                  {t(locale, 'ki.approvals.count', {
                    n: s.approvals.length,
                    need: s.requiredApprovals,
                  })}
                </dd>
              </div>
            </dl>
            <p className="nz-muted">{t(locale, 'ki.license.note')}</p>

            <h3 className="nz-h3">{t(locale, 'ki.blockers')}</h3>
            {s.blockers.length === 0 ? (
              <p>{t(locale, 'ki.blockers.none')}</p>
            ) : (
              <ul className="kni-list">
                {s.blockers.map((b) => (
                  <li key={b.code}>{t(locale, `ki.blocker.${b.code}` as MessageKey)}</li>
                ))}
              </ul>
            )}

            <h3 className="nz-h3">{t(locale, 'ki.history')}</h3>
            {s.reviews.length === 0 ? (
              <p className="nz-muted">{t(locale, 'ki.history.none')}</p>
            ) : (
              <ul className="kni-list">
                {s.reviews.map((x) => (
                  <li key={x.id}>
                    <Badge tone={x.decision === 'APPROVE' ? 'success' : 'danger'}>
                      {t(locale, `ki.decision.${x.decision}` as MessageKey)}
                    </Badge>{' '}
                    {x.createdAt && formatDateTime(x.createdAt, locale)}
                    {x.reason && (
                      <>
                        {' '}
                        — <bdi dir="auto">{x.reason}</bdi>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canManage &&
              s.analysisJobId === null &&
              isRetryable({ state: s.state }, s.stateReason) && (
                <div className="nz-row">
                  <Button variant="secondary" disabled={busy} onClick={() => void retry()}>
                    {t(locale, 'ki.retry')}
                  </Button>
                </div>
              )}

            {canPublish && s.state === 'AWAITING_REVIEW' && (
              <>
                {s.you.isUploader && s.provenanceClass === 'THIRD_PARTY' && (
                  <p className="nz-muted">{t(locale, 'ki.you.uploader')}</p>
                )}
                {s.you.hasApproved && <p className="nz-muted">{t(locale, 'ki.you.approved')}</p>}
                {s.you.canReview && (
                  <fieldset className="knd-checks">
                    <label className="knd-check">
                      <input
                        type="checkbox"
                        checked={checks.findingsReviewed}
                        onChange={(e) =>
                          setChecks({ ...checks, findingsReviewed: e.target.checked })
                        }
                      />{' '}
                      {t(locale, 'ki.check.findings')}
                    </label>
                    <label className="knd-check">
                      <input
                        type="checkbox"
                        checked={checks.licenseReviewed}
                        onChange={(e) =>
                          setChecks({ ...checks, licenseReviewed: e.target.checked })
                        }
                      />{' '}
                      {t(locale, 'ki.check.license')}
                    </label>
                    <div className="nz-row">
                      <Button
                        disabled={busy || !checks.findingsReviewed || !checks.licenseReviewed}
                        onClick={() => void approve()}
                      >
                        {t(locale, 'ki.approve')}
                      </Button>
                      <Button variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
                        {t(locale, 'ki.reject')}
                      </Button>
                    </div>
                  </fieldset>
                )}
                {rejecting && (
                  <form
                    onSubmit={(e) => void reject(e)}
                    noValidate
                    aria-label={t(locale, 'ki.reject')}
                  >
                    <Field
                      id="kni-note"
                      label={t(locale, 'ki.reject.note')}
                      error={noteError ?? undefined}
                    >
                      {(a) => <Input {...a} name="note" maxLength={2000} autoFocus />}
                    </Field>
                    <div className="nz-row">
                      <Button type="submit" variant="danger" disabled={busy}>
                        {t(locale, 'ki.reject.confirm')}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setRejecting(false)}
                      >
                        {t(locale, 'kn.d.cancel')}
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
            {canPublish && (s.state === 'AWAITING_REVIEW' || s.state === 'DISABLED') && (
              <>
                <div className="nz-row">
                  <Button disabled={busy || !s.canActivate} onClick={() => void activate()}>
                    {t(locale, 'ki.activate')}
                  </Button>
                </div>
                <p className="nz-muted">{t(locale, 'ki.activate.note')}</p>
              </>
            )}
          </>
        )}
      </Frame>
    </Card>
  );
}

// ---- jobs and logs ----------------------------------------------------------------------------------------------------------------
function JobsSection({
  locale,
  resourceId,
  versionId,
  canManage,
  rev,
  onChange,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  canManage: boolean;
  rev: number;
  onChange: () => void;
}) {
  const [r, reload] = useRemote<Page<IngestJob>>(async () => {
    const x = await browserApi().GET(
      `${BASE}/processing-jobs` as never,
      { params: { path: { id: resourceId }, query: { versionId, limit: 50 } } } as never,
    );
    return {
      ok: x.response.ok,
      status: x.response.status,
      data: (x.data as unknown as Page<IngestJob>) ?? null,
    };
  }, [resourceId, versionId, rev]);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async (job: IngestJob) => {
    setBusy(true);
    const x = await browserApi().POST(
      `${BASE}/processing-jobs/{jobId}/cancellation` as never,
      {
        params: {
          path: { id: resourceId, jobId: job.id },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body: {},
      } as never,
    );
    setBusy(false);
    if (!x.response.ok)
      return setNotice({
        tone: 'error',
        text: t(locale, x.response.status === 409 ? 'kn.err.conflict' : 'kn.err.generic'),
      });
    const result = (x.data as { result?: string } | undefined)?.result;
    setNotice({
      tone: 'ok',
      text: t(locale, result === 'CANCEL_REQUESTED' ? 'ki.cancel.requested' : 'ki.cancel.done'),
    });
    onChange();
  };

  return (
    <Card aria-label={t(locale, 'ki.jobs')}>
      <h2 className="nz-h2">{t(locale, 'ki.jobs')}</h2>
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'nz-error-text' : ''}
        >
          {notice.text}
        </p>
      )}
      <Frame locale={locale} r={r} reload={reload}>
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState title={t(locale, 'ki.jobs')} body={t(locale, 'ki.jobs.none')} />
          ) : (
            <>
              <Table
                caption={t(locale, 'ki.jobs')}
                rows={p.items}
                rowKey={(j) => j.id}
                columns={[
                  {
                    key: 'kind',
                    header: t(locale, 'ki.col.kind'),
                    card: 'title',
                    render: (j) =>
                      tDynamic(locale, `ki.kind.${j.kind}`, t(locale, 'ki.kind.other')),
                  },
                  {
                    key: 'state',
                    header: t(locale, 'ki.col.state'),
                    card: 'badge',
                    render: (j) => (
                      <Badge tone={jobTone(j.state)}>
                        {t(locale, `ki.job.${j.state}` as MessageKey)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'attempt',
                    header: t(locale, 'ki.col.attempt'),
                    card: 'meta',
                    render: (j) => <Ltr>{`${j.attempt}/${j.maxAttempts}`}</Ltr>,
                  },
                  {
                    key: 'result',
                    header: t(locale, 'ki.col.result'),
                    card: 'meta',
                    render: (j) =>
                      j.errorCode ? (
                        <Ltr>{j.errorCode}</Ltr>
                      ) : j.finishedAt ? (
                        formatDateTime(j.finishedAt, locale)
                      ) : (
                        '—'
                      ),
                  },
                  {
                    key: 'actions',
                    header: t(locale, 'ki.col.actions'),
                    card: 'footer',
                    render: (j) => (
                      <span className="nz-row">
                        <Button
                          variant="secondary"
                          aria-expanded={open === j.id}
                          onClick={() => setOpen(open === j.id ? null : j.id)}
                        >
                          {t(locale, open === j.id ? 'ki.logs.hide' : 'ki.logs')}
                        </Button>
                        {canManage && isCancellable(j) && (
                          <Button variant="danger" disabled={busy} onClick={() => void cancel(j)}>
                            {t(locale, 'ki.cancel')}
                          </Button>
                        )}
                      </span>
                    ),
                  },
                ]}
              />
              {open && <JobLog locale={locale} resourceId={resourceId} jobId={open} />}
            </>
          )
        }
      </Frame>
    </Card>
  );
}

function JobLog({
  locale,
  resourceId,
  jobId,
}: {
  locale: Locale;
  resourceId: string;
  jobId: string;
}) {
  const [items, setItems] = useState<IngestLog[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const load = useCallback(
    async (cursor?: string) => {
      setState('loading');
      const x = await browserApi().GET(
        `${BASE}/processing-jobs/{jobId}/logs` as never,
        {
          params: {
            path: { id: resourceId, jobId },
            query: { limit: 100, ...(cursor ? { cursor } : {}) },
          },
        } as never,
      );
      if (!x.response.ok) return setState('error');
      const d = x.data as unknown as Page<IngestLog>;
      setItems((cur) => (cursor ? [...cur, ...d.items] : d.items));
      setNext(d.nextCursor);
      setState('ok');
    },
    [resourceId, jobId],
  );
  useEffect(() => {
    setItems([]);
    void load();
  }, [load]);
  return (
    <div aria-label={t(locale, 'ki.logs')}>
      <p className="nz-muted">{t(locale, 'ki.logs.note')}</p>
      {state === 'error' && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'ki.load.error')}
        </p>
      )}
      {state === 'loading' && items.length === 0 && (
        <p className="nz-muted" role="status">
          {t(locale, 'ki.loading')}
        </p>
      )}
      {state === 'ok' && items.length === 0 && (
        <p className="nz-muted">{t(locale, 'ki.logs.none')}</p>
      )}
      {items.length > 0 && (
        <ol className="kni-log" dir="ltr">
          {items.map((l) => (
            <li key={l.id}>
              <Badge
                tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : undefined}
              >
                {l.level}
              </Badge>
              <span>{l.stage}</span>
              <span>{l.message}</span>
            </li>
          ))}
        </ol>
      )}
      {next && (
        <Button variant="secondary" disabled={state === 'loading'} onClick={() => void load(next)}>
          {t(locale, 'ki.logs.more')}
        </Button>
      )}
    </div>
  );
}

// ---- findings and inventory -------------------------------------------------------------------------------------------------------
function FindingsSection({
  locale,
  resourceId,
  versionId,
  rev,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  rev: number;
}) {
  const [severity, setSeverity] = useState('');
  const [r, reload] = useRemote<
    Page<IngestFinding> & { summary: Record<string, number> }
  >(async () => {
    const x = await browserApi().GET(
      `${BASE}/versions/{versionId}/findings` as never,
      {
        params: {
          path: { id: resourceId, versionId },
          query: { limit: 100, ...(severity ? { severity } : {}) },
        },
      } as never,
    );
    return { ok: x.response.ok, status: x.response.status, data: (x.data as never) ?? null };
  }, [resourceId, versionId, severity, rev]);
  return (
    <Card aria-label={t(locale, 'ki.findings')}>
      <h2 className="nz-h2">{t(locale, 'ki.findings')}</h2>
      <p className="nz-muted">{t(locale, 'ki.findings.note')}</p>
      <div className="kni-toolbar">
        <Field id="kni-sev" label={t(locale, 'ki.findings.filter')}>
          {(a) => (
            <Select {...a} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">{t(locale, 'ki.sev.all')}</option>
              {(['block', 'warn', 'info'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(locale, `ki.sev.${k}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Frame locale={locale} r={r} reload={reload}>
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState title={t(locale, 'ki.findings')} body={t(locale, 'ki.findings.none')} />
          ) : (
            <Table
              caption={t(locale, 'ki.findings')}
              rows={p.items}
              rowKey={(f) => f.id}
              columns={[
                {
                  key: 'sev',
                  header: t(locale, 'ki.findings.filter'),
                  card: 'badge',
                  render: (f) => (
                    <Badge tone={severityTone(f.severity)}>
                      {t(locale, `ki.sev.${f.severity}` as MessageKey)}
                    </Badge>
                  ),
                },
                {
                  key: 'code',
                  header: t(locale, 'ki.col.finding'),
                  card: 'title',
                  render: (f) => <Ltr>{`${f.scanner}/${f.code}`}</Ltr>,
                },
                {
                  key: 'where',
                  header: t(locale, 'ki.col.where'),
                  card: 'meta',
                  render: (f) =>
                    f.path ? <Ltr>{f.line ? `${f.path}:${f.line}` : f.path}</Ltr> : '—',
                },
                {
                  key: 'detail',
                  header: t(locale, 'ki.col.detail'),
                  card: 'meta',
                  render: (f) => <bdi dir="auto">{f.detail}</bdi>,
                },
              ]}
            />
          )
        }
      </Frame>
    </Card>
  );
}

function FilesSection({
  locale,
  resourceId,
  versionId,
  rev,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  rev: number;
}) {
  const [q, setQ] = useState('');
  const [stored, setStored] = useState('');
  const [r, reload] = useRemote<Page<IngestFile>>(async () => {
    const x = await browserApi().GET(
      `${BASE}/versions/{versionId}/files` as never,
      {
        params: {
          path: { id: resourceId, versionId },
          query: { limit: 100, ...(q ? { q } : {}), ...(stored ? { stored } : {}) },
        },
      } as never,
    );
    return { ok: x.response.ok, status: x.response.status, data: (x.data as never) ?? null };
  }, [resourceId, versionId, q, stored, rev]);
  return (
    <Card aria-label={t(locale, 'ki.files')}>
      <h2 className="nz-h2">{t(locale, 'ki.files')}</h2>
      <p className="nz-muted">{t(locale, 'ki.files.note')}</p>
      <div className="kni-toolbar">
        <Field id="kni-q" label={t(locale, 'ki.files.search')}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              value={q}
              maxLength={100}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
        <Field id="kni-stored" label={t(locale, 'ki.files.filter')}>
          {(a) => (
            <Select {...a} value={stored} onChange={(e) => setStored(e.target.value)}>
              <option value="">{t(locale, 'ki.files.all')}</option>
              <option value="true">{t(locale, 'ki.files.stored')}</option>
              <option value="false">{t(locale, 'ki.files.notStored')}</option>
            </Select>
          )}
        </Field>
      </div>
      <Frame locale={locale} r={r} reload={reload}>
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState title={t(locale, 'ki.files')} body={t(locale, 'ki.files.none')} />
          ) : (
            <Table
              caption={t(locale, 'ki.files')}
              rows={p.items}
              rowKey={(f) => f.id}
              columns={[
                {
                  key: 'path',
                  header: t(locale, 'ki.col.path'),
                  card: 'title',
                  render: (f) => <Ltr>{f.path}</Ltr>,
                },
                {
                  key: 'lang',
                  header: t(locale, 'ki.col.lang'),
                  card: 'meta',
                  render: (f) => (f.language ? <Ltr>{f.language}</Ltr> : '—'),
                },
                {
                  key: 'size',
                  header: t(locale, 'ki.col.size'),
                  card: 'meta',
                  render: (f) => <Ltr>{formatBytes(f.bytes, locale)}</Ltr>,
                },
                {
                  key: 'stored',
                  header: t(locale, 'ki.col.content'),
                  card: 'badge',
                  render: (f) => (
                    <Badge tone={f.stored ? 'success' : 'warn'}>
                      {t(locale, f.stored ? 'ki.files.stored' : 'ki.files.notStored')}
                    </Badge>
                  ),
                },
              ]}
            />
          )
        }
      </Frame>
    </Card>
  );
}

// ---- the detected project (S-K2b) ---------------------------------------------------------------------------------------------------
type ManRoute2 = ProjectManifestView['routes'][number];
const evLine = (e: { path: string; line?: number }) => evidenceText({ kind: '', ...e });
function DetectionRow({ locale, d }: { locale: Locale; d: ManDetection }) {
  return (
    <li>
      <strong>{d.name}</strong>{' '}
      {d.version && (
        <>
          <Ltr>{d.version}</Ltr>{' '}
          <span className="nz-muted">
            ({t(locale, d.versionSource === 'lockfile' ? 'km.src.lockfile' : 'km.src.declared')})
          </span>{' '}
        </>
      )}
      <Badge tone={levelTone(d.level)}>
        {t(locale, `km.level.${d.level}` as MessageKey)} ·{' '}
        <Ltr>{String(Math.round(d.confidence * 100))}%</Ltr>
      </Badge>
      <div className="nz-muted">
        {t(locale, 'km.evidence')}:{' '}
        {d.evidence.slice(0, 3).map((e, i) => (
          <span key={`${e.path}${e.line ?? ''}${i}`}>
            {i > 0 && ', '}
            <Ltr>{evLine(e)}</Ltr>
          </span>
        ))}
      </div>
    </li>
  );
}

function ManifestSection({
  locale,
  resourceId,
  versionId,
  rev,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  rev: number;
}) {
  const [r, reload] = useRemote<{ manifest: ProjectManifestView | null }>(async () => {
    const x = await browserApi().GET(
      `${BASE}/versions/{versionId}/manifest` as never,
      { params: { path: { id: resourceId, versionId } } } as never,
    );
    return { ok: x.response.ok, status: x.response.status, data: (x.data as never) ?? null };
  }, [resourceId, versionId, rev]);
  const [routeLimit, setRouteLimit] = useState(50);
  return (
    <Card aria-label={t(locale, 'km.title')}>
      <h2 className="nz-h2">{t(locale, 'km.title')}</h2>
      <p className="nz-muted">{t(locale, 'km.intro')}</p>
      <Frame locale={locale} r={r} reload={reload}>
        {({ manifest: m }) => {
          if (!m) return <EmptyState title={t(locale, 'km.title')} body={t(locale, 'km.none')} />;
          const pool = m.projects.filter((p) => p.kind !== 'example');
          const shown = new Map<string, ManDetection>();
          for (const p of pool.length ? pool : m.projects)
            for (const d of p.detections)
              if (
                (d.category === 'framework' ||
                  d.category === 'runtime' ||
                  d.category === 'language') &&
                (shown.get(d.id)?.confidence ?? -1) < d.confidence
              )
                shown.set(d.id, d);
          const list = [...shown.values()].sort(
            (a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1),
          );
          const screens = [
            ...m.screens.map((x) => ({ ...x, label: 'km.screen' as MessageKey })),
            ...m.moduleFacts.map((x) => ({
              ...x,
              label: (x.kind === 'nest-controller' ? 'km.controller' : 'km.module') as MessageKey,
            })),
          ];
          return (
            <>
              <h3 className="nz-h3">{t(locale, 'km.frameworks')}</h3>
              {list.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.frameworks.none')}</p>
              ) : (
                <ul className="kni-list">
                  {list.map((d) => (
                    <DetectionRow key={d.id} locale={locale} d={d} />
                  ))}
                </ul>
              )}
              <dl className="kni-facts">
                <div>
                  <dt>{t(locale, 'km.languages')}</dt>
                  <dd>{m.languages.length ? <Ltr>{m.languages.join(', ')}</Ltr> : '—'}</dd>
                </div>
                <div>
                  <dt>{t(locale, 'km.pm')}</dt>
                  <dd>
                    {m.packageManagers.length ? (
                      <Ltr>{m.packageManagers.join(', ')}</Ltr>
                    ) : (
                      t(locale, 'km.pm.none')
                    )}
                  </dd>
                </div>
              </dl>

              <h3 className="nz-h3">{t(locale, 'km.projects')}</h3>
              <Table
                caption={t(locale, 'km.projects')}
                rows={m.projects}
                rowKey={(p: ManProject) => p.root}
                columns={[
                  {
                    key: 'root',
                    header: t(locale, 'km.col.root'),
                    card: 'title',
                    render: (p: ManProject) => <Ltr>{p.root}</Ltr>,
                  },
                  {
                    key: 'kind',
                    header: t(locale, 'km.col.kind'),
                    card: 'badge',
                    render: (p: ManProject) => (
                      <Badge>{t(locale, `km.kind.${p.kind}` as MessageKey)}</Badge>
                    ),
                  },
                  {
                    key: 'roles',
                    header: t(locale, 'km.col.roles'),
                    card: 'meta',
                    render: (p: ManProject) =>
                      p.roles.length
                        ? p.roles
                            .map((x) => t(locale, `km.role.${x.role}` as MessageKey))
                            .join('، ')
                        : '—',
                  },
                  {
                    key: 'det',
                    header: t(locale, 'km.col.detected'),
                    card: 'meta',
                    render: (p: ManProject) => (
                      <Ltr>
                        {p.detections
                          .filter((d) => d.confidence >= 0.5 && d.category !== 'language')
                          .map((d) => d.name)
                          .join(', ') || '—'}
                      </Ltr>
                    ),
                  },
                  {
                    key: 'pm',
                    header: t(locale, 'km.col.pm'),
                    card: 'meta',
                    render: (p: ManProject) =>
                      p.packageManager ? <Ltr>{p.packageManager.name}</Ltr> : '—',
                  },
                ]}
              />

              <h3 className="nz-h3">{t(locale, 'km.workspaces')}</h3>
              {m.workspaces.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.workspaces.none')}</p>
              ) : (
                <ul className="kni-list">
                  {m.workspaces.map((w) => (
                    <li key={`${w.root}${w.tool}`}>
                      <Ltr>{w.tool}</Ltr> · <Ltr>{w.root}</Ltr> ·{' '}
                      {t(locale, 'km.workspaces.members', { n: w.members.length })}:{' '}
                      <Ltr>{w.members.slice(0, 8).join(', ')}</Ltr>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="nz-h3">{t(locale, 'km.capabilities')}</h3>
              {m.capabilities.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.capabilities.none')}</p>
              ) : (
                <ul className="kni-list">
                  {m.capabilities.map((c) => (
                    <li key={c.name}>
                      <Ltr>{c.name}</Ltr>{' '}
                      <Badge
                        tone={levelTone(
                          c.confidence >= 0.8 ? 'high' : c.confidence >= 0.5 ? 'medium' : 'low',
                        )}
                      >
                        <Ltr>{String(Math.round(c.confidence * 100))}%</Ltr>
                      </Badge>{' '}
                      <span className="nz-muted">
                        <Ltr>{c.evidence.slice(0, 2).map(evLine).join(', ')}</Ltr>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="nz-h3">{t(locale, 'km.routes')}</h3>
              <p className="nz-muted">{t(locale, 'km.routes.note')}</p>
              {m.routes.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.routes.none')}</p>
              ) : (
                <>
                  <Table
                    caption={t(locale, 'km.routes')}
                    rows={m.routes.slice(0, routeLimit)}
                    rowKey={(x: ManRoute2) =>
                      `${x.kind}${x.project}${x.path}${x.file}${x.line ?? ''}${x.methods.join()}`
                    }
                    columns={[
                      {
                        key: 'path',
                        header: t(locale, 'km.col.route'),
                        card: 'title',
                        render: (x: ManRoute2) => <Ltr>{x.path}</Ltr>,
                      },
                      {
                        key: 'type',
                        header: t(locale, 'km.col.type'),
                        card: 'badge',
                        render: (x: ManRoute2) => tDynamic(locale, `km.route.${x.kind}`, x.kind),
                      },
                      {
                        key: 'methods',
                        header: t(locale, 'km.col.methods'),
                        card: 'meta',
                        render: (x: ManRoute2) =>
                          x.methods.length ? <Ltr>{x.methods.join(', ')}</Ltr> : '—',
                      },
                      {
                        key: 'file',
                        header: t(locale, 'km.col.file'),
                        card: 'meta',
                        render: (x: ManRoute2) => (
                          <Ltr>{evLine({ path: x.file, line: x.line })}</Ltr>
                        ),
                      },
                    ]}
                  />
                  {m.routes.length > routeLimit && (
                    <Button variant="secondary" onClick={() => setRouteLimit(routeLimit + 100)}>
                      {t(locale, 'km.more')}
                    </Button>
                  )}
                </>
              )}

              <h3 className="nz-h3">{t(locale, 'km.screens')}</h3>
              {screens.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.screens.none')}</p>
              ) : (
                <ul className="kni-list">
                  {screens.slice(0, 60).map((x) => (
                    <li key={`${x.kind}${x.file}${x.line ?? ''}${x.name}`}>
                      <Badge>{t(locale, x.label)}</Badge> <Ltr>{x.name}</Ltr>{' '}
                      <span className="nz-muted">
                        <Ltr>{evLine({ path: x.file, line: x.line })}</Ltr>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="nz-h3">{t(locale, 'km.ambiguities')}</h3>
              {m.ambiguities.length === 0 ? (
                <p className="nz-muted">{t(locale, 'km.ambiguities.none')}</p>
              ) : (
                <ul className="kni-list">
                  {m.ambiguities.map((a) => (
                    <li key={`${a.code}${a.paths.join()}`}>
                      {tDynamic(locale, `km.amb.${a.code}`, a.detail)}{' '}
                      {a.paths.length > 0 && (
                        <span className="nz-muted">
                          <Ltr>{a.paths.slice(0, 3).join(', ')}</Ltr>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {m.stats.truncated.length > 0 && (
                <p className="nz-muted">
                  {t(locale, 'km.truncated')} <Ltr>{m.stats.truncated.join(', ')}</Ltr>
                </p>
              )}
            </>
          );
        }}
      </Frame>
    </Card>
  );
}
