import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAnthropic } from './claude-probe';

const KEY = `test-only-${'p7Wd'.repeat(8)}`;
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; headers: Headers }[] = [];
const stub = (h: () => Response | Promise<Response>) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return h();
    }),
  );
};
afterEach(() => vi.unstubAllGlobals());

describe('Claude connection probe (the network is stubbed: no real call is made here)', () => {
  it('lists models once on the fixed host with the key sent by the SDK, and reports how many it sees', async () => {
    stub(() => reply(200, { data: [{ id: 'm-1' }, { id: 'm-2' }], has_more: false }));
    const r = await probeAnthropic(KEY);
    expect(r).toEqual({ outcome: 'ok', httpStatus: 200, modelCount: 2 });
    expect(calls).toHaveLength(1); // one attempt, no retries
    expect(new URL(calls[0]!.url).origin).toBe('https://api.anthropic.com');
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/models');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`); // the SDK decides how the key is sent
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('does not let the environment redirect it to another host', async () => {
    const was = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
    try {
      stub(() => reply(200, { data: [] }));
      await probeAnthropic(KEY);
      expect(new URL(calls[0]!.url).origin).toBe('https://api.anthropic.com');
    } finally {
      if (was === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = was;
    }
  });
  it.each([
    [401, 'invalid_key'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'error'],
  ] as const)('HTTP %i becomes %s, once, without retrying', async (status, outcome) => {
    stub(() => reply(status, { type: 'error', error: { type: 'x', message: `leak ${KEY}` } }));
    const r = await probeAnthropic(KEY);
    expect(r.outcome).toBe(outcome);
    expect(r.httpStatus).toBe(status);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(KEY); // an error body is never passed on
  });
  it('a network failure becomes "unreachable"', async () => {
    stub(() => Promise.reject(new TypeError('fetch failed')));
    expect(await probeAnthropic(KEY)).toEqual({ outcome: 'unreachable' });
  });
});
