import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { CONSOLE_DOCS, ConsoleDocsFrame } from '../../../../components/docs/ConsoleDocs';
import { Rich } from '../../../../components/docs/DocsParts';
import { GUIDES, doc } from '../../../../lib/docs-content';
import { REF } from '../../../../lib/api-docs';
import { pick } from '../../../../lib/site-content';
import { requireSession } from '../../../../lib/server';
import { guideIcon } from '../../../../lib/docs-icons';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${t(locale, 'cdoc.title')} | Nuzm` };
}

export default async function ConsoleDocsHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireSession(locale);
  return (
    <ConsoleDocsFrame
      locale={locale}
      path={CONSOLE_DOCS}
      sitePath="/docs"
      title={doc('title', locale)}
      lead={t(locale, 'cdoc.lead')}
    >
      <h2 id="guides">{doc('guides', locale)}</h2>
      <div className="cdoc-grid">
        {GUIDES.map((g) => (
          <a key={g.slug} className="cdoc-card" href={`${CONSOLE_DOCS}/guides/${g.slug}`}>
            <span className="cdoc-card-icon" aria-hidden="true">
              <Icon name={guideIcon(g.slug)} size={18} />
            </span>
            <span>
              <b>{pick(g.title, locale)}</b>
              <small>{pick(g.summary, locale)}</small>
            </span>
          </a>
        ))}
      </div>
      <h2 id="reference">{doc('reference', locale)}</h2>
      <a className="cdoc-card" href={`${CONSOLE_DOCS}/reference`}>
        <span className="cdoc-card-icon" aria-hidden="true">
          <Icon name="code" size={18} />
        </span>
        <span>
          <b>
            {REF.counts.operations} {doc('endpoints', locale)}
          </b>
          <small>
            <Rich text={doc('authNote', locale)} />
          </small>
        </span>
      </a>
      <h2 id="downloads">{doc('downloads', locale)}</h2>
      <div className="cdoc-grid">
        <a className="cdoc-card" href={`/${locale}/docs/openapi.json`} download="nuzm-openapi.json">
          <span className="cdoc-card-icon" aria-hidden="true">
            <Icon name="code" size={18} />
          </span>
          <span>
            <b>{doc('downloadOpenapi', locale)}</b>
            <small>{doc('downloadOpenapiText', locale)}</small>
          </span>
        </a>
        <a
          className="cdoc-card"
          href={`/${locale}/docs/postman.json`}
          download="nuzm-postman-collection.json"
        >
          <span className="cdoc-card-icon" aria-hidden="true">
            <Icon name="send" size={18} />
          </span>
          <span>
            <b>{doc('downloadPostman', locale)}</b>
            <small>
              <Rich text={doc('downloadPostmanText', locale)} />
            </small>
          </span>
        </a>
        <div className="cdoc-card">
          <span className="cdoc-card-icon" aria-hidden="true">
            <Icon name="grid" size={18} />
          </span>
          <span>
            <b>{doc('sdk', locale)}</b>
            <small>
              <Rich text={doc('sdkText', locale)} />
            </small>
          </span>
        </div>
      </div>
    </ConsoleDocsFrame>
  );
}
