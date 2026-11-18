import { t, type Locale } from '@nuzm/i18n';

/** Section links of the admin AI screens (UI-M09-12 providers, UI-M09-13 runs, UI-M09-14 quality). */
export function AiAdminTabs({
  locale,
  current,
}: {
  locale: Locale;
  current: 'model-providers' | 'runs' | 'quality';
}) {
  const base = `/${locale}/ai`;
  const tabs = [
    { key: 'model-providers', href: `${base}/model-providers` },
    { key: 'runs', href: `${base}/runs` },
    { key: 'quality', href: `${base}/quality` },
  ] as const;
  return (
    <nav aria-label={t(locale, 'aia.nav')} className="nz-row">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `aia.tab.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
