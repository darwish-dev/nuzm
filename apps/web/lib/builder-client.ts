'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CallResult } from './compute';
import { browserCompute } from './compute-client';
import {
  createSseParser,
  isRunFinished,
  lastSeq,
  mergeEvent,
  problemOf,
  shouldReconnect,
  toRunEvent,
  type BuilderProblem,
  type ChangeResult,
  type Op,
  type ProjectDetail,
  type Run,
  type RunEvent,
} from './builder';

/** Same-origin browser calls of the builder screens (CSRF, org and realm from the first-party cookies, like every other screen). */
export const bapi = browserCompute;

const read = (name: string) =>
  typeof document === 'undefined'
    ? undefined
    : document.cookie
        .split('; ')
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);

/** Headers of a hand-written browser call (the SSE stream): org and realm selectors; the session cookie travels as a first-party cookie. */
export const browserHeaders = (): Record<string, string> => {
  const org = read('nuzm_org');
  return { 'x-nuzm-realm': 'web', ...(org ? { 'x-nuzm-org': org } : {}) };
};

/** A new key per user action; a retry of the SAME action reuses its key, a new confirmation step takes a new one. */
export const newKey = (): string => crypto.randomUUID();

/**
 * Run one call: busy flag and the problem of the last failure (mapped to a message by its CODE, never the raw server text).
 * `onProblem` may claim a failure for the screen (return true) so the generic message is not shown as well.
 */
export function useBuilderCall() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BuilderProblem | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <T>(
      call: () => Promise<CallResult<T>>,
      onOk: (data: T) => void | Promise<void>,
      onProblem?: (p: BuilderProblem) => boolean | void,
    ): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      const r = await call();
      if (!mounted.current) return false;
      setBusy(false);
      if (r.response.ok) {
        await onOk(r.data as T);
        return true;
      }
      const p = problemOf(r);
      if (onProblem?.(p) !== true) setProblem(p);
      return false;
    },
    [],
  );
  return { run, busy, problem, clear: () => setProblem(null) };
}

export type StreamStatus =
  | 'idle'
  | 'streaming'
  | 'reconnecting'
  | 'ended'
  /** only with `{ terminalNotFound: true }`: the server answered 404 (no such run, or not one of the caller's) or 403: retrying cannot change that */
  | 'not_found'
  | 'forbidden';

/** the stream answered with a status that is an answer, not a failure of the network */
class StreamHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super(`stream ${httpStatus}`);
  }
}

/**
 * The live view of one run: the persisted events over SSE (through the same-origin proxy, `fetch` + a stream reader so the org and realm headers travel),
 * resumed after a drop with `Last-Event-ID`, plus the run row (state, usage, pending approval) re-read as events arrive. The stream ends by itself when the
 * run finishes or waits for an approval; `reconnect()` reopens it after the decision. If the stream keeps failing the loop degrades to polling the run row.
 */
