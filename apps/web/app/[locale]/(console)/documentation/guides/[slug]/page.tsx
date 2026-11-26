import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { CONSOLE_DOCS, ConsoleDocsFrame } from '../../../../../../components/docs/ConsoleDocs';
import { GuideBlocks } from '../../../../../../components/docs/DocsParts';
import { GUIDES, doc, guideBySlug } from '../../../../../../lib/docs-content';
import { pick } from '../../../../../../lib/site-content';
import { requireSession } from '../../../../../../lib/server';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const g = guideBySlug(slug);
  if (!isLocale(locale) || !g) return {};
  return { title: `${pick(g.title, locale)} | ${t(locale, 'cdoc.title')} | Nuzm` };
}

export default async function ConsoleGuide({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const g = guideBySlug(slug);
  if (!isLocale(locale) || !g) notFound();
  await requireSession(locale);
  const next = GUIDES[GUIDES.indexOf(g) + 1];
  return (
    <ConsoleDocsFrame
      locale={locale}
      path={`${CONSOLE_DOCS}/guides/${g.slug}`}
      sitePath={`/docs/guides/${g.slug}`}
      crumb={{ label: doc('guides', locale), href: CONSOLE_DOCS }}
      title={pick(g.title, locale)}
      lead={pick(g.summary, locale)}
    >
      <GuideBlocks locale={locale} blocks={g.blocks} />
      <p className="doc-muted">{doc('baseHint', locale)}</p>
      {next && (
        <a className="doc-next" href={`${CONSOLE_DOCS}/guides/${next.slug}`}>
          {doc('next', locale)}: {pick(next.title, locale)}
        </a>
      )}
    </ConsoleDocsFrame>
  );
}
