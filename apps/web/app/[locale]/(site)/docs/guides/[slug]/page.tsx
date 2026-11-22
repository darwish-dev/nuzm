import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { DocsFrame } from '../../../../../../components/site/DocsFrame';
import { GuideBlocks, guideToc } from '../../../../../../components/docs/DocsParts';
import { GUIDES, doc, guideBySlug } from '../../../../../../lib/docs-content';
import { pick } from '../../../../../../lib/site-content';

export function generateStaticParams() {
  return locales.flatMap((locale) => GUIDES.map((g) => ({ locale, slug: g.slug })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const g = guideBySlug(slug);
  if (!isLocale(locale) || !g) return {};
  return { title: `${pick(g.title, locale)} | ${doc('docs', locale)} | Nuzm`, description: pick(g.summary, locale) };
}

export default async function GuidePage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const g = guideBySlug(slug);
  if (!isLocale(locale) || !g) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  const i = GUIDES.indexOf(g);
  const next = GUIDES[i + 1];
  return (
    <DocsFrame
      locale={locale}
      path={`/docs/guides/${g.slug}`}
      mode={mode}
      crumb={{ label: doc('guides', locale), href: `/${locale}/docs` }}
      title={pick(g.title, locale)}
      lead={pick(g.summary, locale)}
      toc={guideToc(locale, g.blocks)}
    >
      <GuideBlocks locale={locale} blocks={g.blocks} />
      <p className="doc-muted">{doc('baseHint', locale)}</p>
      {next && (
        <a className="doc-next" href={`/${locale}/docs/guides/${next.slug}`}>
          {doc('next', locale)}: {pick(next.title, locale)}
        </a>
      )}
    </DocsFrame>
  );
}
