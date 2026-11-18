import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Card, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OrgStatusAction } from '../../../../components/AdminActions';
import { isProgramOrg } from '../../../../lib/m11';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/**
 * UI-M11-21: agencies and resellers. There is no programs-oversight list (links, grants, sub-organizations, statements across organizations: SCR-M11-05, not approved), so that part is a BLOCKED
 * state. What exists is the platform organizations list, which carries the organization `type`: it is filtered here to agencies and resellers, with the existing suspend / reinstate action
 * (an agency suspended here loses every delegated access at once, because each request is re-validated).
 */
export default async function Programs({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:org:read') && !s.can('admin:programs'))
    return (
      <>
        <PageTitle>{t(locale, 'm11.adm.prog.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () =>
      (
        await unwrap(s.api.GET('/v1/admin/organizations', { params: { query: { limit: 200 } } }))
      ).items.filter(isProgramOrg),
    (rows) =>
      rows.length === 0 ? (
        <EmptyState
          title={t(locale, 'm11.adm.prog.empty')}
          body={t(locale, 'm11.adm.prog.emptyBody')}
        />
      ) : (
        <Table
          caption={t(locale, 'm11.adm.prog.orgs')}
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'field.name'),
              render: (r) => (
                <>
                  <strong>{r.name}</strong>
                  <br />
                  <Ltr>{r.slug}</Ltr>
                </>
              ),
            },
            {
              key: 't',
              header: t(locale, 'field.type'),
              render: (r) => tDynamic(locale, `org.type.${r.type}`, r.type),
            },
            {
              key: 'm',
              header: t(locale, 'field.members'),
              render: (r) => <Ltr>{r.memberCount}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (r) => (
                <Badge tone={r.status === 'active' ? 'success' : 'danger'}>
                  {t(locale, `status.${r.status}`)}
                </Badge>
              ),
            },
            {
              key: 'c',
              header: t(locale, 'field.created'),
              render: (r) => formatDateTime(r.createdAt, locale),
            },
            {
              key: 'x',
              header: t(locale, 'field.action'),
              render: (r) =>
                s.can('admin:org:manage') ? (
                  <OrgStatusAction
                    locale={locale}
                    mfaFactorId={s.me.mfaFactorId ?? null}
                    orgId={r.id}
                    orgName={r.name}
                    status={r.status}
                    labels={{
                      suspend: t(locale, 'action.suspend'),
                      reinstate: t(locale, 'action.reinstate'),
                      confirm: t(locale, 'admin.suspend.confirm', { org: r.name }),
                      reason: t(locale, 'admin.suspend.reason'),
                      cancel: t(locale, 'action.cancel'),
                      stepUp: t(locale, 'admin.stepup'),
                      error: t(locale, 'state.error.title'),
                    }}
                  />
                ) : (
                  '—'
                ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.adm.prog.title')}</PageTitle>
      <Card aria-label={t(locale, 'm11.adm.prog.oversight')}>
        <p>
          <Badge tone="warn">BLOCKED</Badge>
        </p>
        <h2 className="nz-h2">{t(locale, 'm11.adm.prog.oversight')}</h2>
        <p>{t(locale, 'm11.adm.prog.oversightBlocked')}</p>
        <p className="nz-muted">
          {t(locale, 'm11.blocked.missing')} {t(locale, 'm11.adm.prog.oversightMissing')}
        </p>
      </Card>
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm11.adm.prog.orgs')}
      </h2>
      <p className="nz-muted">{t(locale, 'm11.adm.prog.orgsHelp')}</p>
      {body}
    </>
  );
}
