import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { NewSenderForm } from '../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../components/DataParts';
import { senderDomains } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-11: sender identities (anti-spoofing: only a verified identity of the organization can send). */
export default async function Senders({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'email:read', 'm8.em.tab.senders');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await view(
    locale,
    async () => {
      const [domains, senders] = await Promise.all([
        unwrap(s.api.GET('/v1/email/domains', { params: { query: { limit: 200 } } })),
        unwrap(s.api.GET('/v1/email/sender-identities', { params: { query: { limit: 200 } } })),
      ]);
      return { domains, senders };
    },
    ({ domains, senders }) => (
      <>
        {s.can('email:domain:manage') && (
          <NewSenderForm
            locale={locale}
            domains={senderDomains(domains.items)}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
        )}
        <div style={{ marginBlockStart: 16 }}>
          {senders.items.length === 0 ? (
            <EmptyState title={t(locale, 'm8.sn.empty')} body={t(locale, 'm8.sn.emptyBody')} />
          ) : (
            <Table
              caption={t(locale, 'm8.em.tab.senders')}
              rows={senders.items}
              rowKey={(x) => x.id}
              columns={[
                {
                  key: 'f',
                  header: t(locale, 'm8.sn.from'),
                  render: (x) => <Ltr>{x.fromAddress}</Ltr>,
                },
                {
                  key: 'd',
                  header: t(locale, 'm8.emd.domain'),
                  icon: 'globe',
                  render: (x) => (
                    <Ltr>{domains.items.find((d) => d.id === x.domainId)?.domain ?? '—'}</Ltr>
                  ),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  icon: 'pulse',
                  render: (x) => (
                    <Badge
                      tone={
                        x.status === 'verified'
                          ? 'success'
                          : x.status === 'disabled'
                            ? 'danger'
                            : 'warn'
                      }
                    >
                      {t(locale, `m8.sn.status.${x.status}`)}
                    </Badge>
                  ),
                },
                {
                  key: 'v',
                  header: t(locale, 'm8.sn.verifiedAt'),
                  render: (x) => (x.verifiedAt ? formatDateTime(x.verifiedAt, locale) : '—'),
                },
              ]}
            />
          )}
        </div>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.em.title')}</PageTitle>
      <EmailTabs locale={locale} current="senders" />
      {body}
    </>
  );
}
