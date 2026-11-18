import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, PageTitle, Table } from '@nuzm/ui';
import { AddDomainForm } from '../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../components/DataParts';
import { domainTone, recordSummary, type DnsRecord } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-08: email domains with their verification state and DNS record status. */
export default async function EmailDomains({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'email:read', 'm8.em.tab.domains');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/email/domains', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'm8.emd.empty')} body={t(locale, 'm8.emd.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm8.em.tab.domains')}
          rows={data.items}
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'd',
              header: t(locale, 'm8.emd.domain'),
              render: (d) => <a href={`/${locale}/email/domains/${d.id}`}>{d.domain}</a>,
            },
            {
              key: 'p',
              header: t(locale, 'm8.emd.purposes'),
              render: (d) =>
                d.purposes.map((p) => tDynamic(locale, `m8.emd.purpose.${p}`, p)).join(' · '),
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (d) => (
                <Badge tone={domainTone(d.state)}>
                  {tDynamic(locale, `m8.emd.state.${d.state}`, d.state)}
                </Badge>
              ),
            },
            {
              key: 'r',
              header: t(locale, 'm8.emd.dns'),
              render: (d) => {
                const sum = recordSummary(d.requiredRecords as DnsRecord[]);
                return t(locale, 'm8.emd.summary', { ok: sum.ok, total: sum.total });
              },
            },
            {
              key: 'c',
              header: t(locale, 'm8.emd.col.checked'),
              render: (d) => (d.lastCheckedAt ? formatDateTime(d.lastCheckedAt, locale) : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.em.title')}</PageTitle>
      <EmailTabs locale={locale} current="domains" />
      <p className="nz-muted">{t(locale, 'm8.emd.help')}</p>
      {s.can('email:domain:manage') && (
        <AddDomainForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      )}
      <div style={{ marginBlockStart: 16 }}>{body}</div>
    </>
  );
}
