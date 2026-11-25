import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Icon } from '@nuzm/ui';
import { isLocale } from '@nuzm/i18n';
import { DocsFrame } from '../../../../../components/site/DocsFrame';
import { Rich } from '../../../../../components/docs/DocsParts';
import { doc } from '../../../../../lib/docs-content';
import { REF } from '../../../../../lib/api-docs';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${doc('reference', locale)} | Nuzm` };
}

export default async function ReferenceIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <DocsFrame
      locale={locale}
      path="/docs/reference"
      mode={mode}
      crumb={{ label: doc('docs', locale), href: `/${locale}/docs` }}
      title={doc('reference', locale)}
      lead={`${REF.counts.operations} ${doc('endpoints', locale)}. ${doc('onThisSite', locale)}`}
    >
      <p>
        <Rich text={doc('authNote', locale)} />
      </p>
      <div className="doc-cards">
        {REF.tags.map((t) => (
          <a key={t.name} className="svc-card svc-link-card" href={`/${locale}/docs/reference/${t.name}`}>
            <h3 dir="ltr">{t.title}</h3>
            <p dir="ltr">{t.description}</p>
            <span className="svc-more">
              {t.operations} {doc('endpoints', locale)} <Icon name="arrow" size={14} />
            </span>
          </a>
        ))}
      </div>
    </DocsFrame>
  );
}
