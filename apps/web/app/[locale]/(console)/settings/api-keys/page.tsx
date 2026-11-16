import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ApiKeysPanel } from '../../../../../components/AccountPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function ApiKeys({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      const keys = await unwrap(s.api.GET('/v1/api-keys', {}));
      return keys.items;
    },
    (items) => (
      <ApiKeysPanel
        locale={locale}
        keys={items}
        // a key can only carry permissions its creator holds: offer exactly the caller's own org permissions
        permissions={[...s.permissions].filter((p) => !p.startsWith('admin:')).sort()}
        mfaFactorId={s.me.mfaFactorId ?? null}
        fmt={Object.fromEntries(
          items.map((k) => [k.id, k.lastUsedAt ? formatDateTime(k.lastUsedAt, locale) : '—']),
        )}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'apikeys.title')}</PageTitle>
      {body}
    </>
  );
}
