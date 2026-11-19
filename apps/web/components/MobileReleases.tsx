import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, Table } from '@nuzm/ui';
import { releaseTone, type MobileRelease } from '../lib/mobile';
import { MissingList, NoSubmitNotice } from './MobileParts';

/** UI-M10-16: the release-preparation records of a mobile project: version, store, status, and what is still missing for "Prepared". */
export function MobileReleases({
  locale,
  projectId,
  items,
  canCreate,
}: {
  locale: Locale;
  projectId: string;
  items: MobileRelease[];
  canCreate: boolean;
}) {
  return (
    <>
      <NoSubmitNotice locale={locale} />
      {canCreate && (
        <p>
          <ButtonLink href={`/${locale}/mobile/${projectId}/releases/new`}>
            {t(locale, 'mobile.releases.new')}
          </ButtonLink>
        </p>
      )}
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'mobile.releases.empty.title')}
          body={t(locale, 'mobile.releases.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'mobile.releases.caption')}
          rows={items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'version',
              header: t(locale, 'mobile.releases.col.version'),
              card: 'title',
              render: (r) => <Ltr>{`${r.versionName} (${r.versionCode})`}</Ltr>,
            },
            {
              key: 'store',
              header: t(locale, 'mobile.releases.col.store'),
              card: 'chip',
              render: (r) => tDynamic(locale, `mobile.releases.store.${r.store}`, r.store),
            },
            {
              key: 'status',
              header: t(locale, 'mobile.releases.col.status'),
              card: 'badge',
              render: (r) => (
                <Badge tone={releaseTone(r.status)}>
                  {tDynamic(locale, `mobile.releases.status.${r.status}`, r.status)}
                </Badge>
              ),
            },
            {
              key: 'created',
              header: t(locale, 'mobile.releases.col.created'),
              card: 'meta',
              render: (r) => formatDateTime(r.createdAt, locale),
            },
            {
              key: 'missing',
              header: t(locale, 'mobile.releases.missing'),
              card: 'footer',
              render: (r) =>
                r.status === 'draft' && r.missing.length > 0 ? (
                  <MissingList locale={locale} items={r.missing} />
                ) : null,
            },
          ]}
        />
      )}
    </>
  );
}
