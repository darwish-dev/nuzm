'use client';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Ltr } from '@nuzm/ui';
import type { ApprovalRef } from '../lib/appbuilder';
import { Word } from './BuilderParts';

/** 403 `approval_required`: the approvals a deploy or rollback is waiting for, each with the hash it is bound to, and the way to decide them. */
export function ApprovalNeeded({ locale, items }: { locale: Locale; items: ApprovalRef[] }) {
  return (
    <Banner tone="warn">
      <p style={{ margin: 0 }}>
        <strong>{t(locale, 'm10.dep.approvalNeeded')}</strong>{' '}
        {t(locale, 'm10.dep.approvalNeededBody')}
      </p>
      <ul>
        {items.map((a) => (
          <li key={a.id}>
            <Word locale={locale} prefix="m10.apr.type" value={a.type} /> —{' '}
            {t(locale, 'm10.apr.scopeHash')}: <Ltr>{a.scopeHash}</Ltr>
          </li>
        ))}
      </ul>
      <a href={`/${locale}/approvals`}>{t(locale, 'm10.dep.openApprovals')}</a>
    </Banner>
  );
}
