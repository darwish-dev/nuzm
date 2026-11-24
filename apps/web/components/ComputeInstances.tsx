import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { ButtonLink, EmptyState, Ltr, Table } from '@nuzm/ui';
import { memoryLabel, queryString, type Instance } from '../lib/compute';
import { InstanceBadges } from './ComputeBits';
import { regionLabel } from './ComputeOffers';

/** UI-M05-03: the organization's instances with provisioning / failed / drift badges. */
export function InstancesPanel(p: {
  locale: Locale;
  items: Instance[];
  nextCursor: string | null;
  canCreate: boolean;
}) {
  const { locale } = p;
  if (p.items.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.web.instances.empty.title')}
        body={t(locale, 'm05.web.instances.empty.body')}
        action={
          p.canCreate ? (
            <ButtonLink href={`/compute/instances/new`}>
              {t(locale, 'm05.web.instances.create')}
            </ButtonLink>
          ) : undefined
        }
      />
    );
  return (
    <>
      <Table
        caption={t(locale, 'm05.web.instances.title')}
        rows={p.items}
        rowKey={(i) => i.id}
        cardIcon="cloud"
        rowHref={(i) => `/compute/instances/${i.id}`}
        manageLabel={t(locale, 'action.manage')}
        columns={[
          {
            key: 'name',
            card: 'title',
            header: t(locale, 'field.name'),
            render: (i) => (
              <a href={`/compute/instances/${i.id}`}>
                <Ltr>{i.name}</Ltr>
              </a>
            ),
          },
          {
            key: 'status',
            card: 'badge',
            header: t(locale, 'field.status'),
            icon: 'pulse',
            render: (i) => (
              <InstanceBadges locale={locale} status={i.status} driftState={i.driftState} />
            ),
          },
          {
            key: 'plan',
            card: 'subtitle',
            header: t(locale, 'm05.web.f.plan'),
            icon: 'tag',
            render: (i) =>
              t(locale, 'm05.web.plan.summary', {
                vcpu: i.plan.vcpu,
                memory: memoryLabel(i.plan.memoryMb),
              }),
          },
          {
            key: 'region',
            card: 'chip',
            header: t(locale, 'field.region'),
            icon: 'pin',
            render: (i) => (
              <>
                {regionLabel(locale, i.dataRegion)} <Ltr>{i.country}</Ltr>
              </>
            ),
          },
          {
            key: 'ips',
            card: 'footer',
            header: t(locale, 'm05.web.f.ips'),
            render: (i) => (i.publicIps.length ? <Ltr>{i.publicIps.join(', ')}</Ltr> : '—'),
          },
          {
            key: 'created',
            card: 'meta',
            header: t(locale, 'field.created'),
            icon: 'calendar',
            render: (i) => formatDateTime(i.createdAt, locale),
          },
        ]}
      />
      {p.nextCursor && (
        <p>
          <ButtonLink
            variant="secondary"
            href={`/compute/instances${queryString({ cursor: p.nextCursor })}`}
          >
            {t(locale, 'm05.web.page.next')}
          </ButtonLink>
        </p>
      )}
    </>
  );
}
