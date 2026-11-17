import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ComplianceTabs } from '../../../../../components/ComplianceTabs';
import { ValidationForm } from '../../../../../components/CompliancePanels';
import { validationTone } from '../../../../../lib/compliance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M04-13: the regulatory validation register. "Validated" needs a document and a named person; the form cannot send it without them. */
export default async function Validations({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:compliance:read'))
    return (
      <>
        <PageTitle>{t(locale, 'cmp.val.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/compliance/regulatory-validations', {
          params: { query: { limit: 100 } },
        }),
      ),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'cmp.val.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              { key: 'r', header: t(locale, 'cmp.val.col.regime'), render: (r) => r.regime },
              { key: 'q', header: t(locale, 'cmp.val.col.question'), render: (r) => r.question },
              {
                key: 'a',
                header: t(locale, 'cmp.val.col.applic'),
                render: (r) =>
                  tDynamic(locale, `cmp.val.applic.${r.applicability}`, r.applicability),
              },
              {
                key: 's',
                header: t(locale, 'cmp.val.col.status'),
                render: (r) => (
                  <Badge tone={validationTone(r.status)}>
                    {tDynamic(locale, `cmp.val.status.${r.status}`, r.status)}
                  </Badge>
                ),
              },
              {
                key: 'v',
                header: t(locale, 'cmp.val.col.version'),
                render: (r) => <Ltr>{String(r.version)}</Ltr>,
              },
              {
                key: 'b',
                header: t(locale, 'cmp.val.col.by'),
                render: (r) => (r.validatedBy ? <Ltr>{r.validatedBy.slice(0, 8)}</Ltr> : '—'),
              },
            ]}
          />
          {s.can('admin:compliance:manage') && (
            <ValidationForm
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              items={data.items.map((i) => ({
                validationKey: i.validationKey,
                regime: i.regime,
                version: i.version,
                applicability: i.applicability,
              }))}
            />
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.val.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="validations" />
      <Banner tone="warn">{t(locale, 'cmp.val.help')}</Banner>
      {body}
    </>
  );
}
