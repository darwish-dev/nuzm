import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { GovernanceTabs } from '../../../../../components/M12Tabs';
import { ReviewDecision } from '../../../../../components/GovernancePanels';
import { gate } from '../../../../../lib/gate';
import { readReviewItems, reviewProgress, shortId } from '../../../../../lib/ops';
import { view } from '../../../../../lib/view';

/**
 * UI-M12-11: one campaign. SCR-M12-04 (a separate item endpoint) is not approved: the members under review and their decisions come from the
 * campaign payload of the list response, and there is no GET-by-id (a campaign outside the 200 newest is reported as not found).
 */
export default async function AccessReviewDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'admin:security:manage', 'm12.ar.detail.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/access-reviews', { params: { query: { limit: 200 } } })),
    (data) => {
      const one = data.items.find((r) => r.id === id);
      if (!one)
        return (
          <EmptyState
            title={t(locale, 'm12.ar.notFound')}
            body={t(locale, 'm12.ar.notFoundBody')}
          />
        );
      const items = readReviewItems(one.items);
      const progress = reviewProgress(one);
      const isReviewer = (one.reviewers ?? []).includes(s.me.id);
      const canDecide = one.status === 'open' && isReviewer;
      return (
        <>
          <Card aria-label={t(locale, 'm12.ar.detail.title')}>
            <p>
              <Badge tone={one.status === 'closed' ? 'success' : 'warn'}>
                {tDynamic(locale, `m12.ar.status.${one.status}`, one.status)}
              </Badge>{' '}
              {t(locale, 'm12.ar.progress', { decided: progress.decided, total: progress.total })}
            </p>
            <p>
              {t(locale, 'm12.ar.col.org')}: <Ltr>{one.orgId}</Ltr>
            </p>
            <p>
              {t(locale, 'm12.ar.col.due')}: {one.dueAt ? formatDateTime(one.dueAt, locale) : '—'}
            </p>
            <p>
              {t(locale, 'm12.ar.reviewers')}:{' '}
              {(one.reviewers ?? []).length === 0 ? (
                '—'
              ) : (
                <Ltr>{(one.reviewers ?? []).map(shortId).join(', ')}</Ltr>
              )}
            </p>
          </Card>
          {one.status === 'closed' && <p className="nz-muted">{t(locale, 'm12.ar.closed')}</p>}
          {one.status === 'open' && !isReviewer && (
            <Banner tone="warn">{t(locale, 'm12.ar.notReviewer')}</Banner>
          )}
          {canDecide && <p className="nz-muted">{t(locale, 'm12.ar.revokeWarn')}</p>}
          {items.length === 0 ? (
            <EmptyState title={t(locale, 'm12.none')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'm12.ar.items')}
              rows={items}
              rowKey={(r) => r.itemId}
              columns={[
                {
                  key: 'm',
                  header: t(locale, 'm12.ar.col.member'),
                  render: (r) => <Ltr>{r.email || shortId(r.userId)}</Ltr>,
                },
                {
                  key: 'ro',
                  header: t(locale, 'field.role'),
                  render: (r) => tDynamic(locale, `role.${r.role}`, r.role),
                },
                {
                  key: 'd',
                  header: t(locale, 'm12.ar.col.decision'),
                  render: (r) =>
                    r.decision ? (
                      <Badge tone={r.decision === 'revoke' ? 'danger' : 'success'}>
                        {t(locale, `m12.ar.decision.${r.decision}`)}
                      </Badge>
                    ) : (
                      t(locale, 'm12.ar.decision.pending')
                    ),
                },
                {
                  key: 'r',
                  header: t(locale, 'm12.ar.reason'),
                  render: (r) => r.reason ?? '—',
                },
                {
                  key: 'by',
                  header: t(locale, 'm12.ar.col.decidedBy'),
                  render: (r) =>
                    r.decidedAt ? (
                      <>
                        {r.decidedBy && <Ltr>{shortId(r.decidedBy)}</Ltr>}
                        <div className="nz-muted">{formatDateTime(r.decidedAt, locale)}</div>
                      </>
                    ) : (
                      '—'
                    ),
                },
                ...(canDecide
                  ? [
                      {
                        key: 'a',
                        header: t(locale, 'm12.al.col.actions'),
                        render: (r: { itemId: string; decision: string | null }) =>
                          r.decision ? (
                            '—'
                          ) : (
                            <ReviewDecision
                              locale={locale}
                              mfaFactorId={s.me.mfaFactorId ?? null}
                              reviewId={one.id}
                              itemId={r.itemId}
                            />
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.ar.detail.title')}</PageTitle>
      <GovernanceTabs locale={locale} current="reviews" can={s.can} />
      <p>
        <a href={`/${locale}/access-reviews`}>{t(locale, 'm12.ar.back')}</a>
      </p>
      {body}
    </>
  );
}
