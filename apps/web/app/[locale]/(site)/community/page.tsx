import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale } from '@nuzm/i18n';
import { SiteFrame } from '../../../../components/site/SiteFrame';
import { CommunityBody, HubHero, HubStart } from '../../../../components/site/Hub';
import { HUB } from '../../../../lib/hub-content';
import { pick } from '../../../../lib/site-content';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return {
    title: `${pick(HUB.community, locale)} | Nuzm`,
    description: pick(HUB.communityIntro, locale),
  };
}

/** The community: the channels that exist today (docs, in-dashboard support) and the ones being prepared, marked "coming soon". */
export default async function Community({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path="/community"
      mode={mode}
      hero={
        <HubHero
          locale={locale}
          section="community"
          title={pick(HUB.communityTitle, locale)}
          intro={pick(HUB.communityIntro, locale)}
        >
          <HubStart locale={locale} />
        </HubHero>
      }
    >
      <CommunityBody locale={locale} />
    </SiteFrame>
  );
}
