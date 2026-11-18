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
            <ButtonLink href={`/${locale}/compute/instances/new`}>
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
        columns={[
          {
            key: 'name',
            header: t(locale, 'field.name'),
            render: (i) => (
              <a href={`/${locale}/compute/instances/${i.id}`}>
                <Ltr>{i.name}</Ltr>
              </a>
            ),
          },
          {
            key: 'status',
            header: t(locale, 'field.status'),
            render: (i) => (
              <InstanceBadges locale={locale} status={i.status} driftState={i.driftState} />
            ),
          },
          {
            key: 'plan',
            header: t(locale, 'm05.web.f.plan'),
            render: (i) =>
              t(locale, 'm05.web.plan.summary', {
                vcpu: i.plan.vcpu,
                memory: memoryLabel(i.plan.memoryMb),
              }),
          },
          {
            key: 'region',
            header: t(locale, 'field.region'),
            render: (i) => (
              <>
                {regionLabel(locale, i.dataRegion)} <Ltr>{i.country}</Ltr>
              </>
            ),
          },
          {
            key: 'ips',
            header: t(locale, 'm05.web.f.ips'),
            render: (i) => (i.publicIps.length ? <Ltr>{i.publicIps.join(', ')}</Ltr> : '—'),
          },
          {
            key: 'created',
            header: t(locale, 'field.created'),
            render: (i) => formatDateTime(i.createdAt, locale),
          },
        ]}
      />
      {p.nextCursor && (
        <p>
          <ButtonLink
            variant="secondary"
            href={`/${locale}/compute/instances${queryString({ cursor: p.nextCursor })}`}
          >
            {t(locale, 'm05.web.page.next')}
          </ButtonLink>
        </p>
      )}
    </>
  );
}
