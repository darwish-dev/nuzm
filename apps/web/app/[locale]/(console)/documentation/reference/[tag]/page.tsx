import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { CONSOLE_DOCS, ConsoleDocsFrame } from '../../../../../../components/docs/ConsoleDocs';
import { Method, OperationView, Rich } from '../../../../../../components/docs/DocsParts';
import { doc } from '../../../../../../lib/docs-content';
import { opsOfTag, tagByName } from '../../../../../../lib/api-docs';
import { requireSession } from '../../../../../../lib/server';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}): Promise<Metadata> {
  const { locale, tag } = await params;
  const x = tagByName(tag);
  if (!isLocale(locale) || !x) return {};
  return { title: `${x.title} | ${t(locale, 'cdoc.title')} | Nuzm` };
}

export default async function ConsoleReferenceTag({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}) {
  const { locale, tag } = await params;
  const x = tagByName(tag);
  if (!isLocale(locale) || !x) notFound();
  await requireSession(locale);
  const ops = opsOfTag(x.name);
  return (
    <ConsoleDocsFrame
      locale={locale}
      path={`${CONSOLE_DOCS}/reference/${x.name}`}
      sitePath={`/docs/reference/${x.name}`}
      crumb={{ label: doc('apiRef', locale), href: `${CONSOLE_DOCS}/reference` }}
      title={x.title}
      lead={x.description}
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
    </ConsoleDocsFrame>
  );
}
