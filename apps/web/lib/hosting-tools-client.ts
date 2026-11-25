'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';

interface Res<T> {
  data?: T;
  error?: unknown;
  response: Response;
}
export type ToolNotice = { tone: 'ok' | 'error'; text: string } | null;

/** The words for a failed tool call: by problem code first, then by status. `invalid` names the screen's own "this value is not valid" text. */
export function toolProblem(
  locale: Locale,
  status: number,
  code: string | undefined,
  invalid?: MessageKey,
): string {
  if (code === 'quota_exceeded') return t(locale, 'ht.err.quota');
  if (code === 'unsupported_capability') return t(locale, 'ht.err.unsupported');
  if (status === 413 || code === 'payload_too_large') return t(locale, 'ht.err.tooLarge');
  if (status === 404) return t(locale, 'ht.err.notFound');
  if (status === 409) return t(locale, 'ht.err.conflict');
  if (status === 422 || status === 400) return t(locale, invalid ?? 'err.validation');
  if (status === 503) return t(locale, 'ht.err.unavailable');
  if (status === 403) return t(locale, 'state.forbidden.title');
  return t(locale, 'state.error.title');
}

/** Runs one mutation with a busy flag and a localized notice. */
export function useToolRun(locale: Locale) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ToolNotice>(null);
  const run = useCallback(
    async <T>(
      call: () => Promise<Res<T>>,
      okText: MessageKey | null,
      after: (data: T | undefined) => void,
      invalid?: MessageKey,
    ) => {
      setBusy(true);
      setNotice(null);
      let r: Res<T>;
      try {
        r = await call();
      } catch {
        setBusy(false);
        return setNotice({ tone: 'error', text: t(locale, 'ht.err.unavailable') });
      }
      setBusy(false);
      if (r.response.ok) {
        if (okText) setNotice({ tone: 'ok', text: t(locale, okText) });
        return after(r.data);
      }
      const code = (r.error as { code?: string } | undefined)?.code;
      setNotice({ tone: 'error', text: toolProblem(locale, r.response.status, code, invalid) });
    },
    [locale],
  );
  return { busy, notice, setNotice, run };
}

/** Loads data on mount and on `reload()`; a failure is a localized text, never a blank screen. */
export function useLoad<T>(locale: Locale, load: () => Promise<Res<T>>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await loadRef.current();
      if (r.response.ok) {
        setData(r.data as T);
        setError(null);
      } else {
        const code = (r.error as { code?: string } | undefined)?.code;
        setError(toolProblem(locale, r.response.status, code));
      }
    } catch {
      setError(t(locale, 'ht.err.unavailable'));
    }
    setLoading(false);
  }, [locale]);
  // `key` is the caller's way to say "the inputs changed"
  useEffect(() => void reload(), [reload, key]);
  return { data, error, loading, reload };
}
