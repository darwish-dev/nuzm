import { ProtectionManager } from '../../../../../../../components/HostingTools';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** Password protection of a website's domains. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'protection', permission: 'hosting:protection:manage', title: 'host.card.security' },
    ({ locale, id }) => <ProtectionManager locale={locale} siteId={id} />,
  );
}
