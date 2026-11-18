import { t, type Locale } from '@nuzm/i18n';

interface Tab {
  key: string;
  href: string;
  show: boolean;
}

function TabBar({
  locale,
  label,
  current,
  tabs,
}: {
  locale: Locale;
  label: string;
  current: string;
  tabs: Tab[];
}) {
  const shown = tabs.filter((x) => x.show);
  if (shown.length === 0) return null;
  return (
    <nav aria-label={label} className="nz-row">
      {shown.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `m12.tab.${x.key}` as 'm12.tab.health')}
        </a>
      ))}
    </nav>
  );
}

/** Sections of the operations area (UI-M12-04..09, -16, -17); each is shown only when the staff member may read it. */
export function OpsTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (p: string) => boolean;
}) {
  const b = `/${locale}`;
  const ops = can('admin:ops:read');
  return (
    <TabBar
      locale={locale}
      label={t(locale, 'm12.ops.nav')}
      current={current}
      tabs={[
        { key: 'health', href: `${b}/operations/health`, show: ops },
        { key: 'incidents', href: `${b}/incidents`, show: ops },
        { key: 'alerts', href: `${b}/alerts`, show: ops },
        { key: 'providerIncidents', href: `${b}/provider-incidents`, show: ops },
        { key: 'exercises', href: `${b}/recovery-exercises`, show: ops },
        { key: 'launch', href: `${b}/launch`, show: ops },
        { key: 'handbook', href: `${b}/support/handbook`, show: ops },
      ]}
    />
  );
}

/** Sections of the governance area (UI-M12-10..14). */
export function GovernanceTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (p: string) => boolean;
}) {
  const b = `/${locale}`;
  const compliance = can('admin:compliance:read');
  return (
    <TabBar
      locale={locale}
      label={t(locale, 'm12.gov.nav')}
      current={current}
      tabs={[
        { key: 'reviews', href: `${b}/access-reviews`, show: can('admin:security:manage') },
        { key: 'policies', href: `${b}/policies`, show: compliance },
        { key: 'retention', href: `${b}/audit/retention`, show: compliance },
      ]}
    />
  );
}
