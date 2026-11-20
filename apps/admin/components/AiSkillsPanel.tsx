'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { Note, useStaffAction } from './BillingAdminPanels';

export interface AdminSkill {
  id: string;
  slug: string;
  description: string;
  scope: string;
  status: 'in_review' | 'approved' | 'rejected' | 'disabled';
  owner: 'platform' | 'organization';
  source: { kind: string; repo: string | null };
  currentVersion: {
    semver: string;
    license: string | null;
    executable: boolean;
    scanVerdict: string;
  } | null;
}
interface SkillVersion {
  id: string;
  semver: string;
  sourceCommit: string | null;
  license: string | null;
  executable: boolean;
  reviewState: string;
  scan: {
    verdict: string;
    findings?: { rule: string; severity: string; path: string; line: number; detail: string }[];
  };
  files: { path: string; executable: boolean; bytes: number }[];
}
interface SkillDetail extends AdminSkill {
  versions: SkillVersion[];
  reviews: { reviewerId: string; decision: string; note: string | null; at: string }[];
}

type Api = ReturnType<typeof browserApi>;
const call = (fn: (api: Api) => Promise<{ response: Response; data?: unknown; error?: unknown }>) =>
  fn(browserApi());
const STATUSES = ['in_review', 'approved', 'rejected', 'disabled'] as const;
const tone = (s: string) =>
  s === 'approved' || s === 'clean'
    ? 'success'
    : s === 'rejected' || s === 'reject'
      ? 'danger'
      : 'warn';
const overrides = (locale: Locale) => ({
  403: t(locale, 'ais.adm.err.forbidden'),
  404: t(locale, 'aia.err.notFound'),
  409: t(locale, 'ais.adm.err.conflict'),
  422: t(locale, 'aia.err.refused'),
});

