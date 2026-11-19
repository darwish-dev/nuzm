'use client';
import { usePathname } from 'next/navigation';
import { t, type Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';

/**
 * The AI builder, always one click away: a wide card floating at the bottom of every console page. It opens the builder full screen (the console's sidebar and top
 * bar step aside, with an Exit button). It is hidden inside the builder itself, where it would only be in the way.
 */
export function FloatingBuilder({ locale }: { locale: Locale }) {
  const pathname = usePathname() ?? '';
  if (/^\/(ar|en)\/(builder|mobile)(\/|$)/.test(pathname)) return null;
  return (
    <a
      className="bfab"
      href={`/${locale}/builder/projects`}
      aria-label={`${t(locale, 'bld.fab.title')}: ${t(locale, 'bld.fab.sub')}`}
    >
      <span className="bfab-icon" aria-hidden="true">
        <Icon name="sparkle" size={20} />
      </span>
      <span className="bfab-text">
        <strong>{t(locale, 'bld.fab.title')}</strong>
        <small>{t(locale, 'bld.fab.sub')}</small>
      </span>
      <span className="bfab-go" aria-hidden="true">
        <Icon name="arrow" size={18} />
      </span>
    </a>
  );
}
