import { PhpSettings } from '../../../../../../../components/HostingTools';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** The PHP version of a website (a backend template on the panel). */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'php', permission: 'hosting:site:update', title: 'host.card.php' },
    ({ locale, id, site, cap }) => (
      <PhpSettings
        locale={locale}
        siteId={id}
        runtime={site.runtime}
        version={site.version}
        versions={cap.versions ?? []}
      />
    ),
  );
}
