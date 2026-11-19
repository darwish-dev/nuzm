import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, Icon } from '@nuzm/ui';
import { PROJECT_FILTERS, type ProjectFilter } from '../lib/appworkspace';
import { isPreviewUrl, LOCALE_LABEL, type Project, type SiteLocale } from '../lib/builder';
import { DeployBadge, when } from './BuilderBits';

/** UI-M09-01: one card per website project; an empty list offers the first one. */
/** A mobile app opens in the mobile workspace; every other project in the builder workspace. */
export const projectHref = (locale: Locale, p: Pick<Project, 'id' | 'type'>) =>
  p.type === 'mobile' ? `/${locale}/mobile/${p.id}` : `/${locale}/builder/projects/${p.id}`;

export function ProjectCards({
  locale,
  items,
  nextCursor,
  canCreate,
  filtered,
}: {
  locale: Locale;
  items: Project[];
  nextCursor: string | null;
  canCreate: boolean;
  /** a type filter is on: an empty list says "none of this type", not "no projects" */
  filtered?: boolean;
}) {
  if (items.length === 0 && filtered)
    return (
      <EmptyState
        title={t(locale, 'm10a.proj.filtered.title')}
        body={t(locale, 'm10a.proj.filtered.body')}
      />
    );
  if (items.length === 0)
    return (
      <EmptyState
        title={t(locale, 'bld.projects.empty.title')}
        body={t(locale, canCreate ? 'bld.projects.empty.body' : 'state.empty.body')}
        action={
          canCreate ? (
            <ButtonLink href={`/${locale}/builder/new`}>
              {t(locale, 'bld.projects.create')}
            </ButtonLink>
          ) : undefined
        }
      />
    );
  return (
    <>
      <ul className="bl-pgrid" aria-label={t(locale, 'bld.title.projects')}>
        {items.map((p) => (
          <li key={p.id}>
            <article className="bl-pcard" aria-labelledby={`bld-p-${p.id}`} data-type={p.type}>
              <a
                className="bl-pcover"
                href={projectHref(locale, p)}
                tabIndex={-1}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
                <span className="bl-pcover-icon">
                  <Icon
                    name={p.type === 'mobile' ? 'phone' : p.type === 'webapp' ? 'code' : 'globe'}
                    size={22}
                  />
                </span>
              </a>
              <div className="bl-pbody">
                <div className="bl-ptop">
                  <h2 id={`bld-p-${p.id}`}>
                    <a href={projectHref(locale, p)}>{p.name}</a>
                  </h2>
                  <Badge>{tDynamic(locale, `m10.proj.type.${p.type}`, p.type)}</Badge>
                </div>
                <dl className="bl-pmeta">
                  <div>
                    <dt>{t(locale, 'bld.projects.locales')}</dt>
                    <dd>{p.locales.map((l) => LOCALE_LABEL[l as SiteLocale] ?? l).join(' · ')}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, 'bld.projects.lastDeployment')}</dt>
                    <dd>
                      {p.lastDeployment ? (
                        <>
                          <DeployBadge locale={locale} state={p.lastDeployment.state} />{' '}
                          {p.lastDeployment.url && isPreviewUrl(`${p.lastDeployment.url}/`) ? (
                            <a
                              href={p.lastDeployment.url}
                              rel="noopener noreferrer"
                              target="_blank"
                            >
                              <Ltr>{p.lastDeployment.url}</Ltr>
                            </a>
                          ) : null}
                        </>
                      ) : (
                        t(locale, 'bld.projects.neverDeployed')
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(locale, 'bld.projects.updated')}</dt>
                    <dd>{when(p.updatedAt, locale)}</dd>
                  </div>
                </dl>
                <a className="bl-popen" href={projectHref(locale, p)}>
                  {t(locale, 'action.manage')}
                  <Icon name="arrow" size={16} />
                </a>
              </div>
            </article>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <ButtonLink
          variant="secondary"
          href={`/${locale}/builder/projects?cursor=${encodeURIComponent(nextCursor)}`}
        >
          {t(locale, 'action.loadMore')}
        </ButtonLink>
      )}
    </>
  );
}

/** Type filter of the project list (links, so it works without scripting and is shareable). "Web apps" is offered only while the app builder is on. */
export function ProjectFilterTabs({
  locale,
  current,
  appsEnabled,
}: {
  locale: Locale;
  current: ProjectFilter;
  appsEnabled: boolean;
}) {
  const tabs = PROJECT_FILTERS.filter((f) => appsEnabled || f !== 'webapp');
  if (!appsEnabled) return null;
  return (
    <nav aria-label={t(locale, 'm10a.proj.filter')} className="bl-chips">
      {tabs.map((f) => (
        <a
          key={f}
          className="bl-chip"
          href={`/${locale}/builder/projects${f === 'all' ? '' : `?type=${f}`}`}
          aria-current={f === current ? 'page' : undefined}
        >
          {t(locale, `m10a.proj.filter.${f}`)}
        </a>
      ))}
    </nav>
  );
}
