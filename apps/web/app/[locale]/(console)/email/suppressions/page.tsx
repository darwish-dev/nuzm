import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { AddSuppressionForm, RemoveSuppression } from '../../../../../components/EmailPanels';
import { EmailTabs } from '../../../../../components/DataParts';
import { isProtectiveReason } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-14: the suppression list. Removing a hard bounce or a complaint needs an explicit override confirmation. */
export default async function Suppressions({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ active?: string }>;
}) {
  const g = await gate(params, 'email:read', 'm8.em.tab.suppressions');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { active } = await searchParams;
  const filter = active === 'false' ? 'false' : active === 'all' ? '' : 'true';
  const manage = s.can('email:domain:manage');
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/email/suppressions', {
          params: { query: { limit: 200, ...(filter ? { active: filter } : {}) } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm8.su.empty')} body={t(locale, 'm8.su.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm8.em.tab.suppressions')}
            rows={data.items}
            rowKey={(x) => x.id}
            columns={[
              {
                key: 'a',
                header: t(locale, 'm8.su.address'),
                icon: 'globe',
                render: (x) => <Ltr>{x.address}</Ltr>,
              },
              {
                key: 'r',
                header: t(locale, 'field.reason'),
                render: (x) => (
                  <Badge tone={isProtectiveReason(x.reason) ? 'danger' : undefined}>
                    {tDynamic(locale, `m8.su.reason.${x.reason}`, x.reason)}
                  </Badge>
                ),
              },
              {
                key: 's',
                header: t(locale, 'm8.su.source'),
                render: (x) => tDynamic(locale, `m8.su.src.${x.source}`, x.source),
              },
              {
                key: 'c',
                header: t(locale, 'field.created'),
                icon: 'calendar',
                render: (x) => formatDateTime(x.createdAt, locale),
              },
              {
                key: 'st',
                header: t(locale, 'field.status'),
                icon: 'pulse',
                render: (x) => (x.active ? t(locale, 'm8.su.active') : t(locale, 'm8.su.removed')),
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                icon: 'code',
                render: (x) =>
                  manage && x.active ? (
                    <RemoveSuppression
                      locale={locale}
                      suppression={x}
                      mfaFactorId={s.me.mfaFactorId ?? null}
                    />
                  ) : (
                    '—'
                  ),
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
      <EmailTabs locale={locale} current="suppressions" />
      <p className="nz-muted">{t(locale, 'm8.su.help')}</p>
      {manage && <AddSuppressionForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />}
      <form
        method="get"
        className="nz-row"
        aria-label={t(locale, 'm8.ms.filter')}
        style={{ marginBlockStart: 16 }}
      >
        <label htmlFor="su-active">{t(locale, 'field.status')}</label>
        <select
          id="su-active"
          name="active"
          className="nz-input"
          defaultValue={active === 'all' ? 'all' : filter}
        >
          <option value="true">{t(locale, 'm8.su.active')}</option>
          <option value="false">{t(locale, 'm8.su.removed')}</option>
          <option value="all">{t(locale, 'm8.ms.allStatuses')}</option>
        </select>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
    </>
  );
}
