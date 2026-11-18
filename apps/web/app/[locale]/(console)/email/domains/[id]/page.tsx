import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { PageTitle } from '@nuzm/ui';
import { DomainPanel } from '../../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../../components/DataParts';
import { gate } from '../../../../../../lib/gate';
import { view } from '../../../../../../lib/view';

/** UI-M08-09: one domain. There is no get-one endpoint, so the domain is found in the list (the API returns the required records with their last status). */
export default async function EmailDomain({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'email:read', 'm8.emd.detail');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  return view(
    locale,
    async () => {
      const page = await unwrap(
        s.api.GET('/v1/email/domains', { params: { query: { limit: 200 } } }),
      );
      const d = page.items.find((x) => x.id === id);
      if (!d) notFound();
      return d;
    },
    (d) => (
      <>
        <PageTitle>{d.domain}</PageTitle>
        <EmailTabs locale={locale} current="domains" />
        <DomainPanel
          key={`${d.etag}-${d.lastCheckedAt ?? ''}`}
          locale={locale}
          domain={d}
          canManage={s.can('email:domain:manage')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
