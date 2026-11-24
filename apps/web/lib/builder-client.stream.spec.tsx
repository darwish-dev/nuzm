// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunStream } from './builder-client';

/**
 * DEFECT-20c: the run stream told "could not connect" (and kept retrying) for a run that does not exist. With `terminalNotFound` a 404 or 403 of the events stream is final; the other
 * consumers of the hook keep their behaviour (a failure is a reconnect), and a 5xx is still a reconnect for everyone.
 */
const reply = (status: number) =>
  vi.fn(async (url: string) =>
    String(url).endsWith('/events')
      ? new Response('{}', { status, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
  );
const RUN = '0198a3c0-aaaa-7000-8000-00000000dead';

afterEach(() => vi.unstubAllGlobals());

describe('useRunStream, terminalNotFound', () => {
  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
  ])('a %i is final: %s, with no further attempts', async (code, status) => {
    const f = reply(code);
    vi.stubGlobal('fetch', f);
    const { result } = renderHook(() => useRunStream(RUN, { terminalNotFound: true }));
    await waitFor(() => expect(result.current.status).toBe(status));
    const calls = f.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(f.mock.calls.length).toBe(calls);
    expect(result.current.status).toBe(status);
  });
  it('without the option a 404 is still a reconnect (the other screens are unchanged), and a 503 is a reconnect with it', async () => {
    vi.stubGlobal('fetch', reply(404));
    const a = renderHook(() => useRunStream(RUN));
    await waitFor(() => expect(a.result.current.status).toBe('reconnecting'));
    a.unmount();
    vi.stubGlobal('fetch', reply(503));
    const b = renderHook(() => useRunStream(RUN, { terminalNotFound: true }));
    await waitFor(() => expect(b.result.current.status).toBe('reconnecting'));
    b.unmount();
  });
});
