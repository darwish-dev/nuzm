import { ServicePlans } from '../../../../../components/site/ServicePlans';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { SiteFrame } from '../../../../../components/site/SiteFrame';
import {
  FaqSection,
  PointsSection,
  RelatedSection,
  ServiceHero,
  StepsSection,
} from '../../../../../components/site/SiteSections';
import { SERVICES, pick, serviceBySlug } from '../../../../../lib/site-content';

export function generateStaticParams() {
  return locales.flatMap((locale) => SERVICES.map((s) => ({ locale, slug: s.slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const s = serviceBySlug(slug);
  if (!isLocale(locale) || !s) return {};
  return { title: `${pick(s.name, locale)} | Nuzm`, description: pick(s.intro, locale) };
}

export default async function ServicePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const s = serviceBySlug(slug);
  if (!isLocale(locale) || !s) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path={`/services/${s.slug}`}
      mode={mode}
      hero={<ServiceHero locale={locale} s={s} />}
    >
      <PointsSection locale={locale} s={s} />
      <StepsSection locale={locale} s={s} />
      <ServicePlans locale={locale} slug={s.slug} />
      <FaqSection locale={locale} s={s} />
      <RelatedSection locale={locale} current={s.slug} />
    </SiteFrame>
  );
}
