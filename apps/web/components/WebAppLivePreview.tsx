'use client';
import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner } from '@nuzm/ui';
import { isPreviewUrl } from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

interface LivePreview {
  url: string;
  expiresAt: string;
  specVersion: number;
}

/**
 * Live preview of a generated web app (ADR-063). The app runs on an ISOLATED origin (`<token>.<previewDomain>`, a different site from the console) in a frame with
 * `allow-scripts allow-same-origin allow-forms`: the app needs its own origin for its session storage and its API calls, and because that origin is not the console's,
 * it still cannot reach the console's cookies or storage. The address carries a one-time demo session in its fragment, so it is only ever the frame `src`: never shown,
 * copied or linked.
 * It starts by itself when the tab opens, and again when a new build lands or the preview expires: no button to press.
 */
export function WebAppLivePreview({
  locale,
  projectId,
  canWrite,
  buildId,
}: {
  locale: Locale;
  projectId: string;
  canWrite: boolean;
  /** the project's head version: a new build restarts the preview; null = nothing built yet */
  buildId: string | null;
}) {
  const call = useBuilderCall();
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [expired, setExpired] = useState(false);
  const [disabled, setDisabled] = useState(false);

  const start = () =>
    void call.run(
      () => bapi.post<LivePreview>(`/v1/builder/projects/${projectId}/live-preview`),
      (p) => {
        setPreview(p);
        setExpired(false);
      },
      (p) => {
        if (p.code === 'feature_disabled') {
          setDisabled(true);
          return true;
        }
        return false;
      },
    );
  const startRef = useRef(start);
  startRef.current = start;

  // start on open and on every new build (once per build, even if React mounts the effect twice in development)
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canWrite || !buildId || startedFor.current === buildId) return;
    startedFor.current = buildId;
    startRef.current();
  }, [canWrite, buildId]);

  // an expired preview starts again by itself while the tab is open
  useEffect(() => {
    if (!preview) return;
    const ms = Math.max(0, Date.parse(preview.expiresAt) - Date.now());
    const h = setTimeout(
      () => {
        setExpired(true);
        startRef.current();
      },
      Math.min(ms, 2_147_000_000),
    );
    return () => clearTimeout(h);
  }, [preview]);

  if (disabled) return <Banner tone="warn">{t(locale, 'mws.web.live.disabled')}</Banner>;
  const src = preview && !expired && isPreviewUrl(preview.url) ? preview.url : null;
  return (
    <section className="mws-live" aria-labelledby="mws-live-h">
      <h2 id="mws-live-h" className="nz-sr">
        {t(locale, 'mws.web.live.title')}
      </h2>
      {!canWrite && <Banner tone="warn">{t(locale, 'mws.web.live.needsWriter')}</Banner>}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {src ? (
        <LiveFrame key={src} locale={locale} src={src} />
      ) : (
        <p className="mws-live-wait" role="status" aria-busy={call.busy}>
          <span className="bld-spinner" aria-hidden="true" />
          {call.busy || (canWrite && buildId && !call.problem)
            ? t(locale, 'mws.web.live.starting')
            : t(locale, 'mws.web.live.intro')}
        </p>
      )}
    </section>
  );
}

/**
 * The running app in its frame. The frame stays hidden (a quiet placeholder with the spinner) until the app has loaded and then fades in, so the
 * white of an unloaded page never flashes before the preview.
 */
function LiveFrame({ locale, src }: { locale: Locale; src: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="mws-live-frame" data-loaded={loaded ? 'true' : 'false'}>
      {!loaded && (
        <p className="mws-live-wait" role="status">
          <span className="bld-spinner" aria-hidden="true" />
          {t(locale, 'mws.web.live.starting')}
        </p>
      )}
      <iframe
        title={t(locale, 'mws.web.live.frame')}
        src={src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
