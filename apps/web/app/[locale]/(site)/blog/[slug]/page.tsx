import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { SiteFrame } from '../../../../../components/site/SiteFrame';
import { HubHero, PostBody } from '../../../../../components/site/Hub';
import { HUB, POSTS, postBySlug } from '../../../../../lib/hub-content';
import { pick } from '../../../../../lib/site-content';

export function generateStaticParams() {
  return locales.flatMap((locale) => POSTS.map((p) => ({ locale, slug: p.slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const p = postBySlug(slug);
  if (!isLocale(locale) || !p) return {};
  return { title: `${pick(p.title, locale)} | Nuzm`, description: pick(p.excerpt, locale) };
}

export default async function Article({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const p = postBySlug(slug);
  if (!isLocale(locale) || !p) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path={`/blog/${p.slug}`}
      mode={mode}
      hero={
        <HubHero
          locale={locale}
          section="blog"
          title={pick(p.title, locale)}
          intro={pick(p.excerpt, locale)}
          crumb={{ href: `/${locale}/blog`, label: pick(HUB.backBlog, locale) }}
        />
      }
    >
      <PostBody locale={locale} p={p} />
    </SiteFrame>
  );
}
