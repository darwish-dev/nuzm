import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OrgStatusAction } from '../../../../components/AdminActions';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Organizations({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale } = await params;
  const { q } = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/admin/organizations', {
          params: { query: { q: q || undefined, limit: 50 } },
        }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'admin.orgs.title')}
          rows={page.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'name',
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
              key: 'type',
              header: t(locale, 'field.type'),
              icon: 'code',
              render: (r) => tDynamic(locale, `org.type.${r.type}`, r.type),
            },
            {
              key: 'members',
              header: t(locale, 'field.members'),
              icon: 'user',
              render: (r) => <Ltr>{r.memberCount}</Ltr>,
            },
            {
              key: 'status',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (r) => (
                <Badge tone={r.status === 'active' ? 'success' : 'danger'}>
                  {t(locale, `status.${r.status}`)}
                </Badge>
              ),
            },
            {
              key: 'created',
              header: t(locale, 'field.created'),
              icon: 'calendar',
              render: (r) => formatDateTime(r.createdAt, locale),
            },
            {
              key: 'actions',
              header: t(locale, 'field.action'),
              icon: 'code',
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
      <PageTitle>{t(locale, 'admin.orgs.title')}</PageTitle>
      <form method="get" className="nz-row" role="search">
        <Field id="q" label={t(locale, 'field.search')}>
          {(a) => <Input name="q" defaultValue={q} {...a} />}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
