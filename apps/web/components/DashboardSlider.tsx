'use client';

import { useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';

export function DashboardSlider({
  ar,
  slides,
}: {
  ar: boolean;
  slides: { id: string; title: string; description: string; label: string; href: string }[];
}) {
  const [active, setActive] = useState(0);
  const slide = slides[active] ?? slides[0];
  if (!slide) return null;
  const slideIcon: IconName =
    slide.id === 'hosting' ? 'hosting' : slide.id === 'domains' ? 'domains' : 'cloud';
  const move = (step: number) =>
    setActive((current) => (current + step + slides.length) % slides.length);
  return (
    <section
      className="nzc-home-slider"
      data-slide={slide.id}
      aria-roledescription="carousel"
      aria-label={ar ? 'اكتشف خدماتك' : 'Explore your services'}
    >
      <div className="nzc-slide-copy" aria-live="polite" aria-atomic="true">
        <span className="nzc-slide-kicker">
          {ar ? 'صُممت لخطوتك القادمة' : 'MADE FOR YOUR NEXT MOVE'}
        </span>
        <h2>{slide.title}</h2>
        <p>{slide.description}</p>
        <a className="nzc-slide-link" href={slide.href}>
          {slide.label}
          <Icon name="arrow" size={15} />
        </a>
      </div>
      <div className="nzc-slide-scene" aria-hidden="true">
        <span className="nzc-slide-orbit nzc-slide-orbit-outer" />
        <span className="nzc-slide-orbit nzc-slide-orbit-inner" />
        <span className="nzc-slide-icon-satellite nzc-slide-satellite-one">
          <Icon name="shield" size={21} />
        </span>
        <span className="nzc-slide-icon-main" key={slide.id}>
          <Icon name={slideIcon} size={52} />
        </span>
        <span className="nzc-slide-icon-satellite nzc-slide-satellite-two">
          <Icon name={slide.id === 'domains' ? 'hosting' : 'domains'} size={23} />
        </span>
        <span className="nzc-slide-icon-satellite nzc-slide-satellite-three">
          <Icon name="code" size={17} />
        </span>
      </div>
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
