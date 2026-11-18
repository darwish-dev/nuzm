import { t, type Locale } from '@nuzm/i18n';

export function ComplianceTabs({ locale, current }: { locale: Locale; current: string }) {
  const base = `/${locale}/compliance`;
  const tabs = [
    'controls',
    'evidence',
    'validations',
    'breach-cases',
    'ropa',
    'retention',
    'transfer-assessments',
  ] as const;
  const label = {
    controls: 'cmp.tab.controls',
    evidence: 'cmp.tab.evidence',
    validations: 'cmp.tab.validations',
    'breach-cases': 'cmp.tab.breach',
    ropa: 'cmp.tab.ropa',
    retention: 'cmp.tab.retention',
    'transfer-assessments': 'cmp.tab.transfer',
  } as const;
  return (
    <nav aria-label={t(locale, 'cmp.nav')} className="nz-row nz-subnav">
      {tabs.map((k) => (
        <a
          key={k}
          className="nz-btn"
          data-variant={k === current ? 'primary' : 'secondary'}
          href={`${base}/${k}`}
          aria-current={k === current ? 'page' : undefined}
        >
          {t(locale, label[k])}
        </a>
      ))}
    </nav>
  );
}
