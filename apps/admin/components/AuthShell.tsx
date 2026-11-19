import type { ReactNode } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { LocaleSwitch } from '@nuzm/ui';
import { BrandWordmark } from './BrandLogo';

/**
 * The staff sign-in and two-factor pages, laid out like the customer sign-in (a brand panel beside the form) so both consoles feel like one product.
 * The panel is a dark brand surface in both themes; the form side follows the theme. The page keeps ONE heading (the form's); the panel's headline is
 * not a heading.
 */
export function AuthShell({
  locale,
  title,
  sub,
  children,
}: {
  locale: Locale;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="nzc-split" data-variant="admin">
      <aside className="nzc-split-panel" aria-label={t(locale, 'auth.panel.label')}>
        <span className="nzc-split-glow" aria-hidden="true" />
        <div className="nzc-split-content">
          <a className="nzc-split-logo" href={`/${locale}`} aria-label="Nuzm">
            <BrandWordmark />
          </a>
          <p className="nzc-split-headline">{t(locale, 'auth.panel.admin.title')}</p>
          <p className="nzc-split-sub">{t(locale, 'auth.panel.admin.sub')}</p>
          <ul className="nzc-split-list">
            {(['f1', 'f2', 'f3'] as const).map((k, i) => (
              <li key={k}>
                <i aria-hidden="true">{i + 1}</i>
                {t(locale, `auth.panel.admin.${k}` as MessageKey)}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="nzc-split-main">
        <div className="nzc-split-top">
          <LocaleSwitch
            current={locale}
            locales={['ar', 'en']}
            labels={{ ar: 'العربية', en: 'English' }}
          />
        </div>
        <div className="nzc-split-card">
          <h1>{title}</h1>
          {sub && <p className="nzc-split-card-sub">{sub}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

/** A thin "Or" divider between two ways to sign in. */
export function OrDivider({ locale }: { locale: Locale }) {
  return (
    <div className="nzc-or" role="separator">
      <span>{t(locale, 'auth.or')}</span>
    </div>
  );
}
