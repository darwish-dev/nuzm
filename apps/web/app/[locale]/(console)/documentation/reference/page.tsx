import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { CONSOLE_DOCS, ConsoleDocsFrame } from '../../../../../components/docs/ConsoleDocs';
import { Rich } from '../../../../../components/docs/DocsParts';
import { doc } from '../../../../../lib/docs-content';
import { REF } from '../../../../../lib/api-docs';
import { requireSession } from '../../../../../lib/server';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${doc('reference', locale)} | ${t(locale, 'cdoc.title')} | Nuzm` };
}

export default async function ConsoleReference({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireSession(locale);
  return (
    <ConsoleDocsFrame
      locale={locale}
      path={`${CONSOLE_DOCS}/reference`}
      sitePath="/docs/reference"
      crumb={{ label: doc('docs', locale), href: CONSOLE_DOCS }}
      title={doc('reference', locale)}
      lead={`${REF.counts.operations} ${doc('endpoints', locale)}.`}
    >
      <p>
        <Rich text={doc('authNote', locale)} />
      </p>
      <div className="cdoc-grid">
        {REF.tags.map((x) => (
          <a key={x.name} className="cdoc-card" href={`${CONSOLE_DOCS}/reference/${x.name}`}>
            <span className="cdoc-card-icon" aria-hidden="true">
              <Icon name="code" size={18} />
            </span>
            <span>
              <b dir="ltr">{x.title}</b>
              <small dir="ltr">{x.description}</small>
              <small>
                {x.operations} {doc('endpoints', locale)}
              </small>
            </span>
          </a>
        ))}
      </div>
    </ConsoleDocsFrame>
  );
}
