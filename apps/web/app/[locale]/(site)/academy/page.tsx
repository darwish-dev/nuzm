import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale } from '@nuzm/i18n';
import { SiteFrame } from '../../../../components/site/SiteFrame';
import { AcademyIndex, HubHero, HubStart } from '../../../../components/site/Hub';
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
    title: `${pick(HUB.academy, locale)} | Nuzm`,
    description: pick(HUB.academyIntro, locale),
  };
}

/** The academy: free learning paths, each ending with something working in the learner's account. */
export default async function Academy({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path="/academy"
      mode={mode}
      hero={
        <HubHero
          locale={locale}
          section="academy"
          title={pick(HUB.academyTitle, locale)}
          intro={pick(HUB.academyIntro, locale)}
        >
          <HubStart locale={locale} />
        </HubHero>
      }
    >
      <AcademyIndex locale={locale} />
    </SiteFrame>
  );
}
