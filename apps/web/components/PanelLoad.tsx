'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, EmptyState, ForbiddenState } from '@nuzm/ui';

/** What a panel's reader answers: ok with the data, or the HTTP status of the refusal (0 = no connection). */
export interface Fetched<T> {
  ok: boolean;
  status: number;
  data?: T | undefined;
}
/** An API call result (`bapi.get`) as a `Fetched`. */
export const fetched = <T,>(r: {
  response: { ok: boolean; status: number };
  data?: unknown;
}): Fetched<T> => ({
  ok: r.response.ok,
  status: r.response.status,
  data: r.data as T | undefined,
});

export type Load<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'forbidden' }
  | { state: 'gone' }
  | { state: 'error' };

/**
 * Read what a workspace panel shows when it opens: loading, the data, forbidden (403), not available (404: a flag is off or the item is gone) or an error with a
 * retry. `key` says when to read again (a new project version, a changed filter); `enabled` false reads nothing.
 */
export function useLoad<T>(
  read: () => Promise<Fetched<T>>,
  key: string,
  enabled = true,
): [Load<T>, () => void] {
  const [res, setRes] = useState<Load<T>>({ state: 'loading' });
  const [n, setN] = useState(0);
  const alive = useRef(true);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    setRes({ state: 'loading' });
    void reader.current().then((r) => {
      if (!alive.current) return;
      if (r.ok && r.data !== undefined) setRes({ state: 'ready', data: r.data });
      else if (r.status === 403) setRes({ state: 'forbidden' });
      else if (r.status === 404) setRes({ state: 'gone' });
      else setRes({ state: 'error' });
    });
    return () => {
      alive.current = false;
    };
  }, [key, enabled, n]);
  return [res, useCallback(() => setN((x) => x + 1), [])];
}

/** What a member without the panel's permission sees (the same state the former pages showed). */
export const PanelForbidden = ({ locale }: { locale: Locale }) => (
  <ForbiddenState
    title={t(locale, 'state.forbidden.title')}
    body={t(locale, 'state.forbidden.body')}
  />
);

/** The states every panel shares while its data loads; the children render only with data. */
export function Gate<T>({
  locale,
  load,
  retry,
  gone,
  children,
}: {
  locale: Locale;
  load: Load<T>;
  retry: () => void;
  /** what a 404 means for this panel (the default is the mobile builder's "not enabled" state) */
  gone?: ReactNode;
  children: (data: T) => ReactNode;
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
      <>
        {gone ?? (
          <EmptyState
            title={t(locale, 'mobile.unavailable.title')}
            body={t(locale, 'mobile.unavailable.body')}
          />
        )}
      </>
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
  return <>{children(load.data)}</>;
}
