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
  const slide = slides[active] ?? slides[0];
  if (!slide) return null;
  const move = (step: number) =>
    setActive((current) => (current + step + slides.length) % slides.length);
  return (
    <section
      className="nzc-home-slider"
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
      <img
        className="nzc-slide-art"
        src={`/images/dashboard/${slide.id}.svg`}
        alt=""
        width={500}
        height={220}
      />
      {slides.length > 1 && (
        <div className="nzc-slide-controls">
          <button
            type="button"
            onClick={() => move(-1)}
            aria-label={ar ? 'السابق' : 'Previous slide'}
          >
            ‹
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
            ›
          </button>
        </div>
      )}
    </section>
  );
}
