import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale } from '@nuzm/i18n';
import { SiteFrame } from '../../../../components/site/SiteFrame';
import { BlogIndex, HubHero } from '../../../../components/site/Hub';
import { HUB, POST_CATEGORIES, type PostCategory } from '../../../../lib/hub-content';
import { pick } from '../../../../lib/site-content';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${pick(HUB.blog, locale)} | Nuzm`, description: pick(HUB.blogIntro, locale) };
}

/** The blog: a featured article, then the others, filtered by category (`?category=`). */
export default async function Blog({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const raw = (await searchParams).category;
  const category = POST_CATEGORIES.find((c) => c.id === raw)?.id as PostCategory | undefined;
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path="/blog"
      mode={mode}
      hero={
        <HubHero
          locale={locale}
          section="blog"
          title={pick(HUB.blogTitle, locale)}
          intro={pick(HUB.blogIntro, locale)}
        />
      }
    >
      <BlogIndex locale={locale} category={category} />
    </SiteFrame>
  );
}
