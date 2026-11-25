import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { SiteFrame } from '../../../../../components/site/SiteFrame';
import { CourseBody, HubHero } from '../../../../../components/site/Hub';
import { COURSES, HUB, courseBySlug } from '../../../../../lib/hub-content';
import { pick } from '../../../../../lib/site-content';

export function generateStaticParams() {
  return locales.flatMap((locale) => COURSES.map((c) => ({ locale, slug: c.slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const c = courseBySlug(slug);
  if (!isLocale(locale) || !c) return {};
  return { title: `${pick(c.title, locale)} | Nuzm`, description: pick(c.summary, locale) };
}

export default async function CoursePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const c = courseBySlug(slug);
  if (!isLocale(locale) || !c) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path={`/academy/${c.slug}`}
      mode={mode}
      hero={
        <HubHero
          locale={locale}
          section="academy"
          title={pick(c.title, locale)}
          intro={pick(c.summary, locale)}
          crumb={{ href: `/${locale}/academy`, label: pick(HUB.backAcademy, locale) }}
        />
      }
    >
      <CourseBody locale={locale} c={c} />
    </SiteFrame>
  );
}
