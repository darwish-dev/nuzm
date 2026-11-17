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
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../../components/BillingAdminTabs';
import { BreakActions } from '../../../../../../components/FinancePanels';
import { humanize, itemTone, runTone } from '../../../../../../lib/finance';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

const ITEM_STATUSES = ['open', 'assigned', 'resolved'] as const;

/** UI-M03-17: one run: totals, the breaks table, assign, accept as variance, resolve with an approved adjustment. */
export default async function ReconciliationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { locale, id } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const status = ITEM_STATUSES.find((x) => x === q.status);
  const canManage = s.can('admin:billing:manage');
  const mfa = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/billing/reconciliations/{id}', {
          params: { path: { id }, query: { status } },
        }),
      ),
    ({ run, items, itemsTruncated }) => (
      <>
        <h2 className="nz-h2">
          {t(locale, 'af.rc.detail.title', { type: run.type })}{' '}
          <Badge tone={runTone(run.status)}>
            {tDynamic(locale, `af.rc.status.${run.status}`, run.status)}
          </Badge>
        </h2>
        <p>
          {tDynamic(locale, `af.rc.type.${run.type}`, run.type)} ·{' '}
          <Ltr>{t(locale, 'af.rc.detail.period', { from: run.periodFrom, to: run.periodTo })}</Ltr>{' '}
          · {tDynamic(locale, `af.rc.trigger.${run.trigger}`, run.trigger)}
        </p>
        {run.error && (
          <Banner tone="danger">{t(locale, 'af.rc.detail.error', { error: run.error })}</Banner>
        )}
        <dl>
          <div>
            <dt>{t(locale, 'af.rc.col.checked')}</dt>
            <dd>
              <Ltr>{run.itemsChecked}</Ltr>
            </dd>
          </div>
          <div>
            <dt>{t(locale, 'af.rc.col.breaks')}</dt>
            <dd>
              <Ltr>{run.breaksCount}</Ltr>
            </dd>
          </div>
          <div>
            <dt>{t(locale, 'af.rc.col.open')}</dt>
            <dd>
              <Ltr>{run.openBreaks}</Ltr>
            </dd>
          </div>
          {Object.entries(run.summary)
            .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
            .map(([k, v]) => (
              <div key={k}>
                <dt>{humanize(k)}</dt>
                <dd>
                  <Ltr>{String(v)}</Ltr>
                </dd>
              </div>
            ))}
        </dl>
        <p className="nz-muted">{t(locale, 'af.rc.ledgerNote')}</p>
        <h2 className="nz-h2">{t(locale, 'af.rc.items')}</h2>
        <form method="get" className="nz-row" aria-label={t(locale, 'af.rc.items')}>
          <Field id="rc-i-status" label={t(locale, 'af.rc.f.status')}>
            {(x) => (
              <Select {...x} name="status" defaultValue={status ?? ''}>
                <option value="">{t(locale, 'af.rc.all')}</option>
                {ITEM_STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {t(locale, `af.rc.item.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" variant="secondary">
            {t(locale, 'action.search')}
          </Button>
        </form>
        {items.length === 0 ? (
          <EmptyState
            title={t(locale, 'af.rc.items.none')}
            body={t(locale, 'af.rc.items.noneBody')}
          />
        ) : (
          <Table
            caption={t(locale, 'af.rc.items')}
            rows={items}
            rowKey={(i) => i.id}
            columns={[
              {
                key: 'k',
                header: t(locale, 'af.rc.col.kind'),
                render: (i) => (
                  <>
                    <Ltr>{i.kind}</Ltr>
                    <br />
                    <span className="nz-muted">
                      <Ltr>{i.matchKey}</Ltr>
                    </span>
                  </>
                ),
              },
              {
                key: 'o',
                header: t(locale, 'af.rc.col.org'),
                render: (i) => (i.relatedOrg ? <Ltr>{i.relatedOrg.slice(0, 8)}</Ltr> : '—'),
              },
              {
                key: 's',
                header: t(locale, 'af.rc.col.status'),
                render: (i) => (
                  <span className="nz-row">
                    <Badge tone={itemTone(i.status, i.overSla)}>
                      {tDynamic(locale, `af.rc.item.${i.status}`, i.status)}
                    </Badge>
                    {i.overSla && i.status !== 'resolved' && (
                      <Badge tone="danger">{t(locale, 'af.rc.overSla')}</Badge>
                    )}
                  </span>
                ),
              },
              {
                key: 'a',
                header: t(locale, 'af.rc.col.assigned'),
                render: (i) => (i.assignedTo ? <Ltr>{i.assignedTo.slice(0, 8)}</Ltr> : '—'),
              },
              {
                key: 'd',
                header: t(locale, 'af.rc.col.details'),
                render: (i) => (
                  <details>
                    <summary>{t(locale, 'af.rc.col.details')}</summary>
                    <pre dir="ltr" className="nz-ltr" style={{ whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(i.details, null, 2)}
                    </pre>
                    {i.resolutions.length > 0 && (
                      <>
                        <strong>{t(locale, 'af.rc.history')}</strong>
                        <ul>
                          {i.resolutions.map((r) => (
                            <li key={r.id}>
                              {tDynamic(locale, `af.rc.res.${r.action}`, r.action)}
                              {r.note ? `: ${r.note}` : ''} · {formatDateTime(r.createdAt, locale)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </details>
                ),
              },
              {
                key: 'x',
                header: t(locale, 'af.rc.col.actions'),
                render: (i) => (
                  <BreakActions
                    locale={locale}
                    runId={run.id}
                    itemId={i.id}
                    status={i.status}
                    canManage={canManage}
                    mfaFactorId={mfa}
                  />
                ),
              },
            ]}
          />
        )}
        {itemsTruncated && <p className="nz-muted">{t(locale, 'af.rc.truncated')}</p>}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.rc.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="reconciliations" can={s.can} />
      <p>
        <ButtonLink variant="secondary" href={`/${locale}/billing/reconciliations`}>
          {t(locale, 'af.rc.back')}
        </ButtonLink>
      </p>
      {body}
    </>
  );
}
