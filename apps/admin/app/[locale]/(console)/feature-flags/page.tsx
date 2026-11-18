import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, Ltr, PageTitle, EmptyState, Table } from '@nuzm/ui';
import { FlagForm } from '../../../../components/AdminActions';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Flags({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:flags:manage'))
    return (
      <ForbiddenState
        title={t(locale, 'state.forbidden.title')}
        body={t(locale, 'state.forbidden.body')}
      />
    );
  const body = await view(
    locale,
    async () =>
      (await unwrap(s.api.GET('/v1/admin/feature-flags', {}))) as unknown as {
        items: {
          key: string;
          scope: string;
          orgId: string | null;
          value: unknown;
          updatedAt: string;
        }[];
      },
    (r) =>
      r.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'admin.flags.title')}
          rows={r.items}
          rowKey={(f) => `${f.key}:${f.orgId ?? 'global'}`}
          columns={[
            { key: 'k', header: t(locale, 'field.name'), render: (f) => <Ltr>{f.key}</Ltr> },
            {
              key: 's',
              header: t(locale, 'field.type'),
              icon: 'code',
              render: (f) => <Ltr>{f.orgId ? `org:${f.orgId.slice(0, 8)}` : 'global'}</Ltr>,
            },
            {
              key: 'v',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (f) => <Ltr>{JSON.stringify(f.value)}</Ltr>,
            },
            {
              key: 'u',
              header: t(locale, 'field.created'),
              icon: 'calendar',
              render: (f) => formatDateTime(f.updatedAt, locale),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'admin.flags.title')}</PageTitle>
      <FlagForm
        labels={{
          key: t(locale, 'field.name'),
          value: t(locale, 'field.status'),
          save: t(locale, 'action.save'),
          error: t(locale, 'state.error.title'),
        }}
      />
      {body}
    </>
  );
}
