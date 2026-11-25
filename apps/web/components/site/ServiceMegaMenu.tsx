'use client';
import { useState } from 'react';
import { AiChatArtwork } from './AiChatArtwork';
import { Icon, type IconName } from '@nuzm/ui';
import type { MenuService } from './SiteHeader';

export function ServiceMegaMenu({
  services,
  locale,
  builders = false,
  close,
}: {
  services: MenuService[];
  locale: string;
  builders?: boolean;
  close: () => void;
}) {
  const ar = locale === 'ar';
  const [category, setCategory] = useState('all');
  const categories: { id: string; label: string; icon: IconName; slugs?: string[] }[] = [
    { id: 'all', label: ar ? 'كل الخدمات' : 'All services', icon: 'grid' },
    {
      id: 'hosting',
      label: ar ? 'الاستضافة والسحابة' : 'Hosting & cloud',
      icon: 'hosting',
      slugs: ['hosting', 'cloud', 'vps'],
    },
    {
      id: 'domains',
      label: ar ? 'النطاقات و DNS' : 'Domains & DNS',
      icon: 'domains',
      slugs: ['domains'],
    },
    {
      id: 'ai',
      label: ar ? 'الذكاء الاصطناعي والتطبيقات' : 'AI & applications',
      icon: 'sparkle',
      slugs: ['ai-builder', 'flutter-ai-builder', 'nextjs-ai-builder', 'fullstack-ai-builder'],
    },
    {
      id: 'business',
      label: ar ? 'البريد والبيانات والأتمتة' : 'Email, data & workflows',
      icon: 'mail',
      slugs: ['email', 'data', 'automation'],
    },
  ];
  const builderServices = services.filter((s) => s.slug.endsWith('-ai-builder'));
  const chosen = categories.find((c) => c.id === category)!;
  const visible = builders
    ? builderServices
    : services.filter((s) => !chosen.slugs || chosen.slugs.includes(s.slug));
  return (
    <div className={`svc-menu-panel mega-panel${builders ? ' mega-builders' : ''}`}>
      {!builders && (
        <div
          className="mega-categories"
          role="group"
          aria-label={ar ? 'فئات الخدمات' : 'Service categories'}
        >
          {categories.map((c) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              <Icon name={c.icon} size={19} />
              {c.label}
              <Icon name="chevron" size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="mega-products">
        <div className="mega-heading">
          <span>
            {builders ? (ar ? 'ماذا تريد أن تبني؟' : 'What will you build?') : chosen.label}
          </span>
          <a href={`/${locale}/services${builders ? '/ai-builder' : ''}`} onClick={close}>
            {ar ? 'استكشف' : 'Explore'} <Icon name="arrow" size={13} />
          </a>
        </div>
        <div className="mega-product-grid">
          {visible.map((s) => (
            <a key={s.slug} href={`/${locale}/services/${s.slug}`} onClick={close}>
              <span className="svc-menu-icon">
                <Icon
                  name={
                    s.slug === 'flutter-ai-builder'
                      ? 'phone'
                      : s.slug === 'nextjs-ai-builder'
                        ? 'globe'
                        : s.icon
                  }
                  size={20}
                />
              </span>
              <span>
                <strong>{s.name}</strong>
                <small>{s.tagline}</small>
              </span>
              <Icon name="arrow" size={14} />
            </a>
          ))}
        </div>
      </div>
      <aside className="mega-feature">
        {builders ? (
          <span className="mega-chat-art">
            <AiChatArtwork />
          </span>
        ) : (
          <span className="mega-feature-art" aria-hidden="true">
            <Icon name="cloud" size={62} />
            <i>
              <Icon name="sparkle" size={21} />
            </i>
          </span>
        )}
        <small>{ar ? 'فكرتك التالية تبدأ هنا' : 'YOUR NEXT IDEA STARTS HERE'}</small>
        <strong>
          {builders
            ? ar
              ? 'من الفكرة إلى التجربة.'
              : 'From an idea to an experience.'
            : ar
              ? 'كل ما تبنيه، متصل.'
              : 'Everything you build. Connected.'}
        </strong>
        <p>
          {ar
            ? 'مساحة واحدة للذكاء الاصطناعي والبنية التحتية وأدوات أعمالك.'
            : 'One workspace for AI, infrastructure, and the tools your business runs on.'}
        </p>
        <a href={`/${locale}/services/${builders ? 'ai-builder' : 'cloud'}`} onClick={close}>
          {ar ? 'اكتشف الإمكانيات' : 'Explore the possibilities'}
          <Icon name="arrow" size={15} />
        </a>
      </aside>
    </div>
  );
}
