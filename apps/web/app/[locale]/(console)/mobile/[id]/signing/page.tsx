import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MobileSigning } from '../../../../../../components/MobileSigning';
import { MobileTabs } from '../../../../../../components/MobileParts';
import { unwrapCall } from '../../../../../../lib/compute';
import type { SigningCredential } from '../../../../../../lib/mobile';
import { mobileGuard, mobileView } from '../../../../../../lib/mobile-view';

/** UI-M10-15: signing credential references (vault references only). Owner and admin roles only: any other member sees the forbidden state. */
export default async function MobileSigningPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'mobile:signing', 'mobile.title.signing');
  if (!m.ok) return m.node;
  const { locale, id, g } = m;
  return mobileView(
    locale,
    async () => {
      const project = await unwrapCall(
        g.c.get<{ id: string; name: string }>(`/v1/builder/projects/${id}`),
      );
      const list = await unwrapCall(
        g.c.get<{ items: SigningCredential[] }>('/v1/mobile/signing-credentials'),
      );
      return { project, list };
    },
    ({ project, list }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <MobileTabs locale={locale} projectId={id} current="signing" can={g.s.can} />
        <h2 className="nz-h2">{t(locale, 'mobile.title.signing')}</h2>
        <MobileSigning locale={locale} userId={g.s.me.id} initial={list.items} />
      </>
    ),
  );
}
