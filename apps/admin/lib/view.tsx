import type { ReactNode } from 'react';
import { ApiError } from '@nuzm/sdk';
import { t, type Locale } from '@nuzm/i18n';
import { ErrorState, ForbiddenState } from '@nuzm/ui';

/** Run a loader and render its data, or the right error panel (403 → forbidden, suspended, anything else → error + trace id). */
export async function view<T>(
  locale: Locale,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  try {
    return render(await load());
  } catch (e) {
    if (e instanceof ApiError && e.code === 'org_suspended')
      return (
        <ForbiddenState
          title={t(locale, 'state.suspended.title')}
          body={t(locale, 'state.suspended.body')}
        />
      );
    if (e instanceof ApiError && e.isForbidden)
      return (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      );
    const trace = e instanceof ApiError ? e.traceId : undefined;
    return (
      <ErrorState
        title={t(locale, 'state.error.title')}
        body={t(locale, 'state.error.body')}
        detail={trace ? t(locale, 'state.error.trace', { traceId: trace }) : undefined}
      />
    );
  }
}
