import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ImpersonateAction } from '../../../../components/AdminActions';
import { CreateUserForm } from '../../../../components/AdminTools';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Users({
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
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000';
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/admin/users', { params: { query: { q: q || undefined, limit: 50 } } }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'admin.users.title')}
          rows={page.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'email',
              icon: 'mail',
              header: t(locale, 'field.email'),
              render: (r) => <Ltr>{r.email}</Ltr>,
            },
            { key: 'name', header: t(locale, 'field.name'), render: (r) => r.displayName ?? '—' },
            {
              key: 'mfa',
              header: t(locale, 'field.mfa'),
              icon: 'shield',
              render: (r) => (
                <Badge tone={r.mfaEnrolled ? 'success' : 'warn'}>{r.mfaEnrolled ? '✓' : '—'}</Badge>
              ),
            },
            {
              key: 'sessions',
              header: t(locale, 'field.sessions'),
              render: (r) => <Ltr>{r.activeSessions}</Ltr>,
            },
            {
              key: 'last',
              header: t(locale, 'field.lastLogin'),
              icon: 'calendar',
              render: (r) => (r.lastLoginAt ? formatDateTime(r.lastLoginAt, locale) : '—'),
            },
            {
              key: 'act',
              header: t(locale, 'field.action'),
              icon: 'code',
              render: (r) =>
                s.can('admin:impersonate') && !r.isPlatformUser ? (
                  <ImpersonateAction
                    userId={r.id}
                    email={r.email}
                    requireApproval={!s.roles.includes('platform_admin')}
                    webOrigin={webOrigin}
                    locale={locale}
                    mfaFactorId={s.me.mfaFactorId ?? null}
                    labels={{
                      open: t(locale, 'action.impersonate'),
                      title: t(locale, 'admin.impersonate.title', { email: r.email }),
                      reason: t(locale, 'admin.impersonate.reason'),
                      ttl: t(locale, 'field.ttl'),
                      approvalRef: t(locale, 'field.approvalRef'),
                      notice: t(locale, 'admin.impersonate.notice'),
                      start: t(locale, 'action.impersonate'),
                      cancel: t(locale, 'action.cancel'),
                      stepUp: t(locale, 'admin.stepup'),
                      error: t(locale, 'state.error.title'),
                      started: t(locale, 'admin.impersonate.started', { time: '{time}' }),
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
      <PageTitle>{t(locale, 'admin.users.title')}</PageTitle>
      {s.can('admin:user:manage') && (
        <CreateUserForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      )}
      <form method="get" className="nz-row nz-admin-search" role="search">
        <Field id="q" label={t(locale, 'field.search')}>
          {(a) => <Input name="q" defaultValue={q} {...a} />}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