/** The Skills registry: filter by status, import into quarantine, open a skill to review its scan, files and reviews. */
export function SkillsRegistry({
  locale,
  items,
  status,
  canManage,
  canApprove,
  mfaFactorId,
}: {
  locale: Locale;
  items: AdminSkill[];
  status: string | null;
  canManage: boolean;
  canApprove: boolean;
  mfaFactorId: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <nav aria-label={t(locale, 'ais.adm.filter')} className="nz-row" style={{ marginBlock: 12 }}>
        <a className="nz-btn" data-variant={status === null ? 'primary' : 'secondary'} href="?">
          {t(locale, 'ais.adm.all')}
        </a>
        {STATUSES.map((s) => (
          <a
            key={s}
            className="nz-btn"
            data-variant={status === s ? 'primary' : 'secondary'}
            href={`?status=${s}`}
          >
            {t(locale, `ais.adm.status.${s}` as MessageKey)}
          </a>
        ))}
      </nav>
      {canManage && <ImportForm locale={locale} mfaFactorId={mfaFactorId} onImported={setOpen} />}
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'ais.adm.empty.title')}
          body={t(locale, 'ais.adm.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'ais.adm.title')}
          rows={items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'slug',
              header: t(locale, 'ais.adm.skill'),
              card: 'title',
              render: (r) => <Ltr>{r.slug}</Ltr>,
            },
            {
              key: 'status',
              header: t(locale, 'ais.adm.statusCol'),
              card: 'badge',
              render: (r) => (
                <Badge tone={tone(r.status)}>
                  {t(locale, `ais.adm.status.${r.status}` as MessageKey)}
                </Badge>
              ),
            },
            {
              key: 'src',
              header: t(locale, 'ais.adm.source'),
              card: 'meta',
              render: (r) => <Ltr>{r.source.repo ?? r.source.kind}</Ltr>,
            },
            {
              key: 'ver',
              header: t(locale, 'ais.adm.version'),
              card: 'meta',
              render: (r) =>
                r.currentVersion ? (
                  <>
                    <Ltr>{r.currentVersion.semver}</Ltr>{' '}
                    {r.currentVersion.executable && (
                      <Badge tone="warn">{t(locale, 'ais.adm.executable')}</Badge>
                    )}
                  </>
                ) : (
                  '—'
                ),
            },
            {
              key: 'act',
              header: t(locale, 'ais.adm.actions'),
              card: 'footer',
              render: (r) => (
                <Button
                  variant="secondary"
                  onClick={() => setOpen(r.id)}
                  aria-expanded={open === r.id}
                >
                  {t(locale, 'ais.adm.review')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {open && (
        <SkillReview
          key={open}
          locale={locale}
          id={open}
          canManage={canManage}
          canApprove={canApprove}
          mfaFactorId={mfaFactorId}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function ImportForm({
  locale,
  mfaFactorId,
  onImported,
}: {
  locale: Locale;
  mfaFactorId: string | null;
  onImported: (id: string) => void;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('main');
  const [path, setPath] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(
      () =>
        call((api) =>
          api.POST('/v1/admin/ai/skills/import', {
            body: { github: { repo: repo.trim(), ref: ref.trim(), path: path.trim() } },
          }),
        ),
      (d) => {
        a.setNotice({ tone: 'ok', text: t(locale, 'ais.adm.imported') });
        router.refresh();
        const id = (d as { skillId?: string } | undefined)?.skillId;
        if (id) onImported(id);
      },
      overrides(locale),
    );
  };
  return (
    <section aria-labelledby="ais-imp" style={{ marginBlockEnd: 16 }}>
      <h2 className="nz-h2" id="ais-imp">
        {t(locale, 'ais.adm.import')}
      </h2>
      <p className="nz-muted">{t(locale, 'ais.adm.importHelp')}</p>
      <form
        onSubmit={submit}
        className="nz-row"
        style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <Field id="ais-repo" label={t(locale, 'ais.adm.repo')}>
          {(f) => (
            <Input
              {...f}
              dir="ltr"
              placeholder="owner/repository"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              required
            />
          )}
        </Field>
        <Field id="ais-ref" label={t(locale, 'ais.adm.ref')}>
          {(f) => (
            <Input {...f} dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} required />
          )}
        </Field>
        <Field id="ais-path" label={t(locale, 'ais.adm.path')}>
          {(f) => (
            <Input
              {...f}
              dir="ltr"
              placeholder="skills/my-skill"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={a.busy || !repo}>
          {t(locale, 'ais.adm.importBtn')}
        </Button>
      </form>
      <Note n={a.notice} />
      {a.panel}
    </section>
  );
}

function SkillReview({
  locale,
  id,
  canManage,
  canApprove,
  mfaFactorId,
  onClose,
}: {
  locale: Locale;
  id: string;
  canManage: boolean;
  canApprove: boolean;
  mfaFactorId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [d, setD] = useState<SkillDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => {
    if (loaded) return;
    void call((api) => api.GET('/v1/admin/ai/skills/{id}', { params: { path: { id } } })).then(
      (r) => {
        setLoaded(true);
        if (r.response.ok) setD(r.data as SkillDetail);
      },
    );
  }, [id, loaded]);
  if (!d)
    return (
      <p role="status" aria-busy={!loaded} className="nz-muted">
        {t(locale, loaded ? 'aia.err.notFound' : 'state.loading')}
      </p>
    );
  const v = d.versions[0];
  const review = (decision: 'approve' | 'reject') =>
    void a.run(
      () =>
        call((api) =>
          api.POST('/v1/admin/ai/skills/versions/{versionId}/reviews', {
            params: { path: { versionId: v!.id } },
            body: { decision, ...(note ? { note } : {}) },
          }),
        ),
      (r) => {
        const st = (r as { state?: string; approvals?: number; needed?: number } | undefined) ?? {};
        a.setNotice({
          tone: 'ok',
          text:
            st.state === 'pending'
              ? t(locale, 'ais.adm.pendingSecond', {
                  n: String(st.approvals ?? 0),
                  of: String(st.needed ?? 2),
                })
              : t(locale, 'ais.adm.reviewed'),
        });
        setNote('');
        setLoaded(false);
        router.refresh();
      },
      overrides(locale),
    );
  const setStatus = (status: 'disabled' | 'approved') =>
    void a.run(
      () =>
        call((api) =>
          api.POST('/v1/admin/ai/skills/{id}/status', {
            params: { path: { id } },
            body: { status },
          }),
        ),
      () => {
        setLoaded(false);
        router.refresh();
      },
      overrides(locale),
    );
  return (
    <section
      aria-labelledby="ais-rev"
      className="nzc-card"
      style={{ marginBlockStart: 16, padding: 18, display: 'grid', gap: 10 }}
    >
      <div className="nz-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="nz-h2" id="ais-rev" style={{ margin: 0 }}>
          <Ltr>{d.slug}</Ltr>{' '}
          <Badge tone={tone(d.status)}>
            {t(locale, `ais.adm.status.${d.status}` as MessageKey)}
          </Badge>
        </h2>
        <Button variant="secondary" onClick={onClose}>
          {t(locale, 'ais.adm.close')}
        </Button>
      </div>
      <p>
        <bdi dir="auto">{d.description}</bdi>
      </p>
      {v && (
        <>
          <dl className="ais-dl">
            <dt>{t(locale, 'ais.adm.version')}</dt>
            <dd>
              <Ltr>{v.semver}</Ltr> <Badge tone={tone(v.reviewState)}>{v.reviewState}</Badge>
            </dd>
            <dt>{t(locale, 'ais.adm.commit')}</dt>
            <dd>
              <Ltr>{v.sourceCommit ?? '—'}</Ltr>
            </dd>
            <dt>{t(locale, 'ais.adm.license')}</dt>
            <dd>
              {v.license ? (
                <Ltr>{v.license}</Ltr>
              ) : (
                <Badge tone="danger">{t(locale, 'ais.adm.noLicense')}</Badge>
              )}
            </dd>
            <dt>{t(locale, 'ais.adm.scan')}</dt>
            <dd>
              <Badge tone={tone(v.scan.verdict)}>{v.scan.verdict}</Badge>{' '}
              {v.executable && <Badge tone="warn">{t(locale, 'ais.adm.executableTwo')}</Badge>}
            </dd>
          </dl>
          {(v.scan.findings ?? []).length > 0 && (
            <ul>
              {(v.scan.findings ?? []).map((f, i) => (
                <li key={i}>
                  <Badge
                    tone={
                      f.severity === 'reject'
                        ? 'danger'
                        : f.severity === 'review'
                          ? 'warn'
                          : undefined
                    }
                  >
                    {f.severity}
                  </Badge>{' '}
                  <Ltr>
                    {f.path}:{f.line}
                  </Ltr>{' '}
                  {f.detail}
                </li>
              ))}
            </ul>
          )}
          <h3 className="nz-h2">{t(locale, 'ais.adm.files')}</h3>
          <ul>
            {v.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="nz-btn"
                  data-variant="secondary"
                  onClick={() =>
                    void call((api) =>
                      api.GET('/v1/admin/ai/skills/versions/{versionId}/file', {
                        params: { path: { versionId: v.id }, query: { path: f.path } },
                      }),
                    ).then(
                      (r) => r.response.ok && setFile(r.data as { path: string; content: string }),
                    )
                  }
                >
                  <Ltr>{f.path}</Ltr>
                </button>{' '}
                <span className="nz-muted">{f.bytes} B</span>{' '}
                {f.executable && <Badge tone="warn">{t(locale, 'ais.adm.executable')}</Badge>}
              </li>
            ))}
          </ul>
          {file && (
            <pre
              dir="ltr"
              style={{ maxBlockSize: 360, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}
              aria-label={file.path}
            >
              {file.content}
            </pre>
          )}
          {d.reviews.length > 0 && (
            <>
              <h3 className="nz-h2">{t(locale, 'ais.adm.reviews')}</h3>
              <ul>
                {d.reviews.map((r, i) => (
                  <li key={i}>
                    <Badge tone={r.decision === 'approve' ? 'success' : 'danger'}>
                      {r.decision}
                    </Badge>{' '}
                    <Ltr>{r.reviewerId.slice(0, 8)}</Ltr> {r.note && <bdi dir="auto">{r.note}</bdi>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {canApprove && v.reviewState === 'pending' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <Field
                id="ais-note"
                label={t(locale, 'ais.adm.note')}
                help={t(locale, 'ais.adm.noteHelp')}
              >
                {(f) => (
                  <Input
                    {...f}
                    dir="auto"
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>
              <div className="nz-row">
                <Button disabled={a.busy} onClick={() => review('approve')}>
                  {t(locale, 'ais.adm.approve')}
                </Button>
                <Button variant="danger" disabled={a.busy} onClick={() => review('reject')}>
                  {t(locale, 'ais.adm.reject')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {canManage && d.status === 'approved' && (
        <Button variant="danger" disabled={a.busy} onClick={() => setStatus('disabled')}>
          {t(locale, 'ais.adm.disable')}
        </Button>
      )}
      {canManage && d.status === 'disabled' && (
        <Button variant="secondary" disabled={a.busy} onClick={() => setStatus('approved')}>
          {t(locale, 'ais.adm.enable')}
        </Button>
      )}
      <Note n={a.notice} />
      {a.panel}
    </section>
  );
}
