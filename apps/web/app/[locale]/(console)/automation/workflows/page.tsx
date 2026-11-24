import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
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
import { Status } from '../../../../../components/M11Parts';
import {
  FLAGS,
  executionTone,
  itemsOf,
  workflowTone,
  type ExecutionDto,
  type WorkflowDto,
} from '../../../../../lib/m11';
import { actingHeader, actingOrgOf, gateM11, m11View } from '../../../../../lib/m11-server';

/** UI-M11-01: workflows with status and last run. An agency acting for a client (`nuzm_acting_org`) sees the CLIENT's workflows (delegable route). */
export default async function Workflows({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'automation:read',
    title: 'm11.wf.title',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { status, cursor } = await searchParams;
  const acting = await actingOrgOf(s);
  const header = actingHeader(acting);
  const body = await m11View(
    locale,
    async () => {
      const page = await unwrap(
        s.api.GET('/v1/workflows', {
          params: {
            query: { limit: 50, status: status || undefined, cursor: cursor || undefined },
            header,
          },
        }),
      );
      const items = itemsOf<WorkflowDto>(page);
      // last run: the newest execution of each workflow shown (first 25; a failed lookup only leaves the cell empty)
      const last = new Map<string, ExecutionDto | null>();
      await Promise.all(
        items.slice(0, 25).map(async (w) => {
          try {
            const e = await unwrap(
              s.api.GET('/v1/workflows/{id}/executions', {
                params: { path: { id: w.id }, query: { limit: 1 }, header },
              }),
            );
            last.set(w.id, itemsOf<ExecutionDto>(e)[0] ?? null);
          } catch {
            last.set(w.id, null);
          }
        }),
      );
      return { items, next: page.nextCursor ?? null, last };
    },
    ({ items, next, last }) =>
      items.length === 0 ? (
        <EmptyState
          title={t(locale, 'm11.wf.empty')}
          body={t(locale, 'm11.wf.emptyBody')}
          action={
            s.can('automation:write') ? (
              <ButtonLink href={`/automation/workflows/new`}>{t(locale, 'm11.wf.new')}</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table
            caption={t(locale, 'm11.wf.title')}
            rows={items}
            rowKey={(w) => w.id}
            columns={[
              {
                key: 'n',
                header: t(locale, 'field.name'),
                render: (w) => (
                  <a href={`/automation/workflows/${w.id}/edit`}>
                    <bdi dir="auto">{w.name}</bdi>
                  </a>
                ),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (w) => (
                  <Status
                    locale={locale}
                    prefix="m11.wf.status"
                    value={w.status}
                    tone={workflowTone(w.status)}
                  />
                ),
              },
              {
                key: 'v',
                header: t(locale, 'm11.wf.col.version'),
                render: (w) => (w.activeVersion ? <Ltr>{`v${w.activeVersion}`}</Ltr> : '—'),
              },
              {
                key: 't',
                header: t(locale, 'm11.wf.col.triggers'),
                render: (w) =>
                  w.triggers
                    .map((x) =>
                      tDynamic(
                        locale,
                        `m11.wf.trigger.${x.type === 'platform_event' ? 'event' : x.type}`,
                        x.type,
                      ),
                    )
                    .join(', '),
              },
              {
                key: 'l',
                header: t(locale, 'm11.wf.col.lastRun'),
                render: (w) => {
                  const e = last.get(w.id);
                  return w.lastRunAt || e ? (
                    <>
                      {w.lastRunAt
                        ? formatDateTime(w.lastRunAt, locale)
                        : e
                          ? formatDateTime(e.createdAt, locale)
                          : '—'}
                      {e && (
                        <>
                          {' '}
                          <a href={`/automation/executions/${e.id}`}>
                            <Badge tone={executionTone(e.status)}>
                              {tDynamic(locale, `m11.exec.status.${e.status}`, e.status)}
                            </Badge>
                          </a>
                        </>
                      )}
                    </>
                  ) : (
                    t(locale, 'm11.wf.neverRun')
                  );
                },
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                render: (w) => (
                  <a href={`/automation/workflows/${w.id}/edit`}>
                    {t(locale, s.can('automation:write') ? 'm11.wf.open.edit' : 'm11.wf.open.view')}
                  </a>
                ),
              },
            ]}
          />
          {next && (
            <p>
              <a
                href={`/automation/workflows?${new URLSearchParams({ ...(status ? { status } : {}), cursor: next })}`}
              >
                {t(locale, 'm11.c.next')}
              </a>
            </p>
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.wf.title')}</PageTitle>
      <div className="nz-row" style={{ justifyContent: 'space-between' }}>
        <form method="get" className="nz-row" role="search" aria-label={t(locale, 'm11.wf.filter')}>
          <Field id="wf-status" label={t(locale, 'field.status')}>
            {(a) => (
              <Select name="status" defaultValue={status ?? ''} {...a}>
                <option value="">{t(locale, 'm11.c.all')}</option>
                {(['draft', 'active', 'paused', 'disabled'] as const).map((x) => (
                  <option key={x} value={x}>
                    {t(locale, `m11.wf.status.${x}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit">{t(locale, 'action.search')}</Button>
        </form>
        {s.can('automation:write') && (
          <ButtonLink href={`/automation/workflows/new`}>{t(locale, 'm11.wf.new')}</ButtonLink>
        )}
      </div>
      {body}
    </>
  );
}
