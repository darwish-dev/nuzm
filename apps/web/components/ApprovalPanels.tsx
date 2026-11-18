'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, Select, Skeleton, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  APPROVAL_ROLES,
  APPROVAL_STATUSES,
  approvalLapsed,
  approvalTone,
  decisionErrorKey,
  prettyJson,
  problemOf,
  settle,
  type Approval,
  type ApprovalType,
} from '../lib/builder';
import { newKey } from '../lib/data';
import { Code, TextArea, Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { ConfirmDialog, Note } from './DataUi';

/** An approval as far as the screen knows it: the run viewer only has `{id,type,scopeHash,expiresAt}` and loads the exact action on demand. */
export interface ApprovalLite {
  id: string;
  type?: string;
  scopeHash: string;
  expiresAt?: string;
  action?: Record<string, unknown>;
  status?: string;
}

const roleNames = (locale: Locale, type: string | undefined): string =>
  (APPROVAL_ROLES[type as ApprovalType] ?? [])
    .map((r) => tDynamic(locale, `role.${r}`, r))
    .join(locale === 'ar' ? '، ' : ', ');

/** The exact action an approval is bound to (JSON, secrets masked), its hash and its expiry. Nothing is decided on a summary. */
export function ApprovalFacts({ locale, a }: { locale: Locale; a: ApprovalLite }) {
  return (
    <>
      <dl>
        <dt>{t(locale, 'm10.apr.col.type')}</dt>
        <dd>
          <Word locale={locale} prefix="m10.apr.type" value={a.type ?? ''} />
        </dd>
        <dt>{t(locale, 'm10.apr.scopeHash')}</dt>
        <dd>
          <Ltr>{a.scopeHash}</Ltr>
        </dd>
        {a.expiresAt && (
          <>
            <dt>{t(locale, 'm10.apr.expires')}</dt>
            <dd>{formatDateTime(a.expiresAt, locale)}</dd>
          </>
        )}
        <dt>{t(locale, 'm10.apr.roles')}</dt>
        <dd>{roleNames(locale, a.type) || '—'}</dd>
      </dl>
      <h3 className="nz-h3">{t(locale, 'm10.apr.action')}</h3>
      {a.action ? (
        <Code label={t(locale, 'm10.apr.action')}>{prettyJson(a.action)}</Code>
      ) : (
        <p className="nz-muted">{t(locale, 'm10.apr.actionUnknown')}</p>
      )}
    </>
  );
}

/**
 * Approve / reject one approval. A confirmation dialog quotes the type, the exact action and the scopeHash the decision is bound to (a decision is sent
 * with that hash, so an approval whose action changed answers 409 and has to be reviewed again). Approving is disabled while the action cannot be shown.
 */
export function ApprovalDecision({
  locale,
  mfaFactorId,
  approval,
  canDecide,
  runId,
  onDecided,
}: {
  locale: Locale;
  mfaFactorId: string | null;
  approval: ApprovalLite;
  canDecide: boolean;
  /** Decide through the run (`POST /v1/ai/runs/{id}/approvals`) instead of the approvals route. */
  runId?: string;
  onDecided: (decision: 'approve' | 'reject', a: Approval) => void;
}) {
  const call = useBuilderCall(locale, mfaFactorId);
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [detail, setDetail] = useState<ApprovalLite>(approval);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey());
  const [reviewAgain, setReviewAgain] = useState(false);

  async function load() {
    setLoading(true);
    setLoadFailed(false);
    const r = await settle(() =>
      browserApi().GET('/v1/ai/approvals/{approvalId}', {
        params: { path: { approvalId: approval.id } },
      }),
    );
    setLoading(false);
    if (r.response.ok && r.data) {
      const d = r.data as Approval;
      setDetail({
        id: d.id,
        type: d.type,
        scopeHash: d.scopeHash,
        expiresAt: d.expiresAt,
        action: d.action,
        status: d.status,
      });
      return true;
    }
    setLoadFailed(true);
    return false;
  }

  function open(m: 'approve' | 'reject') {
    setMode(m);
    setNote('');
    setReviewAgain(false);
    setKey(newKey());
    call.setNotice(null);
    setDetail(approval);
    if (!approval.action) void load();
  }

  function decide() {
    if (!mode) return;
    const body = {
      decision: mode,
      scopeHash: detail.scopeHash,
      ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
    };
    void call.run(
      () =>
        runId
          ? browserApi().POST('/v1/ai/runs/{id}/approvals', {
              params: { path: { id: runId }, header: { 'Idempotency-Key': key } },
              body: { approvalId: approval.id, ...body },
            })
          : browserApi().POST('/v1/ai/approvals/{approvalId}/decisions', {
              params: { path: { approvalId: approval.id }, header: { 'Idempotency-Key': key } },
              body,
            }),
      (a) => {
        const m = mode;
        setMode(null);
        onDecided(m, a as Approval);
      },
      (f) => {
        const k = decisionErrorKey(f.problem.status, f.problem.code);
        call.setNotice({ tone: 'error', text: t(locale, k) });
        if (f.problem.code === 'stale_approval_hash') {
          // the action changed under the approval: show the new one and make the person look again
          setKey(newKey());
          setReviewAgain(true);
          void load();
        }
        return true;
      },
    );
  }

  if (!canDecide) return <p className="nz-muted">{t(locale, 'm10.apr.cannotDecide')}</p>;
  const lapsed = detail.expiresAt
    ? approvalLapsed({ status: 'pending', expiresAt: detail.expiresAt })
    : false;
  const titleKey = mode === 'reject' ? 'm10.apr.rejectTitle' : 'm10.apr.approveTitle';
  const actionKnown = detail.action !== undefined;
  return (
    <>
      <div className="nz-row">
        <Button variant="primary" onClick={() => open('approve')}>
          {t(locale, 'm10.apr.approve')}
        </Button>
        <Button variant="danger" onClick={() => open('reject')}>
          {t(locale, 'm10.apr.reject')}
        </Button>
      </div>
      <ConfirmDialog open={mode !== null} title={t(locale, titleKey)} onClose={() => setMode(null)}>
        <p>{t(locale, mode === 'reject' ? 'm10.apr.rejectBody' : 'm10.apr.approveBody')}</p>
        {loading ? (
          <Skeleton lines={3} label={t(locale, 'state.loading')} />
        ) : (
          <ApprovalFacts locale={locale} a={detail} />
        )}
        {loadFailed && (
          <p role="alert" className="nz-error-text">
            {t(locale, 'm10.apr.actionLoadFailed')}{' '}
            <Button variant="secondary" onClick={() => void load()}>
              {t(locale, 'action.retry')}
            </Button>
          </p>
        )}
        {reviewAgain && <Banner tone="warn">{t(locale, 'm10.apr.reviewAgain')}</Banner>}
        {lapsed && <Banner tone="warn">{t(locale, 'm10.apr.err.expired')}</Banner>}
        <Field
          id={`apr-note-${approval.id}`}
          label={t(locale, 'm10.apr.note')}
          help={t(locale, 'm10.apr.noteHelp')}
        >
          {(x) => (
            <TextArea
              {...x}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
        <Note n={call.notice} />
        <div className="nz-row">
          <Button
            variant={mode === 'reject' ? 'danger' : 'primary'}
            disabled={
              call.busy ||
              loading ||
              lapsed ||
              (mode === 'approve' && (!actionKnown || reviewAgain))
            }
            onClick={decide}
          >
            {t(locale, mode === 'reject' ? 'm10.apr.confirmReject' : 'm10.apr.confirmApprove')}
          </Button>
          {reviewAgain && !loading && actionKnown && (
            <Button variant="secondary" onClick={() => setReviewAgain(false)}>
              {t(locale, 'm10.apr.reviewed')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setMode(null)}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
      </ConfirmDialog>
      {call.panel}
    </>
  );
}

/** Pending approvals of one run, each with its decision controls. Used on the run viewer and after a deployment answered `approval_required`. */
export function PendingApprovals({
  locale,
  mfaFactorId,
  items,
  canDecide,
  runId,
  onDecided,
}: {
  locale: Locale;
  mfaFactorId: string | null;
  items: ApprovalLite[];
  canDecide: boolean;
  runId?: string;
  onDecided: (decision: 'approve' | 'reject', a: Approval) => void;
}) {
  if (items.length === 0) return <p className="nz-muted">{t(locale, 'm10.run.noApprovals')}</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
      {items.map((a) => (
        <li key={a.id}>
          <section
            className="nz-card"
            aria-label={tDynamic(locale, `m10.apr.type.${a.type}`, a.type ?? '')}
          >
            <h3 className="nz-h3">
              <Word locale={locale} prefix="m10.apr.type" value={a.type ?? ''} />
            </h3>
            <ApprovalFacts locale={locale} a={a} />
            <ApprovalDecision
              locale={locale}
              mfaFactorId={mfaFactorId}
              approval={a}
              canDecide={canDecide}
              runId={runId}
              onDecided={onDecided}
            />
          </section>
        </li>
      ))}
    </ul>
  );
}

/** Side drawer on the native `<dialog>` (focus trapped, Escape closes). Content is rendered only while open. */
function Drawer(p: {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (p.open && !d.open) d.showModal();
    if (!p.open && d.open) d.close();
  }, [p.open]);
  return (
    <dialog
      ref={ref}
      aria-label={p.title}
      onClose={p.onClose}
      onCancel={p.onClose}
      className="nz-card"
      style={{
        marginBlock: 0,
        marginInlineStart: 'auto',
        marginInlineEnd: 0,
        blockSize: '100dvh',
        maxBlockSize: '100dvh',
        inlineSize: 'min(560px, 96vw)',
        overflow: 'auto',
      }}
    >
      {p.open && (
        <>
          <div className="nz-row">
            <h2 className="nz-h2">{p.title}</h2>
          </div>
          {p.children}
          <p>
            <Button variant="secondary" onClick={p.onClose}>
              {p.closeLabel}
            </Button>
          </p>
        </>
      )}
    </dialog>
  );
}

/**
 * UI-M10-07: the approvals inbox across runs, deployments, exports and releases. Filter by status; a row opens a drawer with the exact action JSON and the expiry
 * (24 h). A decision goes to `POST /v1/ai/approvals/{id}/decisions` (bound to the scopeHash).
 */
export function ApprovalsInbox({
  locale,
  initial,
  canDecide,
  mfaFactorId,
}: {
  locale: Locale;
  initial: Approval[];
  canDecide: boolean;
  mfaFactorId: string | null;
}) {
  const [items, setItems] = useState<Approval[]>(initial);
  const [status, setStatus] = useState<string>('pending');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const first = useRef(true);

  async function load(s: string) {
    setLoading(true);
    setError(null);
    const r = await settle(() =>
      browserApi().GET('/v1/ai/approvals', {
        params: { query: s ? { status: s as Approval['status'] } : {} },
      }),
    );
    setLoading(false);
    if (r.response.ok && r.data) return setItems((r.data as { items: Approval[] }).items);
    const p = problemOf(r);
    setError(
      p.status === 0
        ? t(locale, 'm10.err.offline')
        : p.status === 403
          ? t(locale, 'state.forbidden.title')
          : p.status === 404
            ? t(locale, 'm10.err.notEnabledOrMissing')
            : t(locale, 'state.error.title'),
    );
  }
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(status);
  }, [status]);

  return (
    <>
      <div className="nz-row">
        <Field id="apr-status" label={t(locale, 'm10.apr.filter')}>
          {(x) => (
            <Select {...x} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t(locale, 'm10.apr.statusAll')}</option>
              {APPROVAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(locale, `m10.apr.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button variant="secondary" disabled={loading} onClick={() => void load(status)}>
          {t(locale, 'm10.apr.reload')}
        </Button>
      </div>
      {done && (
        <p role="status" className="nz-muted">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="nz-error-text">
          {error}
        </p>
      )}
      {loading ? (
        <Skeleton lines={4} label={t(locale, 'state.loading')} />
      ) : items.length === 0 ? (
        <EmptyState title={t(locale, 'm10.apr.empty')} body={t(locale, 'm10.apr.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm10.apr.title')}
          rows={items}
          rowKey={(a) => a.id}
          columns={[
            {
              key: 't',
              header: t(locale, 'm10.apr.col.type'),
              render: (a) => (
                <button
                  type="button"
                  className="nz-btn"
                  data-variant="secondary"
                  onClick={() => setSelected(a)}
                  aria-label={t(locale, 'm10.apr.open', {
                    type: tDynamic(locale, `m10.apr.type.${a.type}`, a.type),
                  })}
                >
                  <Word locale={locale} prefix="m10.apr.type" value={a.type} />
                </button>
              ),
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (a) => {
                const lapsed = a.status === 'pending' && approvalLapsed(a);
                return (
                  <Badge tone={approvalTone(lapsed ? 'expired' : a.status)}>
                    {t(locale, `m10.apr.status.${lapsed ? 'expired' : a.status}`)}
                  </Badge>
                );
              },
            },
            {
              key: 'k',
              header: t(locale, 'm10.apr.col.subject'),
              render: (a) => (
                <>
                  {a.subjectType ? (
                    <Word locale={locale} prefix="m10.apr.subject" value={a.subjectType} />
                  ) : (
                    '—'
                  )}
                  {a.subjectId ? (
                    <>
                      {' '}
                      <Ltr>{a.subjectId.slice(0, 8)}</Ltr>
                    </>
                  ) : null}
                </>
              ),
            },
            {
              key: 'r',
              header: t(locale, 'm10.apr.col.requester'),
              render: (a) =>
                a.requestedByKind ? (
                  <Word locale={locale} prefix="m10.apr.requester" value={a.requestedByKind} />
                ) : (
                  '—'
                ),
            },
            {
              key: 'e',
              header: t(locale, 'm10.apr.expires'),
              render: (a) => formatDateTime(a.expiresAt, locale),
            },
          ]}
        />
      )}
      <Drawer
        open={selected !== null}
        title={selected ? tDynamic(locale, `m10.apr.type.${selected.type}`, selected.type) : ''}
        onClose={() => setSelected(null)}
        closeLabel={t(locale, 'm10.apr.close')}
      >
        {selected && (
          <>
            <p>
              <Badge tone={approvalTone(selected.status)}>
                {t(locale, `m10.apr.status.${selected.status}`)}
              </Badge>
            </p>
            <ApprovalFacts locale={locale} a={selected} />
            {selected.decisionNote && (
              <p>
                {t(locale, 'm10.apr.decisionNote')}: <bdi dir="auto">{selected.decisionNote}</bdi>
              </p>
            )}
            {selected.status === 'pending' ? (
              <ApprovalDecision
                locale={locale}
                mfaFactorId={mfaFactorId}
                approval={selected}
                canDecide={canDecide}
                onDecided={(d, a) => {
                  setSelected(null);
                  setItems((xs) => xs.map((x) => (x.id === a.id ? { ...x, ...a } : x)));
                  setDone(t(locale, d === 'approve' ? 'm10.apr.approved' : 'm10.apr.rejected'));
                }}
              />
            ) : (
              <p className="nz-muted">{t(locale, 'm10.apr.alreadyDecided')}</p>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
