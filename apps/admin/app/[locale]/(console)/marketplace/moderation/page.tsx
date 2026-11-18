import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, Card, ForbiddenState, PageTitle } from '@nuzm/ui';
import { ModerationForm } from '../../../../../components/M11AdminPanels';
import { requireStaff } from '../../../../../lib/server';

/**
 * UI-M11-20: marketplace moderation. The QUEUE and the scan results cannot be read (the list route is SCR-M11-05, not approved), so that part is an honest BLOCKED state. The one thing the API
 * supports is the decision itself: it is offered as a form that takes the listing id (and, optionally, the version id).
 */
export default async function Moderation({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:marketplace'))
    return (
      <>
        <PageTitle>{t(locale, 'm11.adm.mod.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  return (
    <>
      <PageTitle>{t(locale, 'm11.adm.mod.title')}</PageTitle>
      <Card aria-label={t(locale, 'm11.adm.mod.queue')}>
        <p>
          <Badge tone="warn">BLOCKED</Badge>
        </p>
        <h2 className="nz-h2">{t(locale, 'm11.adm.mod.queue')}</h2>
        <p>{t(locale, 'm11.adm.mod.queueBlocked')}</p>
        <p className="nz-muted">
          {t(locale, 'm11.blocked.missing')} {t(locale, 'm11.adm.mod.queueMissing')}
        </p>
      </Card>
      <div style={{ marginBlockStart: 16 }}>
        <ModerationForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      </div>
    </>
  );
}
