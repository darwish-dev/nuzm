import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { NewWebhookForm, RotateSecret } from '../../../../../components/AutomationPanels';
import { AutomationTabs } from '../../../../../components/AutomationTabs';
import { DisabledAction, Section, Status } from '../../../../../components/M11Parts';
import { FLAGS, itemsOf, type WebhookEndpointDto } from '../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../lib/m11-server';

/**
 * UI-M11-05: outbound webhook endpoints: create (the signing secret is shown ONCE) and rotate the secret (POST with `secretRotation`; both secrets sign during the overlap).
 * The delivery log and the "send a test event" action need routes that are SCR-M11-02 (not approved): they are shown DISABLED with that reason, never faked.
 */
export default async function Webhooks({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'webhook:manage',
    title: 'm11.wh.title',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const factor = s.me.mfaFactorId ?? null;
  const body = await m11View(
    locale,
    async () =>
      itemsOf<WebhookEndpointDto>(
        await unwrap(s.api.GET('/v1/webhook-endpoints', { params: { query: { limit: 100 } } })),
      ),
    (items) => (
      <>
        <NewWebhookForm locale={locale} mfaFactorId={factor} />
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm11.wh.title')}
        </h2>
        {items.length === 0 ? (
          <EmptyState title={t(locale, 'm11.wh.empty')} body={t(locale, 'm11.wh.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm11.wh.title')}
            rows={items}
            rowKey={(e) => e.id}
            columns={[
              {
                key: 'u',
                header: t(locale, 'm11.wh.url'),
                render: (e) => (
                  <>
                    <Ltr>{e.url}</Ltr>
                    {e.description && (
                      <p className="nz-muted">
                        <bdi dir="auto">{e.description}</bdi>
                      </p>
                    )}
                  </>
                ),
              },
              {
                key: 'ev',
                header: t(locale, 'm11.wh.events'),
                render: (e) => e.events.map((x) => <Badge key={x}>{x}</Badge>),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (e) => (
                  <>
                    <Status
                      locale={locale}
                      prefix="m11.wh.status"
                      value={e.status}
                      tone={e.status === 'active' ? 'success' : 'warn'}
                    />
                    {e.consecutiveFailures > 0 && (
                      <p className="nz-muted">
                        {t(locale, 'm11.wh.failures', { n: e.consecutiveFailures })}
                      </p>
                    )}
                  </>
                ),
              },
              {
                key: 'r',
                header: t(locale, 'm11.wh.rotation'),
                render: (e) =>
                  e.secretRotation.overlapUntil
                    ? t(locale, 'm11.wh.overlapUntil', {
                        time: formatDateTime(e.secretRotation.overlapUntil, locale),
                      })
                    : '—',
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                render: (e) => <RotateSecret locale={locale} endpoint={e} mfaFactorId={factor} />,
              },
            ]}
          />
        )}
        <Section title={t(locale, 'm11.wh.deliveries')} help={t(locale, 'm11.wh.deliveriesHelp')}>
          <div style={{ display: 'grid', gap: 8 }}>
            <DisabledAction
              id="wh-deliveries"
              label={t(locale, 'm11.wh.viewDeliveries')}
              reason={t(locale, 'm11.wh.scr02')}
            />
            <DisabledAction
              id="wh-test"
              label={t(locale, 'm11.wh.testEvent')}
              reason={t(locale, 'm11.wh.scr02')}
            />
          </div>
        </Section>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.wh.title')}</PageTitle>
      <AutomationTabs locale={locale} current="webhooks" />
      {body}
    </>
  );
}
