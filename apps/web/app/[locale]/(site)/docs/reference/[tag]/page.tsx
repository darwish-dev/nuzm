import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { isLocale, locales } from '@nuzm/i18n';
import { DocsFrame } from '../../../../../../components/site/DocsFrame';
import { Method, OperationView, Rich } from '../../../../../../components/docs/DocsParts';
import { doc } from '../../../../../../lib/docs-content';
import { REF, opsOfTag, tagByName } from '../../../../../../lib/api-docs';

export function generateStaticParams() {
  return locales.flatMap((locale) => REF.tags.map((t) => ({ locale, tag: t.name })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}): Promise<Metadata> {
  const { locale, tag } = await params;
  const t = tagByName(tag);
  if (!isLocale(locale) || !t) return {};
  return { title: `${t.title} | ${doc('reference', locale)} | Nuzm`, description: t.description };
}

export default async function ReferenceTag({ params }: { params: Promise<{ locale: string; tag: string }> }) {
  const { locale, tag } = await params;
  const t = tagByName(tag);
  if (!isLocale(locale) || !t) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  const ops = opsOfTag(t.name);
  return (
    <DocsFrame
      locale={locale}
      path={`/docs/reference/${t.name}`}
      mode={mode}
      crumb={{ label: doc('apiRef', locale), href: `/${locale}/docs/reference` }}
      title={t.title}
      lead={t.description}
      toc={ops.map((o) => ({ id: o.id, label: o.summary || o.path }))}
    >
      <p>
        <Rich text={doc('authNote', locale)} />
      </p>
      <ul className="doc-index" dir="ltr">
        {ops.map((o) => (
          <li key={o.id}>
            <a href={`#${o.id}`}>
              <Method m={o.method} />
              <code>{o.path}</code>
              <span>{o.summary}</span>
            </a>
          </li>
        ))}
      </ul>
      {ops.map((o) => (
        <OperationView key={o.id} locale={locale} op={o} />
      ))}
    </DocsFrame>
  );
}
