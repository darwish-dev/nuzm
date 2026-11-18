import { t, type Locale } from '@nuzm/i18n';

/** Section links of the customer AI screens (UI-M09-10 usage, UI-M09-11 budgets). */
export function AiTabs({ locale, current }: { locale: Locale; current: 'usage' | 'budgets' }) {
  const tabs = [
    { key: 'usage', href: `/${locale}/ai/usage` },
    { key: 'budgets', href: `/${locale}/ai/budgets` },
  ] as const;
  return (
    <nav aria-label={t(locale, 'aiu.nav')} className="nz-row">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `aiu.tab.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
