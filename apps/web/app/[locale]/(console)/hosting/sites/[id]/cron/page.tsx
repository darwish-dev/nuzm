import { CronManager } from '../../../../../../../components/HostingTools';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** Scheduled jobs of a website. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'cron', permission: 'hosting:cron:manage', title: 'host.card.cron' },
    ({ locale, id, cap }) => (
      <CronManager
        locale={locale}
        siteId={id}
        minIntervalMinutes={cap.limits?.minIntervalMinutes ?? 5}
      />
    ),
  );
}
