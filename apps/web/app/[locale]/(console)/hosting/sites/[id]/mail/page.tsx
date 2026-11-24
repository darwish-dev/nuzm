import { MailManager } from '../../../../../../../components/HostingMail';
import { toolPage } from '../../../../../../../lib/hosting-tool-page';

/** Business email of a website. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return toolPage(
    params,
    { tool: 'mail', permission: 'hosting:mail:read', title: 'host.card.mail' },
    ({ s, locale, id }) => (
      <MailManager locale={locale} siteId={id} canManage={s.can('hosting:mail:manage')} />
    ),
  );
}
