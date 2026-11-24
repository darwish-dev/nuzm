import { FileManager } from '../../../../../../../components/HostingFiles';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** The file manager of a website (SFTP as the site account, inside the website folder). */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'files', permission: 'hosting:files:read', title: 'host.card.files' },
    ({ s, locale, id, cap, domains }) => (
      <FileManager
        locale={locale}
        siteId={id}
        domains={domains}
        uploadMb={cap.limits?.uploadMb ?? 25}
        canWrite={s.can('hosting:files:write')}
      />
    ),
  );
}
