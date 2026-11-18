import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { ButtonLink, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireSession } from '../../../lib/server';
import { flagEnabled, visibleServices } from '../../../lib/services';
import { view } from '../../../lib/view';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const name = s.me.displayName ?? s.me.email;
  if (!s.org)
    return (
      <>
        <PageTitle>{t(locale, 'home.title', { name })}</PageTitle>
        <EmptyState
          title={t(locale, 'home.noOrg.title')}
          body={t(locale, 'home.noOrg.body')}
          action={
            <ButtonLink href={`/${locale}/orgs/new`}>{t(locale, 'action.create')}</ButtonLink>
          }
        />
      </>
    );
  const unread = await view(
    locale,
    async () =>
      (await unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 1 } } })))
        .unreadCount,
    (n) => (
      <p>
        <a href={`/${locale}/notifications`}>{t(locale, 'home.unread', { n })}</a>
      </p>
    ),
  );
  const recent = s.can('audit:read')
    ? await view(
        locale,
        async () =>
          (await unwrap(s.api.GET('/v1/audit-logs', { params: { query: { limit: 5 } } }))).items,
        (items) =>
          items.length === 0 ? (
            <EmptyState
              title={t(locale, 'state.empty.title')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <Table
              caption={t(locale, 'home.recent')}
              rows={items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'when',
                  header: t(locale, 'field.when'),
                  render: (r) => formatDateTime(r.occurredAt, locale),
                },
                {
                  key: 'action',
                  header: t(locale, 'field.action'),
                  render: (r) => <Ltr>{r.action}</Ltr>,
                },
              ]}
            />
          ),
      )
    : null;
  const services = visibleServices(s.can, (f) => flagEnabled(s.me.featureFlags, f));
  return (
    <>
      <PageTitle>{t(locale, 'home.title', { name })}</PageTitle>
      <div className="nz-grid">
        <Card aria-labelledby="org-h">
          <h2 id="org-h">{t(locale, 'field.org')}</h2>
          <p>{t(locale, 'home.org', { org: s.org.name })}</p>
          <p className="nz-muted">{t(locale, `org.type.${s.org.type}`)}</p>
        </Card>
        <Card aria-labelledby="notif-h">
          <h2 id="notif-h">{t(locale, 'nav.notifications')}</h2>
          {unread}
        </Card>
      </div>
      {services.length > 0 && (
        <section aria-labelledby="svc-h" style={{ marginBlockStart: 'var(--nuzm-space-6)' }}>
          <h2 id="svc-h" className="nz-h2">
            {t(locale, 'home.services')}
          </h2>
          <p className="nz-muted">{t(locale, 'home.services.sub')}</p>
          <ul className="nz-grid" style={{ listStyle: 'none', padding: 0 }}>
            {services.map((svc) => (
              <li key={svc.id}>
                <Card aria-labelledby={`svc-${svc.id}`}>
                  <h3 id={`svc-${svc.id}`} className="nz-h3">
                    <a href={`/${locale}${svc.href}`}>{t(locale, svc.label)}</a>
                  </h3>
                  <p className="nz-muted">{t(locale, svc.desc)}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recent && <div style={{ marginBlockStart: 'var(--nuzm-space-6)' }}>{recent}</div>}
    </>
  );
}
