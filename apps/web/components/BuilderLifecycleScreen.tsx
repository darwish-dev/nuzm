'use client';
import { useMemo, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { bapi, newKey, useBuilderCall, useRunStream } from '../lib/builder-client';
import type { Run } from '../lib/builder';
import {
  LifecyclePanel,
  LifecycleStart,
  viewFromEvents,
  type DeploymentView,
  type PanelState,
} from './BuilderLifecycle';
import { ProblemNote } from './BuilderBits';

interface Session {
  id: string;
}

/**
 * The builder agent screen of one web-app project: start, live progress over the run's SSE events, cancel, and the link to the approvals inbox. The run is an ordinary `webapp` run
 * with `input.builderLifecycle` (flags `builder_tools.enabled` and `builder_lifecycle.enabled`, both default OFF: the API answers 422 `unsupported_capability` when off, shown as
 * "not enabled"). Nothing here deploys anything.
 */
export function BuilderLifecycleScreen({
  locale,
  projectId,
  canRun,
  initialRunId = null,
}: {
  locale: Locale;
  projectId: string;
  /** the member holds `ai:write` and `builder:write` */
  canRun: boolean;
  initialRunId?: string | null;
}) {
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [disabled, setDisabled] = useState(!canRun);
  const start = useBuilderCall();
  const cancel = useBuilderCall();
  const stream = useRunStream(runId, { terminalNotFound: true });
  const keys = useRef({ session: newKey(), run: newKey() });
  const sessionId = useRef<string | null>(null);

  const view = useMemo(() => viewFromEvents(stream.events), [stream.events]);
  const result = (stream.run as (Run & { result?: Record<string, unknown> }) | null)?.result;
  const deployment = (result?.deployment as DeploymentView | null | undefined) ?? null;
  const state: PanelState = !runId
    ? 'empty'
    : stream.status === 'not_found'
      ? 'missing'
      : stream.status === 'forbidden'
        ? 'forbidden'
        : stream.status === 'reconnecting' && !view
          ? 'offline'
          : !view
            ? 'loading'
            : 'ready';

  async function onStart(a: { prompt: string; maxRepairRounds: number }) {
    if (!sessionId.current) {
      const ok = await start.run(
        () =>
          bapi.post<Session>('/v1/ai/sessions', {
            body: { title: a.prompt.slice(0, 80), projectId },
            idempotencyKey: keys.current.session,
          }),
        (s) => {
          sessionId.current = s.id;
        },
      );
      if (!ok) return;
    }
    await start.run(
      () =>
        bapi.post<Run>('/v1/ai/runs', {
          body: {
            sessionId: sessionId.current,
            kind: 'webapp',
            projectId,
            input: {
              builderLifecycle: true,
              brief: { prompt: a.prompt },
              maxRepairRounds: a.maxRepairRounds,
            },
          },
          idempotencyKey: keys.current.run,
        }),
      (r) => {
        keys.current.run = newKey();
        sessionId.current = null;
        keys.current.session = newKey();
        setRunId(r.id);
      },
      (p) => {
        if (p.status !== 599) keys.current.run = newKey();
        // the flag is off for this organization: say so on the form instead of a generic error
        if (p.code === 'unsupported_capability') {
          setDisabled(true);
          return true;
        }
      },
    );
  }

  const active = view?.status === 'running' || view?.status === 'waiting_approval';
  return (
    <>
      {(!runId || (view && !active)) && (
        <LifecycleStart
          locale={locale}
          busy={start.busy}
          disabled={disabled || !canRun}
          onStart={(a) => void onStart(a)}
        />
      )}
      {start.problem && <ProblemNote locale={locale} problem={start.problem} />}
      {cancel.problem && <ProblemNote locale={locale} problem={cancel.problem} />}
      <LifecyclePanel
        locale={locale}
        state={state}
        view={view}
        simulated={result ? result.simulated !== false : true}
        deployment={deployment}
        versionId={(result?.versionId as string | null | undefined) ?? null}
        approvalsHref={`/${locale}/approvals`}
        cancelling={cancel.busy}
        onCancel={
          canRun && runId
            ? () =>
                void cancel.run(
                  () => bapi.post<{ state: string }>(`/v1/ai/runs/${runId}/cancellation`),
                  () => stream.reconnect(),
                )
            : undefined
        }
        onRetry={() => stream.reconnect()}
      />
      <p className="nz-muted">{t(locale, 'bt.lc.intro')}</p>
    </>
  );
}
