'use client';
import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button } from '@nuzm/ui';
import {
  VIEWPORTS,
  isPreviewUrl,
  type Preview,
  type SiteLocale,
  type Viewport,
} from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

/** The preview URL of the same preview in another site language (the API's preview URL ends with `/<locale>/`; the unguessable token host is unchanged). */
export const previewForLocale = (url: string, l: SiteLocale): string =>
  url.replace(/\/(ar|en)\/$/, `/${l}/`);

/**
 * UI-M09-03 centre: the responsive preview. The page runs on an ISOLATED origin (a different registrable domain, ADR-021) inside
 * `<iframe sandbox="allow-scripts">` WITHOUT `allow-same-origin` and with no referrer, so generated pages can never reach the console's cookies or storage.
 * The unguessable URL is only ever the iframe `src`: it is not displayed, copied, logged or put in a link.
 * A new preview is created for `versionId` on mount and whenever it changes (each edit makes a new version) or the preview expires.
 */
export function PreviewPane({
  locale,
  projectId,
  versionId,
  siteLocales,
  canWrite,
  viewport: viewportProp,
  onViewport,
  siteLocale: siteLocaleProp,
  onSiteLocale,
  bare = false,
}: {
  locale: Locale;
  projectId: string;
  versionId: string;
  siteLocales: SiteLocale[];
  canWrite: boolean;
  /** controlled device and site language: the workspace's top bar owns them (and then `bare` hides this pane's own toolbar) */
  viewport?: Viewport;
  onViewport?: (v: Viewport) => void;
  siteLocale?: SiteLocale;
  onSiteLocale?: (l: SiteLocale) => void;
  bare?: boolean;
}) {
  const call = useBuilderCall();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [viewportState, setViewportState] = useState<Viewport>('desktop');
  const [siteLocaleState, setSiteLocaleState] = useState<SiteLocale>(siteLocales[0] ?? 'ar');
  const viewport = viewportProp ?? viewportState;
  const siteLocale = siteLocaleProp ?? siteLocaleState;
  const setViewport = (v: Viewport) => (onViewport ? onViewport(v) : setViewportState(v));
  const setSiteLocale = (l: SiteLocale) => (onSiteLocale ? onSiteLocale(l) : setSiteLocaleState(l));
  const [expired, setExpired] = useState(false);
  const runRef = useRef(call.run);
  runRef.current = call.run;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const create = (vid: string) =>
    void runRef.current(
      () =>
        bapi.post<Preview>(`/v1/builder/projects/${projectId}/previews`, {
          body: { viewport: viewportRef.current, versionId: vid },
        }),
      (p) => {
        setPreview(p);
        setExpired(false);
      },
    );

  // A preview is created per version; a burst of edits is coalesced (one preview 1.2 s after the last change) so the active-preview limit is not used up.
  const firstPreview = useRef(true);
  useEffect(() => {
    if (!canWrite) return;
    if (firstPreview.current) {
      firstPreview.current = false;
      create(versionId);
      return;
    }
    const h = setTimeout(() => create(versionId), 1200);
    return () => clearTimeout(h);
  }, [versionId, canWrite]);

  useEffect(() => {
    if (!preview) return;
    const ms = Date.parse(preview.expiresAt) - Date.now();
    if (ms <= 0) return setExpired(true);
    const h = setTimeout(() => setExpired(true), Math.min(ms, 2_147_000_000));
    return () => clearTimeout(h);
  }, [preview]);

  const src =
    preview && isPreviewUrl(preview.url) ? previewForLocale(preview.url, siteLocale) : null;
  return (
    <div className={bare ? 'bld-preview-bare' : undefined}>
      <div
        className="nz-row"
        role="toolbar"
        aria-label={t(locale, 'bld.preview.toolbar')}
        hidden={bare}
      >
        {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => (
          <Button
            key={v}
            variant={viewport === v ? 'primary' : 'secondary'}
            aria-pressed={viewport === v}
            onClick={() => setViewport(v)}
          >
            {t(locale, `bld.preview.${v}`, { width: VIEWPORTS[v] })}
          </Button>
        ))}
        {siteLocales.length > 1 &&
          siteLocales.map((l) => (
            <Button
              key={l}
              variant={siteLocale === l ? 'primary' : 'secondary'}
              aria-pressed={siteLocale === l}
              onClick={() => setSiteLocale(l)}
            >
              {t(locale, `bld.lang.${l}`)}
            </Button>
          ))}
        {canWrite && (
          <Button variant="secondary" disabled={call.busy} onClick={() => create(versionId)}>
            {t(locale, 'bld.preview.refresh')}
          </Button>
        )}
      </div>
      {!canWrite && <Banner tone="warn">{t(locale, 'bld.preview.needsWriter')}</Banner>}
      {expired && <Banner tone="warn">{t(locale, 'bld.preview.expired')}</Banner>}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <div
        className="bld-frame-wrap"
        role="region"
        aria-label={t(locale, 'bld.preview.region')}
        tabIndex={0}
      >
        {src ? (
          <iframe
            key={`${preview?.id}-${siteLocale}`}
            className="bld-frame"
            title={t(locale, 'bld.preview.frame')}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            data-viewport={viewport}
            style={{ inlineSize: VIEWPORTS[viewport] }}
          />
        ) : (
          <p role="status" aria-busy={call.busy} className="nz-muted">
            {canWrite ? t(locale, 'bld.preview.loading') : t(locale, 'bld.preview.none')}
          </p>
        )}
      </div>
    </div>
  );
}
