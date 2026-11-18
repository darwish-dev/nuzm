'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Ltr } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  downloadValid,
  exportTone,
  safeHref,
  safeText,
  settle,
  type ApprovalRef,
  type ExportRow,
} from '../lib/appbuilder';
import { newKey } from '../lib/data';
import { Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { ApprovalNeeded } from './ApprovalNeeded';
import { Note } from './DataUi';

const POLL_MS = 3000;

/** Blocked reasons: the rule and the path only (never file content). */
export function BlockedReasons({ locale, row }: { locale: Locale; row: ExportRow }) {
  const reasons = row.blockedReasons ?? [];
  if (reasons.length === 0) return null;
  return (
    <div role="alert">
      <p className="nz-error-text">{t(locale, 'm10.exp.blocked')}</p>
      <ul>
        {reasons.map((r, i) => (
          <li key={i}>
            {t(locale, 'm10.exp.rule')}: <Ltr>{safeText(r.rule, 80) || '—'}</Ltr>
            {r.path ? (
              <>
                {' · '}
                {t(locale, 'm10.exp.path')}: <Ltr>{safeText(r.path, 200)}</Ltr>
                {typeof r.line === 'number' ? <Ltr>{`:${r.line}`}</Ltr> : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * UI-M10-10: exports of a project. A ready export shows its sha256, SBOM reference and size; the download link exists only while the signed URL is valid (at
 * most 15 minutes; reading the export again issues a fresh one) and its expiry is shown. A blocked export lists the rule and the path of each reason.
 */
export function Exports({
  locale,
  projectId,
  initial,
  canExport,
  mfaFactorId,
}: {
  locale: Locale;
  projectId: string;
  initial: ExportRow[];
  canExport: boolean;
  mfaFactorId: string | null;
}) {
  const call = useBuilderCall(locale, mfaFactorId);
  const [items, setItems] = useState<ExportRow[]>(initial);
  const [needed, setNeeded] = useState<ApprovalRef[]>([]);
  const [key, setKey] = useState(newKey());
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  // the expiry of a signed URL is re-evaluated every 15 s so a stale link disappears by itself
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const building = items.some((e) => e.status === 'building');
  useEffect(() => {
    alive.current = true;
    if (!building) return;
    const id = setTimeout(async () => {
      const r = await settle(() =>
        browserApi().GET('/v1/builder/projects/{projectId}/exports', {
          params: { path: { projectId } },
        }),
      );
      if (!alive.current) return;
      if (r.response.ok && r.data) setItems((r.data as { items: ExportRow[] }).items);
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
  }, [building, tick]);

  function request() {
    setNeeded([]);
    void call.run(
      () =>
        browserApi().POST('/v1/builder/projects/{projectId}/exports', {
          params: { path: { projectId }, header: { 'Idempotency-Key': key } },
          body: {},
        }),
      (e) => {
        setKey(newKey());
        const x = e as ExportRow;
        setItems((cur) => [x, ...cur.filter((c) => c.id !== x.id)]);
      },
      (f) => {
        setKey(newKey());
        if (f.problem.code === 'approval_required') {
          setNeeded(f.approvals);
          return true;
        }
        if (f.problem.code === 'export_blocked') {
          // the blocked export is a row of its own: reload the list to show its reasons
          void settle(() =>
            browserApi().GET('/v1/builder/projects/{projectId}/exports', {
              params: { path: { projectId } },
            }),
          ).then((r) => {
            if (r.response.ok && r.data) setItems((r.data as { items: ExportRow[] }).items);
          });
        }
      },
    );
  }

  async function refreshLink(id: string) {
    const r = await settle(() =>
      browserApi().GET('/v1/builder/projects/{projectId}/exports/{exportId}', {
        params: { path: { projectId, exportId: id } },
      }),
    );
    if (r.response.ok && r.data) {
      const x = r.data as ExportRow;
      setItems((cur) => cur.map((c) => (c.id === x.id ? x : c)));
      setNow(Date.now());
    }
  }

  return (
    <>
      {canExport ? (
        <p>
          <Button disabled={call.busy} onClick={request}>
            {t(locale, 'm10.exp.request')}
          </Button>
        </p>
      ) : (
        <p className="nz-muted">{t(locale, 'm10.exp.noPermission')}</p>
      )}
      <p className="nz-muted">{t(locale, 'm10.exp.help')}</p>
      {needed.length > 0 && <ApprovalNeeded locale={locale} items={needed} />}
      <Note n={call.notice} />
      {items.length === 0 ? (
        <EmptyState title={t(locale, 'm10.exp.empty')} body={t(locale, 'm10.exp.emptyBody')} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
          {items.map((e) => {
            const link = downloadValid(e, now) ? safeHref(e.downloadUrl) : undefined;
            return (
              <li key={e.id}>
                <section
                  className="nz-card"
                  aria-label={`${t(locale, 'm10.exp.title')} ${e.id.slice(0, 8)}`}
                >
                  <div className="nz-row">
                    <strong>
                      <Ltr>{e.id.slice(0, 8)}</Ltr>
                    </strong>
                    <Badge tone={exportTone(e.status)}>
                      <Word locale={locale} prefix="m10.exp.status" value={e.status} />
                    </Badge>
                  </div>
                  <dl>
                    {e.createdAt && (
                      <>
                        <dt>{t(locale, 'field.created')}</dt>
                        <dd>{formatDateTime(e.createdAt, locale)}</dd>
                      </>
                    )}
                    {e.sha256 && (
                      <>
                        <dt>SHA-256</dt>
                        <dd>
                          <Ltr>{e.sha256}</Ltr>
                        </dd>
                      </>
                    )}
                    {e.sbomRef && (
                      <>
                        <dt>{t(locale, 'm10.exp.sbom')}</dt>
                        <dd>
                          <Ltr>{e.sbomRef}</Ltr>
                        </dd>
                      </>
                    )}
                    {typeof e.sizeBytes === 'number' && (
                      <>
                        <dt>{t(locale, 'm10.exp.size')}</dt>
                        <dd>
                          <Ltr>{`${e.sizeBytes} B`}</Ltr>
                          {typeof e.fileCount === 'number'
                            ? ` · ${t(locale, 'm10.exp.files', { n: e.fileCount })}`
                            : ''}
                        </dd>
                      </>
                    )}
                  </dl>
                  {e.status === 'building' && <p role="status">{t(locale, 'm10.exp.building')}</p>}
                  <BlockedReasons locale={locale} row={e} />
                  {e.status === 'ready' && canExport && (
                    <p>
                      {link ? (
                        <>
                          <a className="nz-btn" href={link} rel="noreferrer noopener">
                            {t(locale, 'm10.exp.download')}
                          </a>{' '}
                          {e.downloadUrlExpiresAt && (
                            <span className="nz-muted">
                              {t(locale, 'm10.exp.linkExpires', {
                                time: formatDateTime(e.downloadUrlExpiresAt, locale),
                              })}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <Banner tone="warn">{t(locale, 'm10.exp.linkGone')}</Banner>
                          <Button variant="secondary" onClick={() => void refreshLink(e.id)}>
                            {t(locale, 'm10.exp.newLink')}
                          </Button>
                        </>
                      )}
                    </p>
                  )}
                </section>
              </li>
            );
          })}
        </ul>
      )}
      {call.panel}
    </>
  );
}
