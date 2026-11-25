import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Icon, Ltr, PageTitle } from '@nuzm/ui';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

const TZ = 'Asia/Riyadh'; // the same zone formatDateTime uses
const dayKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(new Date(iso));
const formatDay = (day: string, locale: 'ar' | 'en') =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`));
const formatTime = (iso: string, locale: 'ar' | 'en') =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeStyle: 'short',
    timeZone: TZ,
  }).format(new Date(iso));
/** The events grouped by their day (newest first, in the order the API returned them). */
function days<T extends { occurredAt: string }>(items: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const r of items) {
    const k = dayKey(r.occurredAt);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out];
}

export default async function AuditLogs({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ action?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/audit-logs', {
          params: {
            query: { limit: 25, action: q.action || undefined, cursor: q.cursor || undefined },
          },
        }),
      ),
    (page) => (
      <>
        {!s.can('audit:read_all') && <p className="nz-muted">{t(locale, 'audit.billingOnly')}</p>}
        {page.items.length === 0 ? (
          <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
        ) : (
          <div className="nzc-audit" aria-label={t(locale, 'audit.title')}>
            {days(page.items).map(([day, items]) => (
              <section key={day} className="nzc-audit-day" aria-label={formatDay(day, locale)}>
                <h3>
                  {formatDay(day, locale)}
                  <span>{t(locale, 'audit.count', { n: items.length })}</span>
                </h3>
                <ol>
                  {items.map((r) => {
                    const [area, ...rest] = r.action.split('.');
                    return (
                      <li key={r.id} data-outcome={r.outcome}>
                        <span className="nzc-audit-dot" aria-hidden="true" />
                        <div className="nzc-audit-main">
                          <p>
                            <span className="nzc-audit-area">
                              <Ltr>{area}</Ltr>
                            </span>{' '}
                            {/* a real space: the flex gap only separates them visually, and without it the line reads, copies and searches as one word */}
                            <Ltr>{rest.join(' ').replaceAll('_', ' ') || r.action}</Ltr>
                          </p>
                          <small>
                            <Icon name="user" size={13} />
                            {tDynamic(locale, `actor.${r.actor.type ?? ''}`, r.actor.type ?? '')}
                            {r.resource.type && (
                              <code>
                                <Ltr>{`${r.resource.type}${r.resource.id ? `:${r.resource.id.slice(0, 8)}` : ''}`}</Ltr>
                              </code>
                            )}
                          </small>
                        </div>
                        <div className="nzc-audit-side">
                          <Badge tone={r.outcome === 'success' ? 'success' : 'danger'}>
                            {t(locale, `outcome.${r.outcome}`)}
                          </Badge>
                          <time
                            dateTime={r.occurredAt}
                            title={formatDateTime(r.occurredAt, locale)}
                          >
                            {formatTime(r.occurredAt, locale)}
                          </time>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
        {page.nextCursor && (
          <p>
            <ButtonLink
              variant="secondary"
              href={`?${new URLSearchParams({ ...(q.action ? { action: q.action } : {}), cursor: page.nextCursor })}#audit`}
            >
              {t(locale, 'action.loadMore')}
            </ButtonLink>
          </p>
        )}
        <p className="nz-muted">{t(locale, 'audit.integrity')}</p>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'audit.title')}</PageTitle>
      <form method="get" action="#audit" className="nzc-audit-search" role="search">
        <Icon name="search" size={16} />
        <label className="nz-sr" htmlFor="action">
          {t(locale, 'audit.filter.action')}
        </label>
        <input
          id="action"
          name="action"
          defaultValue={q.action}
          dir="ltr"
          placeholder={t(locale, 'audit.search.placeholder')}
        />
        <button type="submit">{t(locale, 'action.search')}</button>
      </form>
      {body}
    </>
  );
}
