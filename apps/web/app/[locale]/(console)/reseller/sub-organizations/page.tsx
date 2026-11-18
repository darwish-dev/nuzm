import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { LinkSubOrgForm } from '../../../../../components/ProgramsPanels';
import { ResellerTabs } from '../../../../../components/ProgramTabs';
import { Status } from '../../../../../components/M11Parts';
import { FLAGS, itemsOf, linkTone, type SubOrgDto } from '../../../../../lib/m11';
import { gateM11, m11View, resellerOf } from '../../../../../lib/m11-server';

/** UI-M11-16: sub-organizations: LINK an existing organization (it accepts). Creating a brand-new sub-organization is NOT available (who owns it is an open product/legal decision): said on the screen. */
export default async function SubOrganizations({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'reseller:manage',
    title: 'm11.rs.subs.title',
    flag: FLAGS.reseller,
    orgType: 'reseller',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await m11View(
    locale,
    async () => {
      const reseller = await resellerOf(s);
      const subs = reseller
        ? itemsOf<SubOrgDto>(
            await unwrap(
              s.api.GET('/v1/resellers/{id}/sub-organizations', {
                params: { path: { id: reseller.id } },
              }),
            ),
          )
        : [];
      return { reseller, subs };
    },
    ({ reseller, subs }) =>
      !reseller ? (
        <EmptyState
          title={t(locale, 'm11.rs.noProfile')}
          body={t(locale, 'm11.rs.noProfileBody')}
        />
      ) : (
        <>
          <LinkSubOrgForm
            locale={locale}
            resellerId={reseller.id}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm11.rs.subs.title')}
          </h2>
          {subs.length === 0 ? (
            <EmptyState
              title={t(locale, 'm11.rs.subs.empty')}
              body={t(locale, 'm11.rs.subs.emptyBody')}
            />
          ) : (
            <Table
              caption={t(locale, 'm11.rs.subs.title')}
              rows={subs}
              rowKey={(x) => x.id}
              columns={[
                {
                  key: 'n',
                  header: t(locale, 'field.name'),
                  render: (x) => (x.subOrgName ? <bdi dir="auto">{x.subOrgName}</bdi> : '—'),
                },
                {
                  key: 'i',
                  header: t(locale, 'm11.rs.subOrgId'),
                  render: (x) => <Ltr>{x.subOrgId}</Ltr>,
                },
                {
                  key: 'p',
                  header: t(locale, 'm11.rs.priceBookRef'),
                  render: (x) => (x.priceBookRef ? <Ltr>{x.priceBookRef}</Ltr> : '—'),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (x) => (
                    <Status
                      locale={locale}
                      prefix="m11.sub.status"
                      value={x.status}
                      tone={linkTone(x.status)}
                    />
                  ),
                },
                {
                  key: 'a',
                  header: t(locale, 'm11.ag.accepted'),
                  render: (x) => (x.acceptedAt ? formatDateTime(x.acceptedAt, locale) : '—'),
                },
              ]}
            />
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.rs.subs.title')}</PageTitle>
      <ResellerTabs locale={locale} current="subs" />
      {body}
    </>
  );
}
