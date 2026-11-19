'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, Select, Table } from '@nuzm/ui';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { safeText } from '../lib/appbuilder';
import {
  buildBody,
  buildTone,
  isLiveBuild,
  minutesText,
  noticeKey,
  sizeText,
  type MobileArtifact,
  type MobileBuild,
} from '../lib/mobile';
import { MobileProblem } from './MobileParts';

const POLL_MS = 3000;

/** The server's notices, in the user's language when known (any other is shown as sent, masked). */
export function Notices({ locale, notices }: { locale: Locale; notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul aria-label={t(locale, 'mobile.builds.col.details')}>
      {notices.map((n) => {
        const k = noticeKey(n);
        return <li key={n}>{k ? t(locale, k) : <bdi dir="auto">{safeText(n, 160)}</bdi>}</li>;
      })}
    </ul>
  );
}

/** Files of one build: name, SHA-256, size, signed flag, retention. No download link exists yet and the screen says so. */
export function Artifacts({ locale, buildId }: { locale: Locale; buildId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [items, setItems] = useState<MobileArtifact[]>([]);
  const [open, setOpen] = useState(false);
  async function load() {
    setOpen(true);
    setState('loading');
    const r = await bapi.get<{ items: MobileArtifact[] }>(`/v1/mobile/builds/${buildId}/artifacts`);
    if (r.response.ok && r.data) {
      setItems(r.data.items);
      setState('ready');
    } else setState('error');
  }
  if (!open)
    return (
      <Button variant="secondary" onClick={() => void load()}>
        {t(locale, 'mobile.builds.artifacts')}
      </Button>
    );
  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        {t(locale, 'mobile.builds.artifactsHide')}
      </Button>
      {state === 'loading' && <p role="status">{t(locale, 'state.loading')}</p>}
      {state === 'error' && (
        <p className="nz-error-text" role="alert">
          {t(locale, 'state.error.title')}{' '}
          <Button variant="secondary" onClick={() => void load()}>
            {t(locale, 'action.retry')}
          </Button>
        </p>
      )}
      {state === 'ready' && items.length === 0 && <p>{t(locale, 'mobile.builds.artifactsNone')}</p>}
      {state === 'ready' && items.length > 0 && (
        <>
          <p className="nz-muted">{t(locale, 'mobile.builds.artifactsNote')}</p>
          <dl>
            {items.map((a) => (
              <div key={a.id}>
                <dt>
                  <Ltr>{a.fileName}</Ltr>
                </dt>
                <dd>
                  {t(locale, 'mobile.builds.artifact.sha')}: <Ltr>{a.sha256}</Ltr>
                  <br />
                  {t(locale, 'mobile.builds.artifact.size')}: <Ltr>{sizeText(a.sizeBytes)}</Ltr>
                  {' · '}
                  <Badge tone={a.signed ? 'success' : 'warn'}>
                    {t(locale, a.signed ? 'mobile.builds.signedYes' : 'mobile.builds.signedNo')}
                  </Badge>
                  <br />
                  {t(locale, 'mobile.builds.artifact.retention')}:{' '}
                  {formatDateTime(a.retentionUntil, locale)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

function Details({ locale, b }: { locale: Locale; b: MobileBuild }) {
  return (
    <>
      <Notices locale={locale} notices={b.notices} />
      {b.errorCode && (
        <p>
          {t(locale, 'mobile.builds.error')}: <Ltr>{safeText(b.errorCode, 60)}</Ltr>
        </p>
      )}
      {b.log ? (
        <details>
          <summary>{t(locale, 'mobile.builds.log')}</summary>
          <pre dir="ltr" tabIndex={0} className="nz-code">
            {safeText(b.log, 20_000)}
          </pre>
        </details>
      ) : null}
      {b.status === 'succeeded' && <Artifacts locale={locale} buildId={b.id} />}
    </>
  );
}

/**
 * UI-M10-14: builds of a mobile project. Requesting a build is a plain action; what a build IS (unsigned, not isolated, stand-in) is printed next to each one. iOS and signed
 * release builds depend on things that are not connected, and the screen says so before and after a request. A queued or running build is polled every 3 s.
 */
export function MobileBuilds({
  locale,
  projectId,
  initial,
  hasProject,
  canBuild,
}: {
  locale: Locale;
  projectId: string;
  initial: MobileBuild[];
  hasProject: boolean;
  canBuild: boolean;
}) {
  const call = useBuilderCall();
  const [items, setItems] = useState<MobileBuild[]>(initial);
  const [platform, setPlatform] = useState('android');
  const [profile, setProfile] = useState('debug');
  const [key, setKey] = useState(newKey());
  const [queued, setQueued] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  const live = items.some((b) => isLiveBuild(b.status));

  useEffect(() => {
    alive.current = true;
    if (!live) return;
    const id = setTimeout(async () => {
      const r = await bapi.get<{ items: MobileBuild[] }>('/v1/mobile/builds', {
        query: { projectId },
      });
      if (!alive.current) return;
      if (r.response.ok && r.data) {
        setItems(r.data.items);
        setListFailed(false);
      } else setListFailed(true);
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
  }, [live, tick, projectId]);

  function request() {
    const body = buildBody(projectId, platform, profile);
    if (!body) return;
    setQueued(false);
    void call.run(
      () => bapi.post<MobileBuild>('/v1/mobile/builds', { body, idempotencyKey: key }),
      (b) => {
        setKey(newKey());
        setQueued(true);
        setItems((cur) => [b, ...cur.filter((c) => c.id !== b.id)]);
      },
      () => setKey(newKey()),
    );
  }

  return (
    <>
      {canBuild && (
        <section aria-labelledby="mobile-req-h">
          <h2 className="nz-h2" id="mobile-req-h">
            {t(locale, 'mobile.builds.request')}
          </h2>
          {!hasProject && <Banner tone="warn">{t(locale, 'mobile.builds.noProject')}</Banner>}
          <div className="nz-row">
            <Field id="mobile-platform" label={t(locale, 'mobile.builds.platform')}>
              {(a) => (
                <Select {...a} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  <option value="android">{t(locale, 'mobile.platform.android')}</option>
                  <option value="ios">{t(locale, 'mobile.platform.ios')}</option>
                </Select>
              )}
            </Field>
            <Field id="mobile-profile" label={t(locale, 'mobile.builds.profile')}>
              {(a) => (
                <Select {...a} value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="debug">{t(locale, 'mobile.profile.debug')}</option>
                  <option value="release">{t(locale, 'mobile.profile.release')}</option>
                </Select>
              )}
            </Field>
          </div>
          {platform === 'ios' && (
            <Banner tone="warn">{t(locale, 'mobile.builds.iosNotice')}</Banner>
          )}
          {profile === 'release' && (
            <Banner tone="warn">{t(locale, 'mobile.builds.releaseNotice')}</Banner>
          )}
          <p>
            <Button disabled={call.busy || !hasProject} onClick={request} aria-busy={call.busy}>
              {t(locale, 'mobile.builds.go')}
            </Button>
          </p>
          {queued && !call.problem && <p role="status">{t(locale, 'mobile.builds.queued')}</p>}
          {call.problem && <MobileProblem locale={locale} problem={call.problem} />}
        </section>
      )}
      {listFailed && (
        <p className="nz-error-text" role="alert">
          {t(locale, 'mobile.err.load')}
        </p>
      )}
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'mobile.builds.empty.title')}
          body={t(locale, 'mobile.builds.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'mobile.builds.caption')}
          rows={items}
          rowKey={(b) => b.id}
          columns={[
            {
              key: 'kind',
              header: t(locale, 'mobile.builds.col.kind'),
              card: 'title',
              render: (b) =>
                `${t(locale, `mobile.platform.${b.platform}`)} · ${t(locale, `mobile.profile.${b.profile}`)}`,
            },
            {
              key: 'status',
              header: t(locale, 'mobile.builds.col.status'),
              card: 'badge',
              render: (b) => (
                <Badge tone={buildTone(b.status)}>
                  {tDynamic(locale, `mobile.builds.status.${b.status}`, b.status)}
                </Badge>
              ),
            },
            {
              key: 'when',
              header: t(locale, 'mobile.builds.col.when'),
              card: 'meta',
              render: (b) => formatDateTime(b.createdAt, locale),
            },
            {
              key: 'runner',
              header: t(locale, 'mobile.builds.col.runner'),
              card: 'chip',
              render: (b) => <Ltr>{b.runner ?? '—'}</Ltr>,
            },
            {
              key: 'minutes',
              header: t(locale, 'mobile.builds.col.minutes'),
              card: 'meta',
              render: (b) => <Ltr>{minutesText(b.minutesBilled)}</Ltr>,
            },
            {
              key: 'details',
              header: t(locale, 'mobile.builds.col.details'),
              card: 'footer',
              render: (b) => <Details locale={locale} b={b} />,
            },
          ]}
        />
      )}
    </>
  );
}
