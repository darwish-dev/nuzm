import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, Card, ForbiddenState, PageTitle } from '@nuzm/ui';
import { requireStaff } from '../../../../../lib/server';

/**
 * UI-M11-22: automation abuse: paused workflows, anomaly cases and the dead-letter monitor. BLOCKED: the platform-side reads and the admin pause/resume routes are SCR-M11-05 (not approved); the
 * abuse rules and the administrator pause exist in the service, and the organization sees an administrator pause on its own workflow, but nothing can be listed or acted on from here yet.
 */
export default async function AutomationAbuse({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:automation') && !s.can('admin:ops'))
    return (
      <>
        <PageTitle>{t(locale, 'm11.adm.abuse.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  return (
    <>
      <PageTitle>{t(locale, 'm11.adm.abuse.title')}</PageTitle>
      {(['paused', 'anomalies', 'dlq'] as const).map((k) => (
        <div key={k} style={{ marginBlockEnd: 16 }}>
          <Card aria-label={t(locale, `m11.adm.abuse.${k}.title`)}>
            <p>
              <Badge tone="warn">BLOCKED</Badge>
            </p>
            <h2 className="nz-h2">{t(locale, `m11.adm.abuse.${k}.title`)}</h2>
            <p>{t(locale, `m11.adm.abuse.${k}.body`)}</p>
            <p className="nz-muted">
              {t(locale, 'm11.blocked.missing')} {t(locale, 'm11.adm.abuse.missing')}
            </p>
          </Card>
        </div>
      ))}
    </>
  );
}
