import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { AutomationTabs } from '../../../../../../../components/AutomationTabs';
import {
  RunWorkflowForm,
  WorkflowStatusActions,
} from '../../../../../../../components/AutomationPanels';
import { Status } from '../../../../../../../components/M11Parts';
import { WorkflowEditor } from '../../../../../../../components/WorkflowEditor';
import {
  FLAGS,
  executionTone,
  isUuid,
  itemsOf,
  workflowTone,
  type ExecutionDto,
  type WorkflowDto,
} from '../../../../../../../lib/m11';
import { actingHeader, actingOrgOf, gateM11, m11View } from '../../../../../../../lib/m11-server';

/** UI-M11-02: the visual editor of one workflow: canvas and JSON view, client-side hints, "Publish version" (server 422 errors inline), status, manual run, versions and recent executions. */
export default async function EditWorkflow({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'automation:read',
    title: 'm11.wf.edit.title',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const acting = await actingOrgOf(s);
  const header = actingHeader(acting);
  const body = await m11View(
    locale,
    async () => {
      const w = (await unwrap(
        s.api.GET('/v1/workflows/{id}', { params: { path: { id }, header } }),
      )) as unknown as WorkflowDto;
      const ex = itemsOf<ExecutionDto>(
        await unwrap(
          s.api.GET('/v1/workflows/{id}/executions', {
            params: { path: { id }, query: { limit: 10 }, header },
          }),
        ),
      );
      return { w, ex };
    },
    ({ w, ex }) => (
      <>
        <p className="nz-row">
          <Status
            locale={locale}
            prefix="m11.wf.status"
            value={w.status}
            tone={workflowTone(w.status)}
          />
          {w.activeVersion && <Ltr>{`v${w.activeVersion}`}</Ltr>}
          {w.nextRunAt && (
            <span className="nz-muted">
              {t(locale, 'm11.wf.nextRun', { time: formatDateTime(w.nextRunAt, locale) })}
            </span>
          )}
        </p>
        {w.status === 'paused' && (
          <Banner tone="warn">
            {w.pausedByAdmin
              ? t(locale, 'm11.wf.status.adminPausedBanner')
              : t(locale, 'm11.wf.status.pausedBanner', { reason: w.pausedReason ?? '' })}
          </Banner>
        )}
        <WorkflowStatusActions
          locale={locale}
          workflow={w}
          actingOrgId={acting}
          canWrite={s.can('automation:write')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
        <WorkflowEditor
          locale={locale}
          mode="edit"
          workflow={w}
          actingOrgId={acting}
          canWrite={s.can('automation:write')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
        {s.can('automation:run') && (
          <div style={{ marginBlockStart: 16 }}>
            <RunWorkflowForm
              locale={locale}
              workflow={w}
              actingOrgId={acting}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          </div>
        )}
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm11.wf.versions')}
        </h2>
        {(w.versions ?? []).length === 0 ? (
          <p className="nz-muted">{t(locale, 'm11.wf.versionsEmpty')}</p>
        ) : (
          <Table
            caption={t(locale, 'm11.wf.versions')}
            rows={w.versions ?? []}
            rowKey={(v) => v.id}
            columns={[
              {
                key: 'v',
                header: t(locale, 'm11.wf.col.version'),
                render: (v) => <Ltr>{`v${v.version}`}</Ltr>,
              },
              {
                key: 'a',
                header: t(locale, 'field.created'),
                render: (v) => formatDateTime(v.createdAt, locale),
              },
              {
                key: 'n',
                header: t(locale, 'm11.wf.publish.notes'),
                render: (v) => v.notes ?? '—',
              },
              {
                key: 'c',
                header: t(locale, 'field.status'),
                render: (v) =>
                  v.id === w.activeVersionId ? (
                    <Badge tone="success">{t(locale, 'm11.wf.versionActive')}</Badge>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm11.wf.recent')}
        </h2>
        {ex.length === 0 ? (
          <EmptyState title={t(locale, 'm11.wf.noRuns')} body={t(locale, 'm11.wf.noRunsBody')} />
        ) : (
          <Table
            caption={t(locale, 'm11.wf.recent')}
            rows={ex}
            rowKey={(e) => e.id}
            columns={[
              {
                key: 'id',
                header: t(locale, 'm11.exec.col.id'),
                render: (e) => (
                  <a href={`/${locale}/automation/executions/${e.id}`}>
                    <Ltr>{e.id.slice(0, 8)}</Ltr>
                  </a>
                ),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (e) => (
                  <Badge tone={executionTone(e.status)}>
                    {tDynamic(locale, `m11.exec.status.${e.status}`, e.status)}
                  </Badge>
                ),
              },
              {
                key: 't',
                header: t(locale, 'm11.exec.col.trigger'),
                render: (e) =>
                  tDynamic(
                    locale,
                    `m11.wf.trigger.${e.trigger === 'platform_event' ? 'event' : e.trigger}`,
                    e.trigger,
                  ),
              },
              {
                key: 'c',
                header: t(locale, 'field.created'),
                render: (e) => formatDateTime(e.createdAt, locale),
              },
            ]}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.wf.edit.title')}</PageTitle>
      <AutomationTabs locale={locale} current="workflows" />
      {body}
    </>
  );
}
