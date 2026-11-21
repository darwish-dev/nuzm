import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { Icon } from '@nuzm/ui';
import { isLocale } from '@nuzm/i18n';
import { SiteFrame } from '../../../../components/site/SiteFrame';
import { Mosaic } from '../../../../components/site/Mosaic';
import { ServiceCard } from '../../../../components/site/SiteSections';
import { SERVICES, site } from '../../../../lib/site-content';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${site('services', locale)} | Nuzm`, description: site('idxIntro', locale) };
}

export default async function ServicesIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const mode = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <SiteFrame
      locale={locale}
      path="/services"
      mode={mode}
      hero={
        <div className="svc-index-hero">
          <span className="eyebrow">{site('idxEyebrow', locale)}</span>
          <h1>{site('idxTitle', locale)}</h1>
          <p className="svc-lead">{site('idxIntro', locale)}</p>
          <div className="svc-actions">
            <a className="button button-white" href={`/${locale}/register`}>
              {site('start', locale)} <Icon name="sparkle" size={15} />
            </a>
            <a className="button button-outline svc-ghost" href={`/${locale}/login`}>
              {site('login', locale)}
            </a>
          </div>
        </div>
      }
    >
      <section className="section wrap svc-section" aria-labelledby="svc-all">
        <div className="svc-head">
          <span className="eyebrow">{site('services', locale)}</span>
          <h2 id="svc-all">{site('allServices', locale)}</h2>
        </div>
        <div className="svc-grid">
          {SERVICES.map((s) => (
            <ServiceCard key={s.slug} locale={locale} s={s} />
          ))}
        </div>
        <p className="svc-price-note">
          <Icon name="tag" size={15} /> {site('priceNote', locale)}
        </p>
      </section>
      <section className="section wrap svc-section" aria-labelledby="svc-mosaic">
        <div className="svc-head">
          <span className="eyebrow">{site('services', locale)}</span>
          <h2 id="svc-mosaic">{site('mosaicTitle', locale)}</h2>
        </div>
        <Mosaic locale={locale} title={site('mosaicTitle', locale)} />
      </section>
      <section className="section wrap svc-section" aria-labelledby="svc-together">
        <div className="svc-head">
          <span className="eyebrow">{site('services', locale)}</span>
          <h2 id="svc-together">{site('togetherTitle', locale)}</h2>
        </div>
        <div className="svc-points svc-points-3">
          {(
            [
              ['together1', 'together1Text', 'wallet'],
              ['together2', 'together2Text', 'globe'],
              ['together3', 'together3Text', 'shield'],
            ] as const
          ).map(([t1, t2, icon]) => (
            <article key={t1} className="svc-card">
              <span className="svc-card-icon">
                <Icon name={icon} size={20} />
              </span>
              <h3>{site(t1, locale)}</h3>
              <p>{site(t2, locale)}</p>
            </article>
          ))}
        </div>
      </section>
    </SiteFrame>
  );
}
