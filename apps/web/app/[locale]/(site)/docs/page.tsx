import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Icon } from '@nuzm/ui';
import { isLocale } from '@nuzm/i18n';
import { DocsFrame } from '../../../../components/site/DocsFrame';
import { Rich } from '../../../../components/docs/DocsParts';
import { GUIDES, doc } from '../../../../lib/docs-content';
import { REF } from '../../../../lib/api-docs';
import { pick } from '../../../../lib/site-content';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${doc('docs', locale)} | Nuzm`, description: doc('intro', locale) };
}

export default async function DocsHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <DocsFrame
      locale={locale}
      path="/docs"
      mode={mode}
      title={doc('title', locale)}
      lead={doc('intro', locale)}
      art="/images/illustrations/api.svg"
      toc={[
        { id: 'guides', label: doc('guides', locale) },
        { id: 'reference', label: doc('reference', locale) },
        { id: 'downloads', label: doc('downloads', locale) },
        { id: 'help', label: doc('helpTitle', locale) },
      ]}
    >
      <div className="svc-actions doc-actions">
        <a className="button button-white" href={`/${locale}/docs/guides/quickstart`}>
          {doc('readQuickstart', locale)} <Icon name="arrow" size={15} />
        </a>
        <a className="button button-outline" href={`/${locale}/docs/reference`}>
          {doc('openReference', locale)}
        </a>
      </div>
      <h2 id="guides">{doc('guides', locale)}</h2>
      <div className="doc-cards">
        {GUIDES.map((g) => (
          <a key={g.slug} className="svc-card svc-link-card" href={`/${locale}/docs/guides/${g.slug}`}>
            <span className="doc-guide-icon" aria-hidden="true"><Icon name={g.slug.includes('auth') ? 'key' : g.slug.includes('quick') ? 'sparkle' : 'code'} size={23} /></span><h3>{pick(g.title, locale)}</h3>
            <p>{pick(g.summary, locale)}</p>
            <span className="svc-more">
              {doc('next', locale)} <Icon name="arrow" size={14} />
            </span>
          </a>
        ))}
      </div>
      <h2 id="reference">{doc('reference', locale)}</h2>
      <p>
        {REF.counts.operations} {doc('endpoints', locale)} · {REF.counts.tags} · {doc('onThisSite', locale)}{' '}
        <Rich text={doc('authNote', locale)} />
      </p>
      <h2 id="downloads">{doc('downloads', locale)}</h2>
      <div className="doc-cards">
        <a className="svc-card svc-link-card" href={`/${locale}/docs/openapi.json`} download="nuzm-openapi.json">
          <h3>{doc('downloadOpenapi', locale)}</h3>
          <p>{doc('downloadOpenapiText', locale)}</p>
          <span className="svc-more">
            {doc('download', locale)} <Icon name="arrow" size={14} />
          </span>
        </a>
        <a className="svc-card svc-link-card" href={`/${locale}/docs/postman.json`} download="nuzm-postman-collection.json">
          <h3>{doc('downloadPostman', locale)}</h3>
          <p>
            <Rich text={doc('downloadPostmanText', locale)} />
          </p>
          <span className="svc-more">
            {doc('download', locale)} <Icon name="arrow" size={14} />
          </span>
        </a>
        <div className="svc-card">
          <h3>{doc('sdk', locale)}</h3>
          <p>
            <Rich text={doc('sdkText', locale)} />
          </p>
        </div>
      </div>
      <h2 id="help">{doc('helpTitle', locale)}</h2>
      <div className="doc-help">
        <img src="/images/illustrations/support.webp" alt="" width={367} height={289} loading="lazy" />
        <p>{doc('helpText', locale)}</p>
      </div>
    </DocsFrame>
  );
}
