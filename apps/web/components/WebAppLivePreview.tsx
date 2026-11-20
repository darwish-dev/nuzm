'use client';
import { useEffect, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button } from '@nuzm/ui';
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
 */
export function WebAppLivePreview({
  locale,
  projectId,
  canWrite,
  hasBuild,
}: {
  locale: Locale;
  projectId: string;
  canWrite: boolean;
  hasBuild: boolean;
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
  const stop = () =>
    void call.run(
      () => bapi.del<null>(`/v1/builder/projects/${projectId}/live-preview`),
      () => setPreview(null),
    );

  useEffect(() => {
    if (!preview) return;
    const ms = Date.parse(preview.expiresAt) - Date.now();
    if (ms <= 0) return setExpired(true);
    const h = setTimeout(() => setExpired(true), Math.min(ms, 2_147_000_000));
    return () => clearTimeout(h);
  }, [preview]);

  if (disabled) return <Banner tone="warn">{t(locale, 'mws.web.live.disabled')}</Banner>;
  const src = preview && !expired && isPreviewUrl(preview.url) ? preview.url : null;
  return (
    <section className="mws-live" aria-labelledby="mws-live-h">
      <div className="mws-live-head">
        <h2 id="mws-live-h">{t(locale, 'mws.web.live.title')}</h2>
        {canWrite && hasBuild && (
          <div className="nz-row">
            {src ? (
              <>
                <Button variant="secondary" disabled={call.busy} onClick={start}>
                  {t(locale, 'mws.web.live.restart')}
                </Button>
                <Button variant="secondary" disabled={call.busy} onClick={stop}>
                  {t(locale, 'mws.web.live.stop')}
                </Button>
              </>
            ) : (
              <Button disabled={call.busy} onClick={start}>
                {call.busy ? t(locale, 'mws.web.live.starting') : t(locale, 'mws.web.live.start')}
              </Button>
            )}
          </div>
        )}
      </div>
      {!canWrite && <Banner tone="warn">{t(locale, 'mws.web.live.needsWriter')}</Banner>}
      {expired && <Banner tone="warn">{t(locale, 'mws.web.live.expired')}</Banner>}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {src ? (
        <div className="mws-live-frame">
          <iframe
            key={src}
            title={t(locale, 'mws.web.live.frame')}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <p className="nz-muted" role="status" aria-busy={call.busy}>
          {call.busy ? t(locale, 'mws.web.live.starting') : t(locale, 'mws.web.live.intro')}
        </p>
      )}
    </section>
  );
}
