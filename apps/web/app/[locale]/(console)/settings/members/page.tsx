import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { Ltr, Table } from '@nuzm/ui';
import { tDynamic } from '@nuzm/i18n';
import { MemberActions } from '../../../../../components/TeamPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Members({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const orgId = s.org?.orgId;
  const body = !orgId
    ? null
    : await view(
        locale,
        async () =>
          await unwrap(
            s.api.GET('/v1/organizations/{orgId}/members', {
              params: { path: { orgId }, query: { limit: 100 } },
            }),
          ),
        (page) =>
          page.items.length === 0 ? (
            <EmptyState
              title={t(locale, 'state.empty.title')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <Table
              caption={t(locale, 'members.title')}
              rows={page.items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'name',
                  header: t(locale, 'field.name'),
                  render: (r) => r.displayName ?? '—',
                },
                {
                  key: 'email',
                  header: t(locale, 'field.email'),
                  render: (r) => <Ltr>{r.email}</Ltr>,
                },
                {
                  key: 'role',
                  header: t(locale, 'field.role'),
                  render: (r) =>
                    s.can('member:manage') ? (
                      <MemberActions
                        locale={locale}
                        orgId={orgId}
                        member={r}
                        isSelf={r.userId === s.me.id}
                        mfaFactorId={s.me.mfaFactorId ?? null}
                      />
                    ) : (
                      tDynamic(locale, `role.${r.role}`, r.role)
                    ),
                },
                {
                  key: 'joined',
                  header: t(locale, 'field.joined'),
                  render: (r) => formatDateTime(r.joinedAt, locale),
                },
              ]}
            />
          ),
      );
  return (
    <>
      <PageTitle>{t(locale, 'members.title')}</PageTitle>
      {body}
    </>
  );
}
