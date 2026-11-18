import { unwrap } from '@nuzm/sdk';
import { t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import {
  MailboxActions,
  NewAliasForm,
  NewMailboxForm,
} from '../../../../../components/EmailPanels';
import { EmailTabs, StatusBadge } from '../../../../../components/DataParts';
import { mailboxDomains, mailboxTone } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-10: mailboxes and aliases. The password setup shows only its KIND; the one-time reveal is a proposed addition (PA-19), pending approval. */
export default async function Mailboxes({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'email:read', 'm8.em.tab.mailboxes');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const manage = s.can('email:mailbox:manage');
  const factor = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    async () => {
      const [domains, mailboxes, aliases] = await Promise.all([
        unwrap(s.api.GET('/v1/email/domains', { params: { query: { limit: 200 } } })),
        unwrap(s.api.GET('/v1/email/mailboxes', { params: { query: { limit: 200 } } })),
        unwrap(s.api.GET('/v1/email/aliases', { params: { query: { limit: 200 } } })),
      ]);
      return { domains, mailboxes, aliases };
    },
    ({ domains, mailboxes, aliases }) => (
      <>
        {manage && (
          <>
            <NewMailboxForm
              locale={locale}
              domains={mailboxDomains(domains.items)}
              mfaFactorId={factor}
            />
            <div style={{ marginBlockStart: 16 }}>
              <NewAliasForm locale={locale} mailboxes={mailboxes.items} mfaFactorId={factor} />
            </div>
          </>
        )}
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm8.em.tab.mailboxes')}
        </h2>
        {mailboxes.items.length === 0 ? (
          <EmptyState title={t(locale, 'm8.mb.empty')} body={t(locale, 'm8.mb.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm8.em.tab.mailboxes')}
            rows={mailboxes.items}
            rowKey={(m) => m.id}
            columns={[
              {
                key: 'a',
                header: t(locale, 'm8.mb.address'),
                render: (m) => <Ltr>{m.address}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (m) => (
                  <StatusBadge
                    locale={locale}
                    prefix="m8.mb.status"
                    value={m.status}
                    tone={mailboxTone(m.status)}
                  />
                ),
              },
              {
                key: 'q',
                header: t(locale, 'm8.mb.quota'),
                render: (m) => <Ltr>{`${m.quotaMb} MB`}</Ltr>,
              },
              {
                key: 'p',
                header: t(locale, 'm8.mb.password'),
                render: (m) =>
                  m.passwordSetup ? (
                    <>
                      <Badge>{t(locale, `m8.mb.setup.${m.passwordSetup.kind}.short`)}</Badge>
                      <p className="nz-muted">{t(locale, 'm8.mb.revealPendingShort')}</p>
                    </>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                render: (m) => (
                  <MailboxActions
                    locale={locale}
                    mailbox={m}
                    canManage={manage}
                    mfaFactorId={factor}
                  />
                ),
              },
            ]}
          />
        )}
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm8.al.title')}
        </h2>
        {aliases.items.length === 0 ? (
          <p className="nz-muted">{t(locale, 'm8.al.empty')}</p>
        ) : (
          <Table
            caption={t(locale, 'm8.al.title')}
            rows={aliases.items}
            rowKey={(a) => a.id}
            columns={[
              {
                key: 'a',
                header: t(locale, 'm8.mb.address'),
                render: (a) => <Ltr>{a.address}</Ltr>,
              },
              {
                key: 'm',
                header: t(locale, 'm8.al.mailbox'),
                render: (a) => (
                  <Ltr>{mailboxes.items.find((m) => m.id === a.mailboxId)?.address ?? '—'}</Ltr>
                ),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (a) => tDynamic(locale, `m8.al.status.${a.status}`, a.status),
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
      <EmailTabs locale={locale} current="mailboxes" />
      {body}
    </>
  );
}
