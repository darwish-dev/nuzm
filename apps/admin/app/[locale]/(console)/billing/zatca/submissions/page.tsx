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
  Ltr,
  Meter,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../../components/BillingAdminTabs';
import { RetrySubmission } from '../../../../../../components/FinancePanels';
import { splitRemaining, submissionTone, windowSummary } from '../../../../../../lib/finance';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

const STATES = [
  'generated',
  'stamped',
  'queued',
  'submitted',
  'cleared',
  'reported',
  'rejected',
  'error',
] as const;

/** UI-M03-19: the e-invoice submission queue: state, attempts, errors, dead letters with retry, and the reporting-window gauge. */
export default async function Submissions({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string; deadLetter?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const state = STATES.find((x) => x === q.state);
  const dead = q.deadLetter === 'true';
  const canRetry = s.can('admin:zatca:manage');
  const mfa = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/billing/zatca/submissions', {
          params: {
            query: {
              limit: 25,
              state,
              deadLetter: dead ? true : undefined,
              cursor: q.cursor || undefined,
            },
          },
        }),
      ),
    (page) => {
      const gauge = windowSummary(page.items);
      return (
        <>
          <section aria-label={t(locale, 'af.zs.slo.title')}>
            <h2 className="nz-h2">{t(locale, 'af.zs.slo.title')}</h2>
            {gauge.total === 0 ? (
              <p className="nz-muted">{t(locale, 'af.zs.slo.none')}</p>
            ) : (
              <>
                <Meter label={t(locale, 'af.zs.slo.label')} percent={gauge.percentOk} />
                <p>
                  {t(locale, 'af.zs.slo.summary', {
                    ok: gauge.ok,
                    total: gauge.total,
                    alert: gauge.alert,
                    breached: gauge.breached,
                  })}
                </p>
                {gauge.breached > 0 && (
                  <Banner tone="danger">{t(locale, 'af.zs.window.breached')}</Banner>
                )}
              </>
            )}
          </section>
          {page.items.length === 0 ? (
            <EmptyState title={t(locale, 'af.zs.none')} body={t(locale, 'af.zs.noneBody')} />
          ) : (
            <>
              <Table
                caption={t(locale, 'af.zs.title')}
                rows={page.items}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: 'd',
                    header: t(locale, 'af.zs.col.doc'),
                    render: (r) => <Ltr>{r.documentId.slice(0, 8)}</Ltr>,
                  },
                  {
                    key: 'o',
                    header: t(locale, 'af.zs.col.org'),
                    render: (r) => <Ltr>{r.orgId.slice(0, 8)}</Ltr>,
                  },
                  {
                    key: 't',
                    header: t(locale, 'af.zs.col.type'),
                    render: (r) => (
                      <>
                        <Ltr>{r.documentType}</Ltr> ·{' '}
                        {tDynamic(locale, `af.zs.sub.${r.subtype}`, r.subtype)}
                      </>
                    ),
                  },
                  {
                    key: 's',
                    header: t(locale, 'af.zs.col.state'),
                    render: (r) => (
                      <span className="nz-row">
                        <Badge tone={submissionTone(r.state, r.deadLetter)}>
                          {tDynamic(locale, `af.zs.state.${r.state}`, r.state)}
                        </Badge>
                        {r.deadLetter && <Badge tone="danger">{t(locale, 'af.zs.dead')}</Badge>}
                      </span>
                    ),
                  },
                  {
                    key: 'a',
                    header: t(locale, 'af.zs.col.attempt'),
                    render: (r) => <Ltr>{r.attempt}</Ltr>,
                  },
                  {
                    key: 'n',
                    header: t(locale, 'af.zs.col.next'),
                    render: (r) =>
                      r.nextAttemptAt ? formatDateTime(r.nextAttemptAt, locale) : '—',
                  },
                  {
                    key: 'e',
                    header: t(locale, 'af.zs.col.error'),
                    render: (r) =>
                      r.lastError ? (
                        <>
                          <Ltr>{r.lastError.code}</Ltr>
                          <br />
                          <span className="nz-muted">{r.lastError.message}</span>
                        </>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    key: 'w',
                    header: t(locale, 'af.zs.col.window'),
                    render: (r) =>
                      r.windowRemainingSeconds === null ? (
                        '—'
                      ) : (
                        <span className="nz-row">
                          {t(locale, 'af.zs.window.left', splitRemaining(r.windowRemainingSeconds))}
                          {r.windowBreached ? (
                            <Badge tone="danger">{t(locale, 'af.zs.window.breached')}</Badge>
                          ) : r.windowAlert ? (
                            <Badge tone="warn">{t(locale, 'af.zs.window.alert')}</Badge>
                          ) : null}
                        </span>
                      ),
                  },
                  {
                    key: 'x',
                    header: t(locale, 'af.zs.col.actions'),
                    render: (r) =>
                      canRetry && r.deadLetter && r.state === 'error' ? (
                        <RetrySubmission locale={locale} id={r.id} mfaFactorId={mfa} />
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
              {page.nextCursor && (
                <p>
                  <ButtonLink
                    variant="secondary"
                    href={`?${new URLSearchParams({
                      ...(state ? { state } : {}),
                      ...(dead ? { deadLetter: 'true' } : {}),
                      cursor: page.nextCursor,
                    }).toString()}`}
                  >
                    {t(locale, 'action.loadMore')}
                  </ButtonLink>
                </p>
              )}
            </>
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.zs.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="submissions" can={s.can} />
      <Banner tone="warn">{t(locale, 'af.zs.simulated')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.zs.title')}>
        <Field id="zs-state" label={t(locale, 'af.zs.f.state')}>
          {(x) => (
            <Select {...x} name="state" defaultValue={state ?? ''}>
              <option value="">{t(locale, 'af.zs.all')}</option>
              {STATES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.zs.state.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="zs-dead" label={t(locale, 'af.zs.f.dead')}>
          {(x) => (
            <Select {...x} name="deadLetter" defaultValue={dead ? 'true' : ''}>
              <option value="">{t(locale, 'af.zs.all')}</option>
              <option value="true">{t(locale, 'af.zs.deadOnly')}</option>
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
