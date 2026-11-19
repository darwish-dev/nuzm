'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, EmptyState, ForbiddenState } from '@nuzm/ui';
import { bapi } from '../lib/builder-client';
import {
  declaredPermissions,
  manifestView,
  type MobileBuild,
  type MobileRelease,
  type SigningCredential,
} from '../lib/mobile';
import { MobileBuilds } from './MobileBuilds';
import { ReleaseWizard } from './MobileReleaseWizard';
import { MobileReleases } from './MobileReleases';
import { MobileSigning } from './MobileSigning';

type Load<T> =
  | { state: 'loading' }
  | { state: 'ready'; items: T[] }
  | { state: 'forbidden' }
  | { state: 'gone' }
  | { state: 'error' };

/** Read one list of the mobile API for a panel: loading, the items, forbidden (403), not available (404: flag off) or an error with a retry. */
function useMobileList<T>(
  path: string,
  query: Record<string, string> | undefined,
  enabled = true,
): [Load<T>, () => void] {
  const [res, setRes] = useState<Load<T>>({ state: 'loading' });
  const [n, setN] = useState(0);
  const key = JSON.stringify(query ?? {});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    setRes({ state: 'loading' });
    void bapi.get<{ items: T[] }>(path, query ? { query } : undefined).then((r) => {
      if (!alive.current) return;
      if (r.response.ok && r.data) setRes({ state: 'ready', items: r.data.items });
      else if (r.response.status === 403) setRes({ state: 'forbidden' });
      else if (r.response.status === 404) setRes({ state: 'gone' });
      else setRes({ state: 'error' });
    });
    return () => {
      alive.current = false;
    };
    // `query` is compared by its content
  }, [path, key, enabled, n]);
  return [res, useCallback(() => setN((x) => x + 1), [])];
}

/** The states every panel shares while its list loads. */
function Gate<T>({
  locale,
  load,
  retry,
  children,
}: {
  locale: Locale;
  load: Load<T>;
  retry: () => void;
  children: (items: T[]) => ReactNode;
}) {
  if (load.state === 'loading')
    return (
      <p role="status" aria-busy="true" className="nz-muted">
        {t(locale, 'state.loading')}
      </p>
    );
  if (load.state === 'forbidden') return <PanelForbidden locale={locale} />;
  if (load.state === 'gone')
    return (
      <EmptyState
        title={t(locale, 'mobile.unavailable.title')}
        body={t(locale, 'mobile.unavailable.body')}
      />
    );
  if (load.state === 'error')
    return (
      <div role="alert" className="mws-load-error">
        <p className="nz-error-text">{t(locale, 'mws.panel.loadError')}</p>
        <Button variant="secondary" onClick={retry}>
          {t(locale, 'action.retry')}
        </Button>
      </div>
    );
  return <>{children(load.items)}</>;
}

/** What a member without the panel's permission sees (the same state the former pages showed). */
export const PanelForbidden = ({ locale }: { locale: Locale }) => (
  <ForbiddenState
    title={t(locale, 'state.forbidden.title')}
    body={t(locale, 'state.forbidden.body')}
  />
);

/** Builds: request an Android debug build, status polling, artifacts and logs (UI-M10-14), inside the workspace. */
export function BuildsPanel({
  locale,
  projectId,
  manifest,
  canBuild,
}: {
  locale: Locale;
  projectId: string;
  manifest: unknown;
  canBuild: boolean;
}) {
  const [load, retry] = useMobileList<MobileBuild>('/v1/mobile/builds', { projectId }, canBuild);
  if (!canBuild) return <PanelForbidden locale={locale} />;
  return (
    <section aria-labelledby="mws-builds-h">
      <h2 className="nz-h2" id="mws-builds-h">
        {t(locale, 'mobile.title.builds')}
      </h2>
      <Gate locale={locale} load={load} retry={retry}>
        {(items) => (
          <MobileBuilds
            locale={locale}
            projectId={projectId}
            initial={items}
            hasProject={manifestView(manifest).fileCount > 0}
            canBuild={canBuild}
          />
        )}
      </Gate>
    </section>
  );
}

/** Signing: credential REFERENCES only (UI-M10-15). Owner and admin roles only: any other member sees the forbidden state. */
export function SigningPanel({
  locale,
  userId,
  canSign,
}: {
  locale: Locale;
  userId: string;
  canSign: boolean;
}) {
  const [load, retry] = useMobileList<SigningCredential>(
    '/v1/mobile/signing-credentials',
    undefined,
    canSign,
  );
  if (!canSign) return <PanelForbidden locale={locale} />;
  return (
    <section aria-labelledby="mws-signing-h">
      <h2 className="nz-h2" id="mws-signing-h">
        {t(locale, 'mobile.title.signing')}
      </h2>
      <Gate locale={locale} load={load} retry={retry}>
        {(items) => <MobileSigning locale={locale} userId={userId} initial={items} />}
      </Gate>
    </section>
  );
}

/** Releases: the records and the preparation wizard (UI-M10-16/17). The wizard opens in place; nothing here submits to a store. */
export function ReleasesPanel({
  locale,
  projectId,
  manifest,
  canRelease,
  canBuild,
  startWizard = false,
}: {
  locale: Locale;
  projectId: string;
  manifest: unknown;
  canRelease: boolean;
  /** `mobile:build`: the wizard picks one of the project's succeeded builds, which needs the build list */
  canBuild: boolean;
  startWizard?: boolean;
}) {
  const [wizard, setWizard] = useState(startWizard);
  const [load, retry] = useMobileList<MobileRelease>(
    '/v1/mobile/releases',
    { projectId },
    canRelease,
  );
  const [builds] = useMobileList<MobileBuild>(
    '/v1/mobile/builds',
    { projectId },
    canRelease && canBuild && wizard,
  );
  if (!canRelease) return <PanelForbidden locale={locale} />;
  if (wizard)
    return (
      <section aria-labelledby="mws-releases-h">
        <h2 className="nz-h2" id="mws-releases-h">
          {t(locale, 'mobile.title.releaseNew')}
        </h2>
        <p>
          <Button
            variant="secondary"
            onClick={() => {
              setWizard(false);
              retry();
            }}
          >
            {t(locale, 'mws.releases.back')}
          </Button>
        </p>
        {canBuild && builds.state === 'loading' ? (
          <p role="status" aria-busy="true" className="nz-muted">
            {t(locale, 'state.loading')}
          </p>
        ) : (
          <ReleaseWizard
            locale={locale}
            projectId={projectId}
            builds={builds.state === 'ready' ? builds.items : []}
            declared={declaredPermissions(manifestView(manifest))}
          />
        )}
      </section>
    );
  return (
    <section aria-labelledby="mws-releases-h">
      <h2 className="nz-h2" id="mws-releases-h">
        {t(locale, 'mobile.title.releases')}
      </h2>
      <Gate locale={locale} load={load} retry={retry}>
        {(items) => (
          <MobileReleases
            locale={locale}
            projectId={projectId}
            items={items}
            canCreate={canRelease}
            onNew={() => setWizard(true)}
          />
        )}
      </Gate>
    </section>
  );
}
