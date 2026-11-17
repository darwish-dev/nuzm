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
import { DunningAction } from '../../../../../components/FinancePanels';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

const STAGES = [
  'overdue',
  'reminder_1',
  'reminder_2',
  'restricted',
  'suspended',
  'terminated_pending',
] as const;
const STATES = ['open', 'closed', 'all'] as const;

/** UI-M03-20: dunning cases across organizations, with hold and resume (reason required, step-up). */
export default async function Dunning({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ stage?: string; state?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const stage = STAGES.find((x) => x === q.stage);
  const state = STATES.find((x) => x === q.state) ?? 'open';
  const canManage = s.can('admin:billing:manage');
  const mfa = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/billing/dunning', {
          params: { query: { limit: 25, stage, state, cursor: q.cursor || undefined } },
        }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'af.dn.none')} body={t(locale, 'af.dn.noneBody')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'af.dn.title')}
            rows={page.items}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'o',
                header: t(locale, 'af.dn.col.org'),
                render: (c) => <Ltr>{c.orgId.slice(0, 8)}</Ltr>,
              },
              {
                key: 'i',
                header: t(locale, 'af.dn.col.invoice'),
                render: (c) => <Ltr>{c.invoiceId.slice(0, 8)}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'af.dn.col.stage'),
                render: (c) => (
                  <Badge
                    tone={
                      c.stage === 'overdue' || c.stage.startsWith('reminder') ? 'warn' : 'danger'
                    }
                  >
                    {tDynamic(locale, `af.dn.stage.${c.stage}`, c.stage)}
                  </Badge>
                ),
              },
              {
                key: 'd',
                header: t(locale, 'af.dn.col.days'),
                render: (c) => <Ltr>{c.daysOverdue}</Ltr>,
              },
              {
                key: 'r',
                header: t(locale, 'af.dn.col.retries'),
                render: (c) => <Ltr>{c.retriesDone}</Ltr>,
              },
              {
                key: 'n',
                header: t(locale, 'af.dn.col.next'),
                render: (c) =>
                  c.closedAt || c.hold || c.nextRetryInDays === null
                    ? '—'
                    : t(locale, 'af.dn.nextIn', { days: c.nextRetryInDays }),
              },
              {
                key: 't',
                header: t(locale, 'af.dn.col.state'),
                render: (c) => (
                  <>
                    {c.closedAt ? (
                      <Badge tone="success">
                        {tDynamic(
                          locale,
                          `af.dn.closed.${c.closedReason ?? 'paid'}`,
                          c.closedReason ?? '',
                        )}
                      </Badge>
                    ) : c.hold ? (
                      <Badge tone="warn">{t(locale, 'af.dn.held')}</Badge>
                    ) : (
                      <Badge>{t(locale, 'af.dn.opened')}</Badge>
                    )}
                    {c.hold && c.holdReason && (
                      <>
                        <br />
                        <span className="nz-muted">{c.holdReason}</span>
                      </>
                    )}
                    <br />
                    <span className="nz-muted">{formatDateTime(c.openedAt, locale)}</span>
                  </>
                ),
              },
              {
                key: 'x',
                header: t(locale, 'af.dn.col.actions'),
                render: (c) =>
                  canManage && !c.closedAt ? (
                    <DunningAction locale={locale} id={c.id} hold={c.hold} mfaFactorId={mfa} />
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
                  ...(stage ? { stage } : {}),
                  state,
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
      <PageTitle>{t(locale, 'af.dn.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="dunning" can={s.can} />
      <p className="nz-muted">{t(locale, 'af.dn.policy')}</p>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.dn.title')}>
        <Field id="dn-stage" label={t(locale, 'af.dn.f.stage')}>
          {(x) => (
            <Select {...x} name="stage" defaultValue={stage ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {STAGES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.dn.stage.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="dn-state" label={t(locale, 'af.dn.f.state')}>
          {(x) => (
            <Select {...x} name="state" defaultValue={state}>
              {STATES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.dn.state.${v}`)}
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
