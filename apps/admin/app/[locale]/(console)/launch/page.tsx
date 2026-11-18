import { t } from '@nuzm/i18n';
import { Banner, Card, Ltr, PageTitle } from '@nuzm/ui';
import { OpsTabs } from '../../../../components/M12Tabs';
import { gate } from '../../../../lib/gate';
import { GA_CHECKLIST_PATH } from '../../../../lib/handbook';

/**
 * UI-M12-16: launch readiness: READ-ONLY and static. The read/write endpoint for launch gates is not approved (SCR-M12-03), so this page fetches
 * nothing, shows no gate status and records no decision. Go/no-go is the owner's, outside this screen.
 */
export default async function Launch({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'admin:ops:read', 'm12.launch.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  return (
    <>
      <PageTitle>{t(locale, 'm12.launch.title')}</PageTitle>
      <OpsTabs locale={locale} current="launch" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.launch.notApproved')}</Banner>
      <Card aria-labelledby="ln-board">
        <h2 className="nz-h2" id="ln-board">
          {t(locale, 'm12.launch.board')}
        </h2>
        <p>{t(locale, 'm12.launch.readOnly')}</p>
        <p>{t(locale, 'm12.launch.noDecision')}</p>
      </Card>
      <Card aria-labelledby="ln-check">
        <h2 className="nz-h2" id="ln-check">
          {t(locale, 'm12.launch.checklist')}
        </h2>
        <p>{t(locale, 'm12.launch.checklistBody')}</p>
        <p>
          <Ltr>{GA_CHECKLIST_PATH}</Ltr>
        </p>
      </Card>
    </>
  );
}
