import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Icon, type IconName } from '@nuzm/ui';
import { isLocale } from '@nuzm/i18n';
import { DocsFrame } from '../../../../components/site/DocsFrame';
import { Cover } from '../../../../components/site/Hub';
import { HUB } from '../../../../lib/hub-content';
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

const guideIcon = (slug: string): IconName =>
  slug.includes('auth')
    ? 'key'
    : slug.includes('quick')
      ? 'sparkle'
      : slug.includes('error')
        ? 'shield'
        : slug.includes('webhook')
          ? 'bell'
          : slug.includes('paginat')
            ? 'list'
            : slug.includes('idempot')
              ? 'refresh'
              : slug.includes('operation')
                ? 'pulse'
                : 'code';

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
      <div className="hub-actions doc-actions">
        <a className="hub-btn hub-btn-main" href={`/${locale}/docs/guides/quickstart`}>
          {doc('readQuickstart', locale)} <Icon name="arrow" size={14} />
        </a>
        <a className="hub-btn hub-btn-ghost" href={`/${locale}/docs/reference`}>
          {doc('openReference', locale)}
        </a>
      </div>
      <h2 id="guides">{doc('guides', locale)}</h2>
      <div className="hub-grid doc-grid">
        {GUIDES.map((g, i) => (
          <a key={g.slug} className="hub-card" href={`/${locale}/docs/guides/${g.slug}`}>
            <Cover icon={guideIcon(g.slug)} tone={i} />
            <span className="hub-card-body">
              <b>{pick(g.title, locale)}</b>
              <small>{pick(g.summary, locale)}</small>
              <span className="hub-more">
                {doc('next', locale)} <Icon name="arrow" size={14} />
              </span>
            </span>
          </a>
        ))}
      </div>
      <h2 id="reference">{doc('reference', locale)}</h2>
      <a className="hub-cta doc-ref-band" href={`/${locale}/docs/reference`}>
        <span className="hub-cta-icon">
          <Icon name="code" size={20} />
        </span>
        <span className="hub-cta-text">
          <b>
            {REF.counts.operations} {doc('endpoints', locale)}
          </b>
          <small>
            {REF.counts.tags} · {doc('onThisSite', locale)} <Rich text={doc('authNote', locale)} />
          </small>
        </span>
        <span className="hub-btn hub-btn-ghost">
          {doc('openReference', locale)} <Icon name="arrow" size={14} />
        </span>
      </a>
      <h2 id="downloads">{doc('downloads', locale)}</h2>
      <div className="hub-grid doc-grid">
        <a className="hub-card" href={`/${locale}/docs/openapi.json`} download="nuzm-openapi.json">
          <Cover icon="code" tone={1} />
          <span className="hub-card-body">
            <b>{doc('downloadOpenapi', locale)}</b>
            <small>{doc('downloadOpenapiText', locale)}</small>
            <span className="hub-more">
              {doc('download', locale)} <Icon name="arrow" size={14} />
            </span>
          </span>
        </a>
        <a
          className="hub-card"
          href={`/${locale}/docs/postman.json`}
          download="nuzm-postman-collection.json"
        >
          <Cover icon="send" tone={2} />
          <span className="hub-card-body">
            <b>{doc('downloadPostman', locale)}</b>
            <small>
              <Rich text={doc('downloadPostmanText', locale)} />
            </small>
            <span className="hub-more">
              {doc('download', locale)} <Icon name="arrow" size={14} />
            </span>
          </span>
        </a>
        <div className="hub-card">
          <Cover icon="grid" tone={0} />
          <span className="hub-card-body">
            <b>{doc('sdk', locale)}</b>
            <small>
              <Rich text={doc('sdkText', locale)} />
            </small>
          </span>
        </div>
      </div>
      <h2 id="help">{doc('helpTitle', locale)}</h2>
      <aside className="hub-cta">
        <span className="hub-cta-icon">
          <Icon name="support" size={20} />
        </span>
        <span className="hub-cta-text">
          <small>{doc('helpText', locale)}</small>
        </span>
        <a className="hub-btn hub-btn-main" href={`/${locale}/community`}>
          {pick(HUB.community, locale)} <Icon name="arrow" size={14} />
        </a>
      </aside>
    </DocsFrame>
  );
}
