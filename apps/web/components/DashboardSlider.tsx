'use client';

import { useState } from 'react';
import { Icon } from '@nuzm/ui';

export function DashboardSlider({
  ar,
  slides,
}: {
  ar: boolean;
  slides: { id: string; title: string; description: string; label: string; href: string }[];
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const slide = slides[active] ?? slides[0];
  if (!slide) return null;
  const move = (step: number) =>
    setActive((current) => (current + step + slides.length) % slides.length);
  return (
    <section
      className="nzc-home-slider"
      data-slide={slide.id}
      data-motion={paused ? 'paused' : 'playing'}
      aria-roledescription="carousel"
      aria-label={ar ? 'اكتشف خدماتك' : 'Explore your services'}
    >
      <div className="nzc-slide-copy" aria-live="polite" aria-atomic="true">
        <span className="nzc-slide-kicker">
          {slide.id === 'hosting'
            ? ar
              ? 'استضافة المواقع'
              : 'WEB HOSTING'
            : slide.id === 'compute'
              ? ar
                ? 'الحوسبة السحابية'
                : 'CLOUD COMPUTE'
              : ar
                ? 'النطاقات وDNS'
                : 'DOMAINS & DNS'}
        </span>
        <h2>{slide.title}</h2>
        <p>{slide.description}</p>
        <a className="nzc-slide-link" href={slide.href}>
          {slide.label}
          <Icon name="arrow" size={15} />
        </a>
      </div>
      <ServiceVisual key={slide.id} service={slide.id} ar={ar} />
      <button
        className="nzc-slide-motion"
        type="button"
        aria-pressed={paused}
        onClick={() => setPaused((value) => !value)}
      >
        {paused
          ? ar
            ? 'تشغيل الحركة'
            : 'Play animation'
          : ar
            ? 'إيقاف الحركة'
            : 'Pause animation'}
      </button>
      {slides.length > 1 && (
        <div className="nzc-slide-controls">
          <button
            type="button"
            onClick={() => move(-1)}
            aria-label={ar ? 'السابق' : 'Previous slide'}
          >
            <Icon name="arrow" size={14} />
          </button>
          <div className="nzc-slide-tabs">
            {slides.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-label={item.title}
                aria-pressed={index === active}
                onClick={() => setActive(index)}
              />
            ))}
          </div>
          <button type="button" onClick={() => move(1)} aria-label={ar ? 'التالي' : 'Next slide'}>
            <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
    </section>
  );
}

/** Illustrative service diagrams; these are not live resource statuses. */
function ServiceVisual({ service, ar }: { service: string; ar: boolean }) {
  return (
    <div className="nzc-service-art" data-service={service} aria-hidden="true">
      <div className="nzc-service-art-grid" />
      {service === 'hosting' ? (
        <>
          <div className="nzc-art-window">
            <div className="nzc-art-browser">
              <span>
                <i />
                <i />
                <i />
              </span>
              <span>
                <Icon name="shield" size={10} /> your-website.com
              </span>
            </div>
            <div className="nzc-art-webnav">
              <span className="nzc-art-wordmark" />
              <span />
              <span />
              <span />
            </div>
            <div className="nzc-art-webhero">
              <div>
                <span className="nzc-art-line" />
                <span className="nzc-art-line" />
                <span className="nzc-art-line-short" />
                <span className="nzc-art-webbutton" />
              </div>
              <div className="nzc-art-webimage">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="nzc-art-webtiles">
              <span />
              <span />
              <span />
            </div>
          </div>
          <span className="nzc-art-chip nzc-art-chip-top">
            <Icon name="code" size={14} />
            {ar ? 'من الكود إلى الويب' : 'From code to web'}
          </span>
          <span className="nzc-art-chip nzc-art-chip-bottom">
            <Icon name="hosting" size={16} />
            <span>{ar ? 'استضافة · نطاق · SSL' : 'Hosting · Domain · SSL'}</span>
          </span>
        </>
      ) : service === 'compute' ? (
        <>
          <div className="nzc-art-network">
            <span />
            <span />
            <span />
          </div>
          <div className="nzc-art-cloud-core">
            <Icon name="cloud" size={44} />
            <span>NUZM CLOUD</span>
          </div>
          <div className="nzc-art-node nzc-art-node-one">
            <Icon name="hosting" size={20} />
            <span>{ar ? 'الحوسبة' : 'Compute'}</span>
            <div className="nzc-art-node-bars">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="nzc-art-node nzc-art-node-two">
            <Icon name="data" size={20} />
            <span>{ar ? 'التخزين' : 'Storage'}</span>
            <div className="nzc-art-storage-lines">
              <i />
              <i />
              <i />
            </div>
          </div>
          <span className="nzc-art-chip nzc-art-chip-bottom">
            <Icon name="projects" size={15} />
            {ar ? 'بنية تحتية متصلة' : 'Connected infrastructure'}
          </span>
        </>
      ) : (
        <>
          <div className="nzc-art-domain-card">
            <span className="nzc-art-domain-label">
              {ar ? 'عنوان فكرتك القادمة' : 'A home for your next idea'}
            </span>
            <div className="nzc-art-domain-search">
              <Icon name="domains" size={20} />
              <span>
                yourbrand<span>.sa</span>
              </span>
              <span className="nzc-art-search-arrow">
                <Icon name="arrow" size={15} />
              </span>
            </div>
            <div className="nzc-art-tlds">
              <span>.com</span>
              <span>.sa</span>
              <span>.net</span>
            </div>
          </div>
          <span className="nzc-art-chip nzc-art-chip-top">
            <Icon name="domains" size={15} />
            {ar ? 'ابحث عن نطاقك' : 'Find your domain'}
          </span>
          <div className="nzc-art-dns">
            <span>DNS</span>
            <span>
              <b>A</b>
              <i />
            </span>
            <span>
              <b>CNAME</b>
              <i />
            </span>
          </div>
        </>
      )}
    </div>
  );
}
