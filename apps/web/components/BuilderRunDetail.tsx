'use client';
import { useState } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, Ltr, Table } from '@nuzm/ui';
import { credits, num, type Run } from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';
import { RunPanel } from './BuilderRun';

/**
 * UI-M09-09: one run in full: state, live events, the pending approval, cost (credits and tokens) and the artifacts it produced. An artifact payload is
 * immutable JSON; it is shown as plain text only.
 */
export function RunDetail({
  locale,
  run,
  canWrite,
}: {
  locale: Locale;
  run: Run;
  canWrite: boolean;
}) {
  const call = useBuilderCall();
  const [open, setOpen] = useState<{ id: string; type: string; text: string } | null>(null);
  const show = (a: { id: string; type: string }) =>
    void call.run(
      () => bapi.get<{ payload: unknown }>(`/v1/ai/runs/${run.id}/artifacts/${a.id}`),
      (d) => setOpen({ id: a.id, type: a.type, text: JSON.stringify(d.payload, null, 2) }),
    );
  return (
    <>
      <p className="nz-row">
        <Ltr>{run.id}</Ltr>
        {run.projectId && (
          <a href={`/builder/projects/${run.projectId}`}>
            {t(locale, 'bld.run.toProject')}
          </a>
        )}
      </p>
      <dl>
        <dt>{t(locale, 'bld.run.started')}</dt>
        <dd>{when(run.createdAt, locale)}</dd>
        <dt>{t(locale, 'bld.run.finished')}</dt>
        <dd>{when(run.finishedAt, locale)}</dd>
        <dt>{t(locale, 'bld.run.spent')}</dt>
        <dd>
          <Ltr>{credits(run.usage.spentCredits)}</Ltr>
        </dd>
        <dt>{t(locale, 'bld.run.tokens')}</dt>
        <dd>
          <Ltr>{`${num(run.usage.tokensIn)} / ${num(run.usage.tokensOut)}`}</Ltr>
        </dd>
        <dt>{t(locale, 'bld.run.model')}</dt>
        <dd>{run.usage.modelRef ? <Ltr>{run.usage.modelRef}</Ltr> : '—'}</dd>
        <dt>{t(locale, 'bld.run.region')}</dt>
        <dd>
          <Ltr>{run.dataRegion}</Ltr>
        </dd>
      </dl>
      <RunPanel locale={locale} runId={run.id} canWrite={canWrite} />
      <h2 className="nz-h2">{t(locale, 'bld.run.artifacts')}</h2>
      {run.artifacts.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bld.run.artifacts.none')}</p>
      ) : (
        <Table
          caption={t(locale, 'bld.run.artifacts')}
          rows={run.artifacts}
          rowKey={(a) => a.id}
          columns={[
            {
              key: 't',
              header: t(locale, 'bld.run.artifacts.type'),
              render: (a) => tDynamic(locale, `bld.artifact.${a.type}`, a.type),
            },
            {
              key: 'c',
              header: t(locale, 'bld.run.artifacts.created'),
              render: (a) => when(a.createdAt, locale),
            },
            {
              key: 'a',
              header: t(locale, 'bld.dep.col.actions'),
              render: (a) => (
                <Button variant="secondary" disabled={call.busy} onClick={() => show(a)}>
                  {t(locale, 'bld.run.artifacts.show')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {open && (
        <section aria-labelledby="bld-art-h">
          <h3 className="nz-h2" id="bld-art-h">
            {tDynamic(locale, `bld.artifact.${open.type}`, open.type)}
          </h3>
          <pre className="bld-pre" tabIndex={0} aria-label={t(locale, 'bld.run.artifacts.payload')}>
            {open.text}
          </pre>
        </section>
      )}
    </>
  );
}
