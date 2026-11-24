import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Icon, type IconName } from '@nuzm/ui';
import { StackSection } from '../../../../../components/StackSection';
import { OrgWorkspaces } from '../../../../../components/OrgWorkspaces';
import { requireSession } from '../../../../../lib/server';
import AuditLogs from '../../../../../sections/audit-logs';
import OrgSettings from '../../../../../sections/org-settings';
import AiStudioSettingsScreen from '../../../../../sections/ai-studio-settings';

/** A figure this member may not see, or that fails to load, is left out: nothing is invented. */
const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

/**
 * The organization, on one page (opened from the organization button in the top bar): a header with its name, type and a few figures, quick links to
 * each part, then its settings, its workspaces with their projects, the AI Studio switches and the audit log. Each part shows only with its permission.
 */
export default async function Organization(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await props.params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const orgId = s.org.orgId;
  const canWs = s.can('workspace:read');
  const canPr = s.can('project:read');
  const [org, ws, pr] = await Promise.all([
    safe(unwrap(s.api.GET('/v1/organizations/{orgId}', { params: { path: { orgId } } }))),
    canWs ? safe(unwrap(s.api.GET('/v1/workspaces', { params: { query: { limit: 100 } } }))) : null,
    canPr ? safe(unwrap(s.api.GET('/v1/projects', { params: { query: { limit: 100 } } }))) : null,
  ]);

  const parts: { id: string; label: string; icon: IconName; show: boolean }[] = [
    {
      id: 'settings',
      label: t(locale, 'org.nav.general'),
      icon: 'organization',
      show: s.can('org:update'),
    },
    {
      id: 'workspaces',
      label: t(locale, 'org.nav.workspaces'),
      icon: 'projects',
      show: Boolean(ws),
    },
    {
      id: 'ai-studio',
      label: t(locale, 'ais.set.title'),
      icon: 'sparkle',
      show: s.can('org:update'),
    },
    { id: 'audit', label: t(locale, 'audit.title'), icon: 'shield', show: s.can('audit:read') },
  ];
  const shown = parts.filter((x) => x.show);
  const name = org?.name ?? s.org.name;
  const params = props.params;
  const searchParams = props.searchParams;

  return (
    <div className="nzc-orgp">
      <header className="nzc-orgp-hero">
        <span className="nzc-orgp-avatar" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase() || 'N'}
        </span>
        <div className="nzc-orgp-id">
          <h1>{name}</h1>
          <p>
            <Badge>{t(locale, `org.type.${s.org.type}`)}</Badge>
            <span>{t(locale, 'org.page.sub')}</span>
          </p>
        </div>
        <dl className="nzc-orgp-stats">
          {ws && (
            <div>
              <dt>{t(locale, 'org.stat.workspaces')}</dt>
              <dd>{ws.items.length}</dd>
            </div>
          )}
          {pr && (
            <div>
              <dt>{t(locale, 'org.stat.projects')}</dt>
              <dd>{pr.items.length}</dd>
            </div>
          )}
          {org && (
            <div>
              <dt>{t(locale, 'org.stat.language')}</dt>
              <dd>{org.defaultLocale === 'ar' ? 'العربية' : 'English'}</dd>
            </div>
          )}
        </dl>
      </header>

      {shown.length > 1 && (
        <nav className="nzc-orgp-nav" aria-label={t(locale, 'nc.grp.organization')}>
          {shown.map((x) => (
            <a key={x.id} href={`#${x.id}`}>
              <Icon name={x.icon} size={16} />
              {x.label}
            </a>
          ))}
        </nav>
      )}

      {shown.length === 0 ? (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      ) : (
        <div className="nzc-stack">
          {s.can('org:update') && (
            <StackSection id="settings" title={t(locale, 'settings.org.title')}>
              <OrgSettings params={params} />
            </StackSection>
          )}
          {ws && (
            <StackSection id="workspaces" title={t(locale, 'org.nav.workspaces')}>
              <OrgWorkspaces
                locale={locale}
                workspaces={ws.items}
                projects={pr?.items ?? []}
                can={{
                  wsCreate: s.can('workspace:create'),
                  wsDelete: s.can('workspace:delete'),
                  prCreate: s.can('project:create'),
                  prDelete: s.can('project:delete'),
                }}
              />
            </StackSection>
          )}
          {s.can('org:update') && (
            <StackSection id="ai-studio" title={t(locale, 'ais.set.title')}>
              <AiStudioSettingsScreen params={params} />
            </StackSection>
          )}
          {s.can('audit:read') && (
            <StackSection id="audit" title={t(locale, 'audit.title')}>
              <AuditLogs params={params} searchParams={searchParams} />
            </StackSection>
          )}
        </div>
      )}
    </div>
  );
}
