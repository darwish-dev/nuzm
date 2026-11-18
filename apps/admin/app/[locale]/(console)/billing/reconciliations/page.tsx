import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { RunReconciliationsForm } from '../../../../../components/FinancePanels';
import { RC_TYPES, runTone } from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

const STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** UI-M03-16: reconciliation runs (filter by type and status), run now, the schedule. */
export default async function Reconciliations({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ type?: string; status?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const type = RC_TYPES.find((x) => x === q.type);
  const status = STATUSES.find((x) => x === q.status);
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/billing/reconciliations', {
          params: { query: { limit: 25, type, status, cursor: q.cursor || undefined } },
        }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'af.rc.none')} body={t(locale, 'af.rc.noneBody')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'af.rc.title')}
            rows={page.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 't',
                header: t(locale, 'af.rc.col.type'),
                icon: 'code',
                render: (r) => (
                  <a href={`/${locale}/billing/reconciliations/${r.id}`}>
                    <Ltr>{r.type}</Ltr> {tDynamic(locale, `af.rc.type.${r.type}`, r.type)}
                  </a>
                ),
              },
              {
                key: 'p',
                header: t(locale, 'af.rc.col.period'),
                icon: 'calendar',
                render: (r) => (
                  <Ltr>
                    {r.periodFrom} → {r.periodTo}
                  </Ltr>
                ),
              },
              {
                key: 's',
                header: t(locale, 'af.rc.col.status'),
                icon: 'pulse',
                render: (r) => (
                  <Badge tone={runTone(r.status)}>
                    {tDynamic(locale, `af.rc.status.${r.status}`, r.status)}
                  </Badge>
                ),
              },
              {
                key: 'g',
                header: t(locale, 'af.rc.col.trigger'),
                render: (r) => tDynamic(locale, `af.rc.trigger.${r.trigger}`, r.trigger),
              },
              {
                key: 'c',
                header: t(locale, 'af.rc.col.checked'),
                render: (r) => <Ltr>{r.itemsChecked}</Ltr>,
              },
              {
                key: 'b',
                header: t(locale, 'af.rc.col.breaks'),
                render: (r) => <Ltr>{r.breaksCount}</Ltr>,
              },
              {
                key: 'o',
                header: t(locale, 'af.rc.col.open'),
                render: (r) =>
                  r.openBreaks > 0 ? (
                    <Badge tone="danger">
                      <Ltr>{r.openBreaks}</Ltr>
                    </Badge>
                  ) : (
                    <Ltr>0</Ltr>
                  ),
              },
              {
                key: 'w',
                header: t(locale, 'field.when'),
                icon: 'calendar',
                render: (r) => formatDateTime(r.createdAt, locale),
              },
            ]}
          />
          {page.nextCursor && (
            <p>
              <ButtonLink
                variant="secondary"
                href={`?${new URLSearchParams({
                  ...(type ? { type } : {}),
                  ...(status ? { status } : {}),
                  cursor: page.nextCursor,
                }).toString()}`}
              >
                {t(locale, 'action.loadMore')}
              </ButtonLink>
            </p>
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.rc.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="reconciliations" can={s.can} />
      <p className="nz-muted">{t(locale, 'af.rc.schedule')}</p>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.rc.title')}>
        <Field id="rc-f-type" label={t(locale, 'af.rc.f.type')}>
          {(x) => (
            <Select {...x} name="type" defaultValue={type ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {RC_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v} — {tDynamic(locale, `af.rc.type.${v}`, v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="rc-f-status" label={t(locale, 'af.rc.f.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.rc.status.${v}`)}
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
      {s.can('admin:billing:manage') && (
        <RunReconciliationsForm
          locale={locale}
          mfaFactorId={s.me.mfaFactorId ?? null}
          defaultFrom={day(first)}
          defaultTo={day(now)}
        />
      )}
    </>
  );
}
