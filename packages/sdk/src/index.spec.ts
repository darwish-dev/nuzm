import { describe, expect, it } from 'vitest';
import { ApiError, createApi, unwrap } from './index';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

function harness(reply: () => Response, extra: Partial<Parameters<typeof createApi>[0]> = {}) {
  const seen: Request[] = [];
  const api = createApi({
    baseUrl: 'http://api.test',
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push(req);
      return reply();
    },
    ...extra,
  });
  return { api, seen };
}

describe('sdk', () => {
  it('adds the org selector, CSRF (unsafe methods only), forwarded headers and locale', async () => {
    const { api, seen } = harness(() => json(200, { items: [], nextCursor: null }), {
      getOrg: () => '00000000-0000-7000-8000-00000000000a',
      getCsrf: () => 'csrf-1',
      getHeaders: () => ({ cookie: 'nuzm_session=abc' }),
      locale: 'ar',
    });
    await api.GET('/v1/audit-logs', {});
    expect(seen[0]!.headers.get('x-nuzm-org')).toBe('00000000-0000-7000-8000-00000000000a');
    expect(seen[0]!.headers.get('x-csrf-token')).toBeNull(); // GET: no CSRF header
    expect(seen[0]!.headers.get('cookie')).toBe('nuzm_session=abc');
    expect(seen[0]!.headers.get('accept-language')).toBe('ar');
    await api.PATCH('/v1/notifications/{id}', {
      params: { path: { id: '00000000-0000-7000-8000-000000000001' } },
      body: { read: true },
    });
    expect(seen[1]!.headers.get('x-csrf-token')).toBe('csrf-1');
  });

  it('unwrap returns the typed body on success', async () => {
    const { api } = harness(() => json(200, { items: [], nextCursor: null, unreadCount: 3 }));
    const page = await unwrap(api.GET('/v1/notifications', {}));
    expect(page.unreadCount).toBe(3);
  });

  it('unwrap throws ApiError with code, detail and trace id from problem+json', async () => {
    const { api } = harness(() =>
      json(401, {
        type: 'x',
        title: 't',
        status: 401,
        code: 'step_up_required',
        detail: 'verify MFA',
        traceId: 'abc',
      }),
    );
    const err = await unwrap(api.GET('/v1/me', {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: 'step_up_required',
      traceId: 'abc',
      needsStepUp: true,
    });
  });

  it('falls back to the x-trace-id header and a generic code for non-problem errors', async () => {
    const { api } = harness(
      () => new Response('upstream down', { status: 502, headers: { 'x-trace-id': 't-9' } }),
    );
    const err = (await unwrap(api.GET('/v1/me', {})).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, code: 'unknown_error', traceId: 't-9' });
  });
});
