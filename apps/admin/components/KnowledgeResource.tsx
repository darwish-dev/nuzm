'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale, type MessageKey } from '@nuzm/i18n';
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
  Table,
} from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  PLATFORMS,
  REUSE_SCOPES,
  VISIBILITIES,
  formatBytes,
  licenseTone,
  splitList,
  statusTone,
  type KnowledgeDetail,
  type KnowledgeVersion,
} from '../lib/knowledge';
import { KnowledgeUpload } from './KnowledgeUpload';

type Notice = { tone: 'ok' | 'error'; text: string } | null;
const yn = (locale: Locale, v: boolean) => t(locale, v ? 'kn.d.yes' : 'kn.d.no');

/** One library resource (SCR-K-01): facts, permissions, analysis state, versions, an edit form with optimistic concurrency, and the disable / archive actions. */
export function KnowledgeResource({
  locale,
  detail: initial,
  versions,
  canManage,
  canPublish,
}: {
  locale: Locale;
  detail: KnowledgeDetail;
  versions: KnowledgeVersion[];
  canManage: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'disable' | 'archive'>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const perms = d.permissions;
  const retired = d.status === 'ARCHIVED';

  const fail = (status: number) =>
    setNotice({
      tone: 'error',
      text: t(
        locale,
        status === 403
          ? 'kn.err.forbidden'
          : status === 404
            ? 'kn.err.notFound'
            : status === 409
              ? 'kn.err.conflict'
              : status === 422
                ? 'kn.err.refused'
                : 'kn.err.generic',
      ),
    });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const val = (n: string) =>
      String((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
    const checked = (n: string) =>
      (f.elements.namedItem(n) as HTMLInputElement | null)?.checked === true;
    const body: Record<string, unknown> = {};
    if (val('name') !== d.name) body.name = val('name');
    if (val('description') !== (d.description ?? '')) body.description = val('description') || null;
    if (val('category') !== (d.category ?? '')) body.category = val('category') || null;
    const tags = splitList(val('tags'));
    if (tags.join('|') !== d.tags.join('|')) body.tags = tags;
    const frameworks = splitList(val('frameworks'));
    if (frameworks.join('|') !== d.frameworks.join('|')) body.frameworks = frameworks;
    if (val('platform') !== (d.platform ?? '')) body.platform = val('platform') || null;
    if (canPublish && val('visibility') && val('visibility') !== d.visibility)
      body.visibility = val('visibility');
    if (canPublish && checked('defaultEligible') !== d.defaultEligible)
      body.defaultEligible = checked('defaultEligible');
    const p: Record<string, unknown> = {};
    if (perms) {
      if (val('reuseScope') !== perms.reuseScope) p.reuseScope = val('reuseScope');
      for (const k of ['componentReuse', 'starterEligible', 'architectureReference'] as const)
        if (checked(k) !== perms[k]) p[k] = checked(k);
      if (canPublish && checked('aiProcessing') !== perms.aiProcessing)
        p.aiProcessing = checked('aiProcessing');
    }
    if (Object.keys(p).length) body.permissions = p;
    if (!Object.keys(body).length)
      return setNotice({ tone: 'ok', text: t(locale, 'kn.d.noChange') });
    setBusy(true);
    setNotice(null);
    const r = await browserApi().PATCH('/v1/admin/knowledge/resources/{id}', {
      params: { path: { id: d.id }, header: { 'If-Match': `"${d.version}"` } },
      body: body as never,
    });
    setBusy(false);
    if (!r.response.ok) return fail(r.response.status);
    setD(r.data as unknown as KnowledgeDetail);
    setNotice({ tone: 'ok', text: t(locale, 'kn.d.saved') });
    router.refresh();
  }

  async function retire(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(
      (e.currentTarget.elements.namedItem('reason') as HTMLInputElement).value,
    ).trim();
    if (!reason) return setReasonError(t(locale, 'kn.d.reasonRequired'));
    setReasonError(null);
    setBusy(true);
    const api = browserApi();
    const path = {
      params: { path: { id: d.id }, header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: { reason } as never,
    };
    const r =
      confirm === 'archive'
        ? await api.POST('/v1/admin/knowledge/resources/{id}/archival', path)
        : await api.POST('/v1/admin/knowledge/resources/{id}/deactivation', path);
    setBusy(false);
    if (!r.response.ok) return fail(r.response.status);
    if (confirm === 'archive') {
      router.push(`/${locale}/ai-intelligence/library`);
      return;
    }
    setD({ ...d, status: 'DISABLED', visibility: 'PLATFORM_PRIVATE', defaultEligible: false });
    setConfirm(null);
    setNotice({ tone: 'ok', text: t(locale, 'kn.d.disabled') });
    router.refresh();
  }

  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );

  return (
    <div className="knd">
      <p>
        <a href={`/${locale}/ai-intelligence/library`}>{t(locale, 'kn.d.back')}</a>
      </p>
      <div className="knd-head">
        <div>
          <h1 className="nz-h1">
            <bdi dir="auto">{d.name}</bdi>
          </h1>
          {d.description && (
            <p className="nz-muted">
              <bdi dir="auto">{d.description}</bdi>
            </p>
          )}
        </div>
        <div className="nz-row">
          <Badge tone={statusTone(d.status)}>
            {t(locale, `kn.status.${d.status}` as MessageKey)}
          </Badge>
          <Badge>{t(locale, `kn.type.${d.resourceType}` as MessageKey)}</Badge>
          <Badge>{t(locale, `kn.vis.${d.visibility}` as MessageKey)}</Badge>
        </div>
      </div>
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'nz-error-text' : ''}
        >
          {notice.text}
        </p>
      )}
      {canManage && !retired && (
        <KnowledgeUpload
          locale={locale}
          resource={{ id: d.id, name: d.name, resourceType: d.resourceType }}
        />
      )}

      <div className="knd-grid">
        <Card aria-label={t(locale, 'kn.d.overview')}>
          <h2 className="nz-h2">{t(locale, 'kn.d.overview')}</h2>
          <dl>
            {row(t(locale, 'kn.d.slug'), <Ltr>{d.slug}</Ltr>)}
            {row(
              t(locale, 'kn.d.platform'),
              d.platform ? t(locale, `kn.platform.${d.platform}` as MessageKey) : '—',
            )}
            {row(
              t(locale, 'kn.d.frameworks'),
              d.frameworks.length ? <Ltr>{d.frameworks.join(', ')}</Ltr> : '—',
            )}
            {row(t(locale, 'kn.d.category'), d.category ? <bdi dir="auto">{d.category}</bdi> : '—')}
            {row(
              t(locale, 'kn.d.tags'),
              d.tags.length ? <bdi dir="auto">{d.tags.join(', ')}</bdi> : '—',
            )}
            {row(t(locale, 'kn.d.region'), <Ltr>{d.dataRegion}</Ltr>)}
            {row(t(locale, 'kn.d.source'), <Ltr>{d.sourceKind}</Ltr>)}
            {row(t(locale, 'kn.d.created'), formatDateTime(d.createdAt, locale))}
            {d.currentVersion &&
              row(
                t(locale, 'kn.d.current'),
                <>
                  <Ltr>#{d.currentVersion.seq}</Ltr> ·{' '}
                  <Ltr>{formatBytes(d.currentVersion.bytes, locale)}</Ltr>
                </>,
              )}
            {d.currentVersion &&
              row(
                t(locale, 'kn.d.checksum'),
                <Ltr>{d.currentVersion.checksumSha256.slice(0, 16)}…</Ltr>,
              )}
          </dl>
        </Card>

        <Card aria-label={t(locale, 'kn.d.permissions')}>
          <h2 className="nz-h2">{t(locale, 'kn.d.permissions')}</h2>
          {perms && (
            <dl>
              {row(
                t(locale, 'kn.d.licenseVerdict'),
                <Badge tone={licenseTone(perms.licenseVerdict)}>
                  {t(locale, `kn.lic.${perms.licenseVerdict}` as MessageKey)}
                </Badge>,
              )}
              {row(
                t(locale, 'kn.d.licenseSpdx'),
                perms.licenseSpdx ? <Ltr>{perms.licenseSpdx}</Ltr> : '—',
              )}
              {row(
                t(locale, 'kn.d.reuseScope'),
                t(locale, `kn.reuse.${perms.reuseScope}` as MessageKey),
              )}
              {row(t(locale, 'kn.d.aiProcessing'), yn(locale, perms.aiProcessing))}
              {row(t(locale, 'kn.d.componentReuse'), yn(locale, perms.componentReuse))}
              {row(t(locale, 'kn.d.starterEligible'), yn(locale, perms.starterEligible))}
              {row(
                t(locale, 'kn.d.architectureReference'),
                yn(locale, perms.architectureReference),
              )}
              {row(t(locale, 'kn.d.defaultEligible'), yn(locale, d.defaultEligible))}
            </dl>
          )}
          <p className="nz-muted">{t(locale, 'kn.d.licenseNote')}</p>
        </Card>
      </div>

      <Card aria-label={t(locale, 'kn.d.analysis')}>
        <h2 className="nz-h2">{t(locale, 'kn.d.analysis')}</h2>
        {d.manifest ? (
          <p>
            <Ltr>{d.manifest.frameworks.join(', ') || '—'}</Ltr> · {t(locale, 'kn.d.components')}:{' '}
            <Ltr>{String(d.componentCount)}</Ltr>
          </p>
        ) : (
          <p className="nz-muted">{t(locale, 'kn.d.manifest.none')}</p>
        )}
        <h3 className="nz-h3">{t(locale, 'kn.d.quality')}</h3>
        {d.quality.length === 0 ? (
          <p className="nz-muted">{t(locale, 'kn.d.quality.none')}</p>
        ) : (
          <dl>
            {d.quality.map((q) => (
              <div key={q.dimension} className="knd-q">
                <dt>
                  <Ltr>{q.dimension}</Ltr>
                </dt>
                <dd>
                  {q.measured && q.score !== null ? (
                    <Ltr>{String(q.score)}</Ltr>
                  ) : (
                    t(locale, 'kn.d.quality.none')
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <h3 className="nz-h3">{t(locale, 'kn.d.jobs')}</h3>
        {d.jobs.length === 0 ? (
          <p className="nz-muted">{t(locale, 'kn.d.jobs.none')}</p>
        ) : (
          <ul>
            {d.jobs.map((j) => (
              <li key={j.id}>
                <Ltr>{j.kind}</Ltr> · <Ltr>{j.state}</Ltr>{' '}
                {j.errorDetail && <bdi dir="auto">{j.errorDetail}</bdi>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section aria-label={t(locale, 'kn.d.versions')}>
        {versions.length === 0 ? (
          <EmptyState title={t(locale, 'kn.d.versions')} body={t(locale, 'kn.d.versions.none')} />
        ) : (
          <Table
            caption={t(locale, 'kn.d.versions')}
            rows={versions}
            rowKey={(v) => v.id}
            columns={[
              {
                key: 'seq',
                header: t(locale, 'kn.d.version'),
                card: 'title',
                render: (v) => <Ltr>#{v.seq}</Ltr>,
              },
              {
                key: 'state',
                header: t(locale, 'kn.col.status'),
                card: 'badge',
                render: (v) => (
                  <Badge tone={statusTone(v.state)}>
                    {t(locale, `kn.status.${v.state}` as MessageKey)}
                  </Badge>
                ),
              },
              {
                key: 'lic',
                header: t(locale, 'kn.d.licenseVerdict'),
                card: 'meta',
                render: (v) => (
                  <Badge tone={licenseTone(v.licenseVerdict)}>
                    {t(locale, `kn.lic.${v.licenseVerdict}` as MessageKey)}
                  </Badge>
                ),
              },
              {
                key: 'size',
                header: t(locale, 'kn.d.size'),
                card: 'meta',
                render: (v) => <Ltr>{formatBytes(v.bytes, locale)}</Ltr>,
              },
              {
                key: 'sha',
                header: t(locale, 'kn.d.checksum'),
                card: 'meta',
                render: (v) => <Ltr>{v.checksumSha256.slice(0, 12)}…</Ltr>,
              },
              {
                key: 'at',
                header: t(locale, 'kn.d.created'),
                card: 'footer',
                render: (v) => (v.createdAt ? formatDateTime(v.createdAt, locale) : '—'),
              },
            ]}
          />
        )}
      </section>

      {canManage && !retired && (
        <>
          <form
            className="nz-card"
            onSubmit={(e) => void save(e)}
            aria-label={t(locale, 'kn.d.edit')}
            noValidate
          >
            <h2 className="nz-h2">{t(locale, 'kn.d.edit')}</h2>
            <div className="knu-grid">
              <Field id="knd-name" label={t(locale, 'kn.d.name')}>
                {(a) => <Input {...a} name="name" defaultValue={d.name} maxLength={200} />}
              </Field>
              <Field id="knd-category" label={t(locale, 'kn.d.category')}>
                {(a) => (
                  <Input {...a} name="category" defaultValue={d.category ?? ''} maxLength={80} />
                )}
              </Field>
              <Field id="knd-platform" label={t(locale, 'kn.d.platform')}>
                {(a) => (
                  <Select {...a} name="platform" defaultValue={d.platform ?? ''}>
                    <option value="">{t(locale, 'kn.up.none')}</option>
                    {PLATFORMS.map((x) => (
                      <option key={x} value={x}>
                        {t(locale, `kn.platform.${x}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="knd-frameworks" label={t(locale, 'kn.d.frameworks')}>
                {(a) => (
                  <Input
                    {...a}
                    name="frameworks"
                    dir="ltr"
                    defaultValue={d.frameworks.join(', ')}
                  />
                )}
              </Field>
              <Field id="knd-tags" label={t(locale, 'kn.d.tags')}>
                {(a) => <Input {...a} name="tags" defaultValue={d.tags.join(', ')} />}
              </Field>
              <Field id="knd-description" label={t(locale, 'kn.d.description')}>
                {(a) => (
                  <Input
                    {...a}
                    name="description"
                    defaultValue={d.description ?? ''}
                    maxLength={4000}
                  />
                )}
              </Field>
              <Field id="knd-reuse" label={t(locale, 'kn.d.reuseScope')}>
                {(a) => (
                  <Select {...a} name="reuseScope" defaultValue={perms?.reuseScope ?? 'NONE'}>
                    {REUSE_SCOPES.map((x) => (
                      <option key={x} value={x}>
                        {t(locale, `kn.reuse.${x}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                id="knd-vis"
                label={t(locale, 'kn.d.visibility')}
                help={canPublish ? undefined : t(locale, 'kn.d.publishOnly')}
              >
                {(a) => (
                  <Select
                    {...a}
                    name="visibility"
                    defaultValue={d.visibility}
                    disabled={!canPublish}
                  >
                    {VISIBILITIES.map((x) => (
                      <option key={x} value={x}>
                        {t(locale, `kn.vis.${x}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <fieldset className="knd-checks">
              <legend className="nz-sr-only">{t(locale, 'kn.d.permissions')}</legend>
              {(
                [
                  ['componentReuse', 'kn.d.componentReuse', perms?.componentReuse, false],
                  ['starterEligible', 'kn.d.starterEligible', perms?.starterEligible, false],
                  [
                    'architectureReference',
                    'kn.d.architectureReference',
                    perms?.architectureReference,
                    false,
                  ],
                  ['aiProcessing', 'kn.d.aiProcessing', perms?.aiProcessing, true],
                  ['defaultEligible', 'kn.d.defaultEligible', d.defaultEligible, true],
                ] as [string, MessageKey, boolean | undefined, boolean][]
              ).map(([name, label, on, needsPublish]) => (
                <label key={name} className="knd-check">
                  <input
                    type="checkbox"
                    name={name}
                    defaultChecked={!!on}
                    disabled={needsPublish && !canPublish}
                  />{' '}
                  {t(locale, label)}
                  {needsPublish && !canPublish && (
                    <span className="nz-muted"> — {t(locale, 'kn.d.publishOnly')}</span>
                  )}
                </label>
              ))}
            </fieldset>
            <div className="nz-row">
              <Button type="submit" disabled={busy}>
                {t(locale, 'kn.d.save')}
              </Button>
            </div>
          </form>

          <Card aria-label={t(locale, 'kn.d.actions')}>
            <h2 className="nz-h2">{t(locale, 'kn.d.actions')}</h2>
            {confirm === null ? (
              <div className="nz-row">
                <Button
                  variant="secondary"
                  disabled={busy || d.status === 'DISABLED'}
                  onClick={() => setConfirm('disable')}
                >
                  {t(locale, 'kn.d.disable')}
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setConfirm('archive')}>
                  {t(locale, 'kn.d.archive')}
                </Button>
              </div>
            ) : (
              <form onSubmit={(e) => void retire(e)} noValidate>
                <Banner tone="warn">
                  {t(locale, confirm === 'archive' ? 'kn.d.archiveHelp' : 'kn.d.disableHelp')}
                </Banner>
                <Field
                  id="knd-reason"
                  label={t(locale, 'kn.d.reason')}
                  error={reasonError ?? undefined}
                >
                  {(a) => <Input {...a} name="reason" maxLength={500} autoFocus />}
                </Field>
                <div className="nz-row">
                  <Button
                    type="submit"
                    variant={confirm === 'archive' ? 'danger' : 'primary'}
                    disabled={busy}
                  >
                    {t(locale, 'kn.d.confirm')}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>
                    {t(locale, 'kn.d.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
