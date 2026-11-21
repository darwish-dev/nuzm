import type { ReactNode } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { LocaleSwitch } from '@nuzm/ui';
import { BrandWordmark } from './BrandLogo';

type Variant = 'login' | 'register' | 'help';

/**
 * The sign-in and sign-up pages: a brand panel (the identity gradient, a headline and what the account is for) beside the form. The panel is the same
 * in both themes (a dark brand surface), the form side follows the theme. The page keeps ONE heading (the form's); the panel's headline is not a heading.
 * Steps are shown only on sign-up, where there really are two (account, then organization).
 */
export function AuthShell({
  locale,
  variant,
  title,
  sub,
  step,
  children,
}: {
  locale: Locale;
  variant: Variant;
  title: string;
  sub?: string;
  /** Sign-up only: which of the two steps this page is. */
  step?: 1 | 2;
  children: ReactNode;
}) {
  const steps = [t(locale, 'onb.account'), t(locale, 'onb.org')];
  return (
    <div className="nzc-split" data-variant={variant}>
      <aside className="nzc-split-panel" aria-label={t(locale, 'auth.panel.label')}>
        <span className="nzc-split-glow" aria-hidden="true" />
        <div className="nzc-split-content">
          <a className="nzc-split-logo" href={`/console`} aria-label="Nuzm">
            <BrandWordmark />
          </a>
          <p className="nzc-split-headline">
            {t(locale, `auth.panel.${variant}.title` as MessageKey)}
          </p>
          <p className="nzc-split-sub">{t(locale, `auth.panel.${variant}.sub` as MessageKey)}</p>
          {step ? (
            <ol
              className="nzc-split-list"
              aria-label={t(locale, 'onb.step', { n: step, total: 2 })}
            >
              {steps.map((label, i) => (
                <li
                  key={label}
                  data-state={i + 1 < step ? 'done' : i + 1 === step ? 'current' : 'todo'}
                  aria-current={i + 1 === step ? 'step' : undefined}
                >
                  <i aria-hidden="true">{i + 1 < step ? '✓' : i + 1}</i>
                  {label}
                </li>
              ))}
            </ol>
          ) : (
            <ul className="nzc-split-list">
              {(['f1', 'f2', 'f3'] as const).map((k, i) => (
                <li key={k}>
                  <i aria-hidden="true">{i + 1}</i>
                  {t(locale, `auth.panel.${k}` as MessageKey)}
                </li>
              ))}
            </ul>
          )}
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
        <a className="nzc-split-back" href="/">
          <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span> {t(locale, 'auth.backToSite')}
        </a>
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
