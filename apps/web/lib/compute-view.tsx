import type { ReactNode } from 'react';
import { ApiError } from '@nuzm/sdk';
import { t, type Locale } from '@nuzm/i18n';
import { EmptyState } from '@nuzm/ui';
import { view } from './view';

const GONE = Symbol('not-available');

/** "Not available" panel: the API answers 404 while `cloud.provisioning` is off for the org (and for another org's ids). */
export const NotAvailable = ({ locale }: { locale: Locale }) => (
  <EmptyState
    title={t(locale, 'm05.web.unavailable.title')}
    body={t(locale, 'm05.web.unavailable.body')}
  />
);

/** Like `view`, plus: a 404 renders the clean "not available" state instead of the generic error panel. Never throws. */
export async function computeView<T>(
  locale: Locale,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  return view<T | typeof GONE>(
    locale,
    async () => {
      try {
        return await load();
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return GONE;
        throw e;
      }
    },
    (d) => (d === GONE ? <NotAvailable locale={locale} /> : render(d as T)),
  );
}
