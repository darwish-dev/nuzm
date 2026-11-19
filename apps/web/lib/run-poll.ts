'use client';
import { useEffect, useRef } from 'react';
import { isRunActive, type Run } from './builder';
import { bapi } from './builder-client';

/** While a run works the stream is the live view; this is the safety net under it: the run row is read again every few seconds, so a card never stays on "Running". */
export const SAFETY_POLL_MS = 5000;

/**
 * Re-read the run row while it is queued or running (not while it waits for a person), tell the card the new row (`setRun`) and report a changed STATE to `onRun`
 * (the workspace then reloads the project). Paused while the tab is hidden.
 */
export function useRunSafetyPoll(
  runId: string,
  run: Run | null,
  setRun: (r: Run) => void,
  onState: (r: Run) => void,
) {
  const seen = useRef<string | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const setRef = useRef(setRun);
  setRef.current = setRun;
  /** the stream told the state already: do not report it twice */
  const known = (state: string) => {
    seen.current = state;
  };
  const working = run ? isRunActive(run.state) && run.state !== 'waiting_approval' : false;
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void bapi.get<Run>(`/v1/ai/runs/${runId}`).then((r) => {
        if (!r.response.ok || !r.data) return;
        setRef.current(r.data);
        if (seen.current !== r.data.state) {
          seen.current = r.data.state;
          onStateRef.current(r.data);
        }
      });
    }, SAFETY_POLL_MS);
    return () => clearInterval(id);
  }, [runId, working]);
  return known;
}
