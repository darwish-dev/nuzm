import { DomainTools } from '../../../../../components/site/DomainTools';
import { ServicePlans } from '../../../../../components/site/ServicePlans';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { SiteFrame } from '../../../../../components/site/SiteFrame';
import {
  ServiceClosing,
  ServiceDetailHero,
  ServiceFeatures,
} from '../../../../../components/site/ServiceDetail';
import {
  BuilderHero,
  BuilderSections,
  isBuilderPage,
} from '../../../../../components/site/BuilderService';
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
  const builder = isBuilderPage(s.slug);
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path={`/services/${s.slug}`}
      mode={mode}
      hero={
        builder ? (
          <BuilderHero locale={locale} s={s} />
        ) : (
          <ServiceDetailHero locale={locale} s={s} />
        )
      }
    >
      {s.slug === 'domains' && <DomainTools locale={locale} />}
      {builder ? (
        // the AI builder pages have their own sections only (no photography, plans table or related list)
        <BuilderSections locale={locale} s={s} />
      ) : (
        <>
          <ServiceFeatures locale={locale} s={s} />
          <ServicePlans locale={locale} slug={s.slug} />
          <ServiceClosing locale={locale} s={s} />
        </>
      )}
    </SiteFrame>
  );
}
