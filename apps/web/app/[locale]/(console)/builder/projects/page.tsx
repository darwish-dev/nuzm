import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { bgate, bview } from '../../../../../lib/builder-gate';

/** The web-app projects of the organization (entry of the sidebar item; the project overview is UI-M10-02). */
export default async function BuilderProjects({ params }: { params: Promise<{ locale: string }> }) {
  const g = await bgate(params, 'builder:read', 'm10.proj.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await bview(
    locale,
    () => unwrap(s.api.GET('/v1/builder/projects', { params: { query: { type: 'webapp' } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'm10.proj.empty')} body={t(locale, 'm10.proj.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm10.proj.title')}
          rows={data.items}
          rowKey={(p) => p.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'field.name'),
              render: (p) => <a href={`/${locale}/builder/projects/${p.id}`}>{p.name}</a>,
            },
            {
              key: 't',
              header: t(locale, 'field.type'),
              render: (p) => tDynamic(locale, `m10.proj.type.${p.type}`, p.type),
            },
            {
              key: 'r',
              header: t(locale, 'field.region'),
              render: (p) => <Ltr>{p.dataRegion ?? '—'}</Ltr>,
            },
            {
              key: 'c',
              header: t(locale, 'field.created'),
              render: (p) => (p.createdAt ? formatDateTime(p.createdAt, locale) : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm10.proj.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm10.proj.help')}</p>
      {s.can('builder:write') && (
        <p>
          <ButtonLink href={`/${locale}/builder/projects/new/app`}>
            {t(locale, 'm10.proj.new')}
          </ButtonLink>
        </p>
      )}
      {body}
    </>
  );
}
