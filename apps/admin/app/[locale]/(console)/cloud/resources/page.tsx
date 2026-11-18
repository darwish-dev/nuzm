import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Button, ButtonLink, Field, ForbiddenState, Input, PageTitle, Select } from '@nuzm/ui';
import { AuditedReadNotice, ResourcesTable } from '../../../../../components/CloudResources';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import {
  DRIFT_STATES,
  RESOURCE_STATES,
  isUuid,
  loose,
  pageQuery,
  type CloudResourceDto,
} from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M05-12: cross-organization resource inventory with drift and orphan filters and force reconcile. Every read is audited. */
export default async function Resources({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    orgId?: string;
    accountId?: string;
    state?: string;
    driftState?: string;
    cursor?: string;
  }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const orgId = q.orgId?.trim() ? q.orgId.trim() : undefined;
  const accountId = q.accountId?.trim() ? q.accountId.trim() : undefined;
  const state = RESOURCE_STATES.find((x) => x === q.state);
  const driftState = DRIFT_STATES.find((x) => x === q.driftState);
  const badFilter = (!!orgId && !isUuid(orgId)) || (!!accountId && !isUuid(accountId));
  const filters = { orgId, accountId, state, driftState };
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : badFilter ? (
    <p role="alert" className="nz-error-text">
      {t(locale, 'm05.adm.res.invalidFilter')}
    </p>
  ) : (
    await view(
      locale,
      () =>
        unwrap(
          loose(s.api).GET<{ items: CloudResourceDto[]; nextCursor: string | null }>(
            '/v1/admin/resources',
            { params: { query: { ...filters, limit: 25, cursor: q.cursor || undefined } } },
          ),
        ),
      (page) => (
        <>
          <ResourcesTable
            locale={locale}
            rows={page.items}
            canManage={s.can('admin:provider:manage')}
            mfaFactorId={s.me.mfaFactorId ?? null}
            caption={t(locale, 'm05.adm.res.title')}
          />
          {page.nextCursor && (
            <p>
              <ButtonLink variant="secondary" href={pageQuery(filters, page.nextCursor)}>
                {t(locale, 'action.loadMore')}
              </ButtonLink>
            </p>
          )}
        </>
      ),
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.res.title')}</PageTitle>
      <ProviderTabs locale={locale} current="resources" can={s.can} />
      <AuditedReadNotice locale={locale} />
      <form method="get" className="nz-row" aria-label={t(locale, 'm05.adm.res.title')}>
        <Field id="res-f-org" label={t(locale, 'm05.adm.res.f.org')}>
          {(x) => <Input {...x} dir="ltr" name="orgId" defaultValue={orgId ?? ''} />}
        </Field>
        <Field id="res-f-account" label={t(locale, 'm05.adm.col.account')}>
          {(x) => <Input {...x} dir="ltr" name="accountId" defaultValue={accountId ?? ''} />}
        </Field>
        <Field id="res-f-state" label={t(locale, 'm05.adm.res.col.state')}>
          {(x) => (
            <Select {...x} name="state" defaultValue={state ?? ''}>
              <option value="">{t(locale, 'm05.adm.all')}</option>
              {RESOURCE_STATES.map((v) => (
                <option key={v} value={v}>
                  {tDynamic(locale, `m05.adm.res.state.${v}`, v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="res-f-drift" label={t(locale, 'm05.adm.res.col.drift')}>
          {(x) => (
            <Select {...x} name="driftState" defaultValue={driftState ?? ''}>
              <option value="">{t(locale, 'm05.adm.all')}</option>
              {DRIFT_STATES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `m05.adm.res.drift.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
    </>
  );
}