export function useRunStream(runId: string | null, opts: { terminalNotFound?: boolean } = {}) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [nonce, setNonce] = useState(0);
  const eventsRef = useRef<RunEvent[]>([]);
  const lastRunId = useRef<string | null>(null);
  const prevState = useRef<string | null>(null);
  const [changed, setChanged] = useState<Run | null>(null);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setEvents([]);
      eventsRef.current = [];
      setStatus('idle');
      lastRunId.current = null;
      return;
    }
    if (lastRunId.current !== runId) {
      lastRunId.current = runId;
      eventsRef.current = [];
      prevState.current = null;
      setEvents([]);
      setRun(null);
    }
    const ctl = new AbortController();
    let stopped = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const fetchRun = async (): Promise<Run | null> => {
      const r = await bapi.get<Run>(`/v1/ai/runs/${runId}`);
      if (stopped || !r.response.ok || !r.data) return null;
      setRun(r.data);
      if (prevState.current !== r.data.state) {
        prevState.current = r.data.state;
        setChanged(r.data);
      }
      return r.data;
    };
    const streamOnce = async () => {
      const res = await fetch(`/v1/ai/runs/${runId}/events`, {
        headers: {
          accept: 'text/event-stream',
          'last-event-id': String(lastSeq(eventsRef.current)),
          ...browserHeaders(),
        },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new StreamHttpError(res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = createSseParser((f) => {
        const e = toRunEvent(f);
        if (!e) return;
        eventsRef.current = mergeEvent(eventsRef.current, e);
        setEvents(eventsRef.current);
        clearTimeout(debounce);
        debounce = setTimeout(() => void fetchRun(), 300);
      });
      setStatus('streaming');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(dec.decode(value, { stream: true }));
      }
    };
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        const h = setTimeout(res, ms);
        ctl.signal.addEventListener('abort', () => {
          clearTimeout(h);
          res();
        });
      });

    void (async () => {
      let failures = 0;
      while (!stopped) {
        try {
          await streamOnce();
          failures = 0;
        } catch (e) {
          if (stopped) return;
          // an unknown run (404), or one the caller may not read (403), is an answer: say so and stop, instead of "check your network" and a retry loop
          if (opts.terminalNotFound && e instanceof StreamHttpError) {
            if (e.httpStatus === 404) {
              setStatus('not_found');
              return;
            }
            if (e.httpStatus === 403) {
              setStatus('forbidden');
              return;
            }
          }
          failures += 1;
          setStatus('reconnecting');
        }
        if (stopped) return;
        const cur = await fetchRun();
        if (cur && !shouldReconnect(cur.state)) {
          setStatus('ended');
          return;
        }
        // after repeated failures the loop is a plain poll of the run row (every 3 s) until the stream works again
        await sleep(failures > 2 ? 3000 : 1000);
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(debounce);
      ctl.abort();
    };
  }, [runId, nonce]);

  return {
    run,
    events,
    status,
    /** reopen the stream (after an approval decision) */
    reconnect: () => setNonce((n) => n + 1),
    /** the run row, after the screen changed it itself (cancel, approval) */
    setRun,
    /** the last run row whose STATE differs from the previous one (for "the run finished: reload the site") */
    changed,
    finished: run ? isRunFinished(run.state) : false,
  };
}

/**
 * The head of a project plus "apply these ops to it" for the screens that edit one thing (SEO): the ops carry the base version, a stale base
 * (`base_outdated`) is reported as `stale` (the screen offers a reload), the result of the last change is kept for display.
 */
export function useProjectEditor(initial: ProjectDetail) {
  const call = useBuilderCall();
  const [detail, setDetail] = useState(initial);
  const [last, setLast] = useState<ChangeResult | null>(null);
  const [stale, setStale] = useState<{ headSeq?: number } | null>(null);
  const ref = useRef(initial);
  ref.current = detail;

  const reload = useCallback(async (): Promise<boolean> => {
    const r = await bapi.get<ProjectDetail>(`/v1/builder/projects/${ref.current.id}`);
    if (!r.response.ok || !r.data) return false;
    setDetail(r.data);
    ref.current = r.data;
    setStale(null);
    return true;
  }, []);

  const apply = useCallback(
    (ops: Op[]) =>
      call.run(
        () =>
          bapi.post<ChangeResult>(`/v1/builder/projects/${ref.current.id}/changes`, {
            body: { baseVersion: ref.current.versionId, ops, source: 'user' },
          }),
        async (res) => {
          setStale(null);
          setLast(res);
          await reload();
        },
        (p) => {
          if (p.code === 'base_outdated') {
            setStale({ headSeq: p.headSeq });
            return true;
          }
          if (p.status === 599) void reload(); // uncertain: look at the head before anything is sent again
          return false;
        },
      ),
    [call, reload],
  );
  return { detail, last, stale, apply, reload, busy: call.busy, problem: call.problem };
}
