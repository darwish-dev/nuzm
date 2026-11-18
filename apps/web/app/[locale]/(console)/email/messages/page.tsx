import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { MessageTimeline, SendTestForm } from '../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../components/DataParts';
import { messageTone } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

const STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'unknown',
];

/** UI-M08-13: message log (metadata only: never recipients or content) with status and sender filters, the event timeline and a small "send test" form. */
export default async function Messages({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; senderId?: string }>;
}) {
  const g = await gate(params, 'email:read', 'm8.em.tab.messages');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { status, senderId } = await searchParams;
  const statusFilter = status && STATUSES.includes(status) ? status : '';
  const senderFilter = senderId && /^[0-9a-f-]{36}$/i.test(senderId) ? senderId : '';
  const body = await view(
    locale,
    async () => {
      const [messages, senders] = await Promise.all([
        unwrap(
          s.api.GET('/v1/email/messages', {
            params: {
              query: {
                limit: 100,
                ...(statusFilter ? { status: statusFilter } : {}),
                ...(senderFilter ? { senderId: senderFilter } : {}),
              },
            },
          }),
        ),
        unwrap(s.api.GET('/v1/email/sender-identities', { params: { query: { limit: 200 } } })),
      ]);
      return { messages, senders };
    },
    ({ messages, senders }) => (
      <>
        {s.can('email:send') && (
          <SendTestForm
            locale={locale}
            senders={senders.items}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
        )}
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm8.ms.log')}
        </h2>
        <form method="get" className="nz-row" aria-label={t(locale, 'm8.ms.filter')}>
          <label htmlFor="ms-f-status">{t(locale, 'field.status')}</label>
          <select id="ms-f-status" name="status" className="nz-input" defaultValue={statusFilter}>
            <option value="">{t(locale, 'm8.ms.allStatuses')}</option>
            {STATUSES.map((x) => (
              <option key={x} value={x}>
                {tDynamic(locale, `m8.ms.status.${x}`, x)}
              </option>
            ))}
          </select>
          <label htmlFor="ms-f-sender">{t(locale, 'm8.ms.sender')}</label>
          <select id="ms-f-sender" name="senderId" className="nz-input" defaultValue={senderFilter}>
            <option value="">{t(locale, 'm8.ms.allStatuses')}</option>
            {senders.items.map((x) => (
              <option key={x.id} value={x.id}>
                {x.fromAddress}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary">
            {t(locale, 'action.search')}
          </Button>
        </form>
        {messages.items.length === 0 ? (
          <EmptyState title={t(locale, 'm8.ms.empty')} body={t(locale, 'm8.ms.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm8.ms.log')}
            rows={messages.items}
            rowKey={(m) => m.id}
            columns={[
              {
                key: 'c',
                header: t(locale, 'field.created'),
                render: (m) => formatDateTime(m.createdAt, locale),
              },
              {
                key: 'f',
                header: t(locale, 'm8.ms.sender'),
                render: (m) => (
                  <Ltr>{senders.items.find((x) => x.id === m.senderId)?.fromAddress ?? '—'}</Ltr>
                ),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (m) => (
                  <>
                    <Badge tone={messageTone(m.status)}>
                      {tDynamic(locale, `m8.ms.status.${m.status}`, m.status)}
                    </Badge>
                    {m.errorCode && (
                      <p className="nz-muted">
                        <Ltr>{m.errorCode}</Ltr>
                      </p>
                    )}
                  </>
                ),
              },
              {
                key: 'r',
                header: t(locale, 'm8.ms.recipients'),
                render: (m) => <Ltr>{String(m.recipientCount)}</Ltr>,
              },
              {
                key: 'a',
                header: t(locale, 'm8.ms.accepted'),
                render: (m) => (m.acceptedAt ? formatDateTime(m.acceptedAt, locale) : '—'),
              },
              {
                key: 't',
                header: t(locale, 'm8.ms.timeline'),
                render: (m) => <MessageTimeline locale={locale} id={m.id} />,
              },
            ]}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.em.title')}</PageTitle>
      <EmailTabs locale={locale} current="messages" />
      {body}
    </>
  );
}
