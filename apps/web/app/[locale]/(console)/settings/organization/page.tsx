import { StackedScreens } from '../../../../../sections/stack';
import AuditLogs from '../../../../../sections/audit-logs';
import OrgSettings from '../../../../../sections/org-settings';

/** The organization: its settings and the audit log on one page (opened from the account menu). */
export default async function Organization(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="nc.grp.organization"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'settings', title: 'settings.org.title', perm: ['org:update'], Screen: OrgSettings },
        { id: 'audit', title: 'audit.title', perm: ['audit:read'], Screen: AuditLogs },
      ]}
    />
  );
}
