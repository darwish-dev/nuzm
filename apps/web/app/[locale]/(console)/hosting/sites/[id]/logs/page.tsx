import { LogViewer } from '../../../../../../../components/HostingTools';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** Access and error logs of a website, a bounded number of lines. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'logs', permission: 'hosting:logs:read', title: 'host.card.logs' },
    ({ locale, id, cap, domains }) => (
      <LogViewer
        locale={locale}
        siteId={id}
        domains={domains}
        linesDefault={cap.limits?.linesDefault ?? 100}
        linesMax={cap.limits?.linesMax ?? 500}
      />
    ),
  );
}
