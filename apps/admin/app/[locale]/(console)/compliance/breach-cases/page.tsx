import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ComplianceTabs } from '../../../../../components/ComplianceTabs';
import {
  BreachMovePanel,
  BreachOpenForm,
  BreachPack,
} from '../../../../../components/CompliancePanels';
import { severityTone } from '../../../../../lib/compliance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M04-14: breach cases: the list, the detail with its timeline, the next step, and the evidence pack. The platform notifies nobody. */
export default async function BreachCases({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const { id } = await searchParams;
  const s = await requireStaff(locale);
  if (!s.can('admin:compliance:read'))
    return (
      <>
        <PageTitle>{t(locale, 'cmp.br.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const canManage = s.can('admin:breach:manage');
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/compliance/breach-cases', {
          params: { query: id && /^[0-9a-f-]{36}$/i.test(id) ? { id } : { limit: 100 } },
        }),
      ),
    (data) => {
      const one = id ? data.items[0] : undefined;
      if (id && !one)
        return <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />;
      if (one) {
        return (
          <>
            <p>
              <a href={`/${locale}/compliance/breach-cases`}>{t(locale, 'cmp.br.back')}</a>
            </p>
            <section className="nz-card" aria-label={t(locale, 'cmp.br.title')}>
              <p>{one.summary}</p>
              <p>
                <Badge tone={severityTone(one.severity)}>
                  {tDynamic(locale, `cmp.br.severity.${one.severity}`, one.severity)}
                </Badge>{' '}
                <Badge>{tDynamic(locale, `cmp.br.state.${one.state}`, one.state)}</Badge>{' '}
                {one.timers.current && (
                  <span className={one.timers.current.overdue ? 'nz-error-text' : 'nz-muted'}>
                    {tDynamic(
                      locale,
                      `cmp.br.step.${one.timers.current.step}`,
                      one.timers.current.step,
                    )}
                    : {formatDateTime(one.timers.current.dueAt, locale)}
                    {one.timers.current.overdue ? ` · ${t(locale, 'cmp.br.overdue')}` : ''}
                  </span>
                )}
              </p>
            </section>
            <h2 className="nz-h2">{t(locale, 'cmp.br.timeline')}</h2>
            <Table
              caption={t(locale, 'cmp.br.timeline')}
              rows={one.timeline as { at: string; to: string; note: string | null; by: string }[]}
              rowKey={(r) => `${r.at}-${r.to}`}
              columns={[
                {
                  key: 'at',
                  header: t(locale, 'cmp.col.date'),
                  render: (r) => formatDateTime(r.at, locale),
                },
                {
                  key: 'to',
                  header: t(locale, 'cmp.br.col.state'),
                  render: (r) => tDynamic(locale, `cmp.br.state.${r.to}`, r.to),
                },
                {
                  key: 'by',
                  header: t(locale, 'cmp.ev.col.by'),
                  render: (r) => <Ltr>{String(r.by).slice(0, 8)}</Ltr>,
                },
                { key: 'no', header: t(locale, 'cmp.br.note'), render: (r) => r.note ?? '—' },
              ]}
            />
            <BreachMovePanel
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              caseId={one.id}
              version={one.version}
              state={one.state}
              decision={one.decision as { notify?: boolean } | null}
              canManage={canManage}
            />
            <BreachPack locale={locale} caseId={one.id} />
          </>
        );
      }
      return (
        <>
          {data.items.length === 0 ? (
            <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'cmp.br.title')}
              rows={data.items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'su',
                  header: t(locale, 'cmp.br.col.summary'),
                  render: (r) => (
                    <a href={`/${locale}/compliance/breach-cases?id=${r.id}`}>
                      {r.summary.slice(0, 80)}
                    </a>
                  ),
                },
                {
                  key: 'sv',
                  header: t(locale, 'cmp.br.col.severity'),
                  render: (r) => (
                    <Badge tone={severityTone(r.severity)}>
                      {tDynamic(locale, `cmp.br.severity.${r.severity}`, r.severity)}
                    </Badge>
                  ),
                },
                {
                  key: 'st',
                  header: t(locale, 'cmp.br.col.state'),
                  render: (r) => tDynamic(locale, `cmp.br.state.${r.state}`, r.state),
                },
                {
                  key: 'du',
                  header: t(locale, 'cmp.br.col.due'),
                  render: (r) =>
                    r.timers.current ? (
                      <span className={r.timers.current.overdue ? 'nz-error-text' : undefined}>
                        {formatDateTime(r.timers.current.dueAt, locale)}
                        {r.timers.current.overdue ? ` · ${t(locale, 'cmp.br.overdue')}` : ''}
                      </span>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'de',
                  header: t(locale, 'cmp.br.col.detected'),
                  render: (r) => formatDateTime(r.detectedAt, locale),
                },
              ]}
            />
          )}
          {canManage && <BreachOpenForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.br.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="breach-cases" />
      <Banner tone="warn">{t(locale, 'cmp.br.help')}</Banner>
      {body}
    </>
  );
}
