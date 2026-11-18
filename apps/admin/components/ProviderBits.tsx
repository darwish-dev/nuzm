'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Ltr } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  PROBLEM_CODES,
  jobDone,
  jobErrorCode,
  jobTone,
  pollDelay,
  problemCode,
  problemMessage,
  showServerDetail,
  type JobDto,
} from '../lib/providers';
import { Result, useStaffAction, type Notice, type Overrides } from './ProviderCommon';

/** Localized text for every problem code these screens know (looked up by `code` first, then status), for `useProviderAction().run`. */
export const providerOverrides = (locale: Locale): Overrides => ({
  ...Object.fromEntries(PROBLEM_CODES.map((c) => [c, problemMessage(locale, c, 0)])),
  '404': problemMessage(locale, undefined, 404),
  '409': problemMessage(locale, undefined, 409),
  '422': problemMessage(locale, undefined, 422),
});

/** Run a staff mutation with provider texts: busy flag, localized error, server explanation (never for a rejected credential), step-up. */
export function useProviderAction(locale: Locale, factorId: string | null) {
  const a = useStaffAction(locale, factorId);
  return { ...a, overrides: providerOverrides(locale) };
}

/** The outcome line of a mutation. A rejected credential never shows the server's explanation (it must not echo what was typed). */
export function ProviderResult(p: { n: Notice; problem?: unknown; locale: Locale }) {
  const hide = !showServerDetail(problemCode(p.problem));
  const problem = hide
    ? { ...(p.problem as Record<string, unknown>), detail: undefined }
    : p.problem;
  return <Result n={p.n} problem={problem} locale={p.locale} />;
}

/** Outcome of a polled job in words: its state, the error code of a failure, and the result summary of a success. */
export function JobView({ locale, job }: { locale: Locale; job: JobDto }) {
  const code = jobErrorCode(job);
  const result = (job.result ?? {}) as { health?: unknown; probeRef?: unknown };
  return (
    <div role="status" aria-live="polite" className="nz-row">
      <Badge tone={jobTone(job.state)}>
        {tDynamic(locale, `m05.adm.job.state.${job.state}`, job.state)}
      </Badge>
      <span>{t(locale, `m05.adm.job.kind.${job.kind}`)}</span>
      {job.state === 'failed' && (
        <span className="nz-error-text">
          {code ? problemMessage(locale, code, 0) : t(locale, 'm05.adm.job.failed')}
          {code && (
            <>
              {' '}
              <Ltr>{code}</Ltr>
            </>
          )}
        </span>
      )}
      {job.state === 'succeeded' && typeof result.health === 'string' && (
        <span className="nz-muted">
          {t(locale, 'm05.adm.job.health', {
            health: tDynamic(locale, `m05.adm.health.${result.health}`, result.health),
          })}
        </span>
      )}
      {job.updatedAt && <span className="nz-muted">{formatDateTime(job.updatedAt, locale)}</span>}
    </div>
  );
}

/**
 * Polls `GET /v1/admin/provider-jobs/{id}` (1 s, doubling to 8 s, up to a 5 minute budget) until the job reaches a terminal state, then
 * calls `onDone` once. A poll that cannot be answered stops with a visible message instead of spinning.
 */
export function JobPoller(p: { locale: Locale; jobId: string; onDone?: () => void }) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [failed, setFailed] = useState(false);
  const done = useRef(p.onDone);
  done.current = p.onDone;
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick(attempt: number) {
      const r = await browserApi().GET('/v1/admin/provider-jobs/{id}', {
        params: { path: { id: p.jobId } },
      });
      if (stop) return;
      if (!r.response.ok || !r.data) return setFailed(true);
      setJob(r.data);
      if (jobDone(r.data.state)) return done.current?.();
      const wait = pollDelay(attempt);
      if (wait === null) return setFailed(true);
      timer = setTimeout(() => void tick(attempt + 1), wait);
    }
    void tick(0);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [p.jobId]);
  if (failed && !job)
    return (
      <p role="alert" className="nz-error-text">
        {t(p.locale, 'm05.adm.job.pollFailed')}
      </p>
    );
  return (
    <>
      {job ? (
        <JobView locale={p.locale} job={job} />
      ) : (
        <p role="status" className="nz-muted">
          {t(p.locale, 'state.loading')}
        </p>
      )}
      {failed && job && !jobDone(job.state) && (
        <p role="alert" className="nz-error-text">
          {t(p.locale, 'm05.adm.job.pollStopped')}
        </p>
      )}
    </>
  );
}
