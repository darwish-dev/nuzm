import { FtpManager } from '../../../../../../../components/HostingTools';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** FTP accounts of a website. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'ftp', permission: 'hosting:ftp:manage', title: 'host.card.access' },
    ({ locale, id, domains }) => <FtpManager locale={locale} siteId={id} domains={domains} />,
  );
}
