import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  ForbiddenState,
  Input,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { AiAdminTabs } from '../../../../../components/AiAdminTabs';
import { RUN_STATES, runFilters, runRows, runTone } from '../../../../../lib/ai';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M09-13: run oversight across organizations: METADATA only (state, kind, tokens, credits, model, region, error code). Prompts, outputs, artifacts and
 * checkpoints are never returned by the API; reading them would need break-glass with the customer's consent, which is not built. Every read is audited.
 */
export default async function AiRuns({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ orgId?: string; state?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'aia.runs.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const f = runFilters(q);
  const keep = new URLSearchParams({
    ...(f.orgId ? { orgId: f.orgId } : {}),
    ...(f.state ? { state: f.state } : {}),
  });
  const body = f.invalidOrg
    ? null
    : await view(
        locale,
        () =>
          unwrap(
            s.api.GET('/v1/admin/ai/runs', {
              params: {
                query: {
                  limit: 25,
                  ...(f.orgId ? { orgId: f.orgId } : {}),
                  ...(f.state ? { state: f.state } : {}),
                  ...(q.cursor ? { cursor: q.cursor } : {}),
                },
              },
            }),
          ),
        (page) => {
          const runs = runRows(page.items);
          return (
            <>
              {runs.length === 0 ? (
                <EmptyState
                  title={t(locale, 'aia.runs.empty')}
                  body={t(locale, 'aia.runs.emptyBody')}
                />
              ) : (
                <Table
                  caption={t(locale, 'aia.runs.title')}
                  rows={runs}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      key: 'w',
                      header: t(locale, 'field.when'),
                      render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
                    },
                    {
                      key: 'o',
                      header: t(locale, 'aia.runs.org'),
                      render: (r) => <Ltr>{r.orgId.slice(0, 8)}</Ltr>,
                    },
                    {
                      key: 'k',
                      header: t(locale, 'aia.runs.kind'),
                      render: (r) => tDynamic(locale, `aia.runs.kind.${r.kind}`, r.kind),
                    },
                    {
                      key: 's',
                      header: t(locale, 'field.status'),
                      render: (r) => (
                        <Badge tone={runTone(r.state)}>
                          {tDynamic(locale, `aia.runs.state.${r.state}`, r.state)}
                        </Badge>
                      ),
                    },
                    {
                      key: 't',
                      header: t(locale, 'aia.runs.tokens'),
                      render: (r) => <Ltr>{`${r.tokensIn} / ${r.tokensOut}`}</Ltr>,
                    },
                    {
                      key: 'c',
                      header: t(locale, 'aia.runs.credits'),
                      render: (r) => <Ltr>{r.spentCredits}</Ltr>,
                    },
                    {
                      key: 'm',
                      header: t(locale, 'aia.runs.model'),
                      render: (r) => (r.modelRef ? <Ltr>{r.modelRef}</Ltr> : '—'),
                    },
                    {
                      key: 'r',
                      header: t(locale, 'aia.col.region'),
                      render: (r) => <Ltr>{r.dataRegion}</Ltr>,
                    },
                    {
                      key: 'e',
                      header: t(locale, 'aia.runs.error'),
                      render: (r) => (r.errorCode ? <Ltr>{r.errorCode}</Ltr> : '—'),
                    },
                  ]}
                />
              )}
              {page.nextCursor && (
                <p>
                  <ButtonLink
                    variant="secondary"
                    href={`?${new URLSearchParams({ ...Object.fromEntries(keep), cursor: page.nextCursor })}`}
                  >
                    {t(locale, 'action.loadMore')}
                  </ButtonLink>
                </p>
              )}
            </>
          );
        },
      );
  return (
    <>
      <PageTitle>{t(locale, 'aia.runs.title')}</PageTitle>
      <AiAdminTabs locale={locale} current="runs" />
      <Banner tone="warn">{t(locale, 'aia.runs.noContent')}</Banner>
      <form method="get" className="nz-row" role="search" aria-label={t(locale, 'aia.runs.filter')}>
        <Field
          id="aia-f-org"
          label={t(locale, 'aia.runs.org')}
          help={t(locale, 'aia.runs.orgHelp')}
          error={f.invalidOrg ? t(locale, 'aia.ks.orgInvalid') : undefined}
        >
          {(x) => <Input name="orgId" defaultValue={q.orgId ?? ''} dir="ltr" {...x} />}
        </Field>
        <Field id="aia-f-state" label={t(locale, 'field.status')}>
          {(x) => (
            <Select name="state" defaultValue={f.state ?? ''} {...x}>
              <option value="">{t(locale, 'aia.runs.anyState')}</option>
              {RUN_STATES.map((st) => (
                <option key={st} value={st}>
                  {tDynamic(locale, `aia.runs.state.${st}`, st)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
      <p className="nz-muted">{t(locale, 'aia.runs.audited')}</p>
    </>
  );
}
