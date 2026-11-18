import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { GovernanceTabs } from '../../../../components/M12Tabs';
import { AccessReviewCreateForm } from '../../../../components/GovernancePanels';
import { gate } from '../../../../lib/gate';
import { reviewProgress, shortId } from '../../../../lib/ops';
import { isUuid } from '../../../../lib/finance';
import { view } from '../../../../lib/view';

/** UI-M12-10: access review campaigns (scope today: the members of one organization). */
export default async function AccessReviews({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ orgId?: string; status?: string; cursor?: string }>;
}) {
  const g = await gate(params, 'admin:security:manage', 'm12.ar.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const orgId = q.orgId && isUuid(q.orgId.trim()) ? q.orgId.trim() : undefined;
  const status = q.status === 'open' || q.status === 'closed' ? q.status : undefined;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/access-reviews', {
          params: { query: { limit: 50, orgId, status, cursor: q.cursor || undefined } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm12.ar.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'm12.ar.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'id',
                header: t(locale, 'm12.ar.col.campaign'),
                render: (r) => (
                  <a href={`/${locale}/access-reviews/${r.id}`}>
                    <Ltr>{shortId(r.id)}</Ltr>
                  </a>
                ),
              },
              {
                key: 'org',
                header: t(locale, 'm12.ar.col.org'),
                render: (r) => <Ltr>{r.orgId}</Ltr>,
              },
              {
                key: 'st',
                header: t(locale, 'm12.ar.col.status'),
                render: (r) => (
                  <Badge tone={r.status === 'closed' ? 'success' : 'warn'}>
                    {tDynamic(locale, `m12.ar.status.${r.status}`, r.status)}
                  </Badge>
                ),
              },
              {
                key: 'pr',
                header: t(locale, 'm12.ar.col.progress'),
                render: (r) => {
                  const p = reviewProgress(r);
                  return t(locale, 'm12.ar.progress', { decided: p.decided, total: p.total });
                },
              },
              {
                key: 'du',
                header: t(locale, 'm12.ar.col.due'),
                render: (r) => (r.dueAt ? formatDateTime(r.dueAt, locale) : '—'),
              },
              {
                key: 'cr',
                header: t(locale, 'field.created'),
                render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
              },
            ]}
          />
        )}
        {data.nextCursor && (
          <p>
            <a
              href={`/${locale}/access-reviews?${new URLSearchParams({
                ...(orgId ? { orgId } : {}),
                ...(status ? { status } : {}),
                cursor: data.nextCursor,
              }).toString()}`}
            >
              {t(locale, 'action.loadMore')}
            </a>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.ar.title')}</PageTitle>
      <GovernanceTabs locale={locale} current="reviews" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.ar.help')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'm12.ar.filter')}>
        <Field id="rf-org" label={t(locale, 'm12.ar.col.org')}>
          {(x) => <Input {...x} name="orgId" dir="ltr" defaultValue={orgId ?? ''} />}
        </Field>
        <Field id="rf-status" label={t(locale, 'm12.ar.col.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'm12.any')}</option>
              <option value="open">{t(locale, 'm12.ar.status.open')}</option>
              <option value="closed">{t(locale, 'm12.ar.status.closed')}</option>
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
      <AccessReviewCreateForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
    </>
  );
}
