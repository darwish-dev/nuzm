import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Banner, Button, Field, ForbiddenState, PageTitle, Select } from '@nuzm/ui';
import { AdminRunsTable } from '../../../../../components/BuilderAdminPanels';
import {
  RUN_STATES,
  adminRunOf,
  runStateOf,
  type AdminRunRow,
} from '../../../../../lib/builder-admin';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M10-18: AI run oversight, read only (`GET /v1/admin/ai/runs`): metadata and the budget-breach, denied-approval and escalation flags. No content. */
export default async function AdminAiRuns({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const state = runStateOf(q.state);
  const body = !s.can('admin:ai:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      async () =>
        (
          await unwrap(
            s.api.GET('/v1/admin/ai/runs', {
              params: { query: { ...(state ? { state } : {}), limit: 100 } },
            }),
          )
        ).items
          .map(adminRunOf)
          .filter((r): r is AdminRunRow => r !== null),
      (rows) => <AdminRunsTable locale={locale} rows={rows} />,
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm10.adm.runs.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm10.adm.runs.help')}</p>
      <Banner tone="warn">{t(locale, 'm10.adm.runs.metadataOnly')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'm10.adm.runs.title')}>
        <Field id="air-state" label={t(locale, 'm10.adm.col.state')}>
          {(x) => (
            <Select {...x} name="state" defaultValue={state ?? ''}>
              <option value="">{t(locale, 'm10.adm.all')}</option>
              {RUN_STATES.map((v) => (
                <option key={v} value={v}>
                  {tDynamic(locale, `m10.run.state.${v}`, v)}
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
