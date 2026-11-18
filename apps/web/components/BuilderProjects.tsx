import { t, type Locale } from '@nuzm/i18n';
import { Card, ButtonLink, EmptyState, Ltr } from '@nuzm/ui';
import { isPreviewUrl, LOCALE_LABEL, type Project, type SiteLocale } from '../lib/builder';
import { DeployBadge, when } from './BuilderBits';

/** UI-M09-01: one card per website project; an empty list offers the first one. */
export function ProjectCards({
  locale,
  items,
  nextCursor,
  canCreate,
}: {
  locale: Locale;
  items: Project[];
  nextCursor: string | null;
  canCreate: boolean;
}) {
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
      <ul className="nz-grid bld-list" aria-label={t(locale, 'bld.title.projects')}>
        {items.map((p) => (
          <li key={p.id}>
            <Card aria-labelledby={`bld-p-${p.id}`}>
              <h2 className="nz-h2" id={`bld-p-${p.id}`}>
                <a href={`/${locale}/builder/projects/${p.id}`}>{p.name}</a>
              </h2>
              <dl>
                <dt>{t(locale, 'bld.projects.locales')}</dt>
                <dd>{p.locales.map((l) => LOCALE_LABEL[l as SiteLocale] ?? l).join(' · ')}</dd>
                <dt>{t(locale, 'bld.projects.lastDeployment')}</dt>
                <dd>
                  {p.lastDeployment ? (
                    <>
                      <DeployBadge locale={locale} state={p.lastDeployment.state} />{' '}
                      {p.lastDeployment.url && isPreviewUrl(`${p.lastDeployment.url}/`) ? (
                        <a href={p.lastDeployment.url} rel="noopener noreferrer" target="_blank">
                          <Ltr>{p.lastDeployment.url}</Ltr>
                        </a>
                      ) : null}
                    </>
                  ) : (
                    t(locale, 'bld.projects.neverDeployed')
                  )}
                </dd>
                <dt>{t(locale, 'bld.projects.updated')}</dt>
                <dd>{when(p.updatedAt, locale)}</dd>
              </dl>
            </Card>
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
