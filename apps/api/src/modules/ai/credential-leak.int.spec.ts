import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * Phase 2, secure provider configuration: the API key an administrator types into the console is sealed in the (non-production) vault, and ONLY its reference is ever stored or
 * shown. This suite drives the whole admin flow and then looks for the key, and for recognisable pieces of it, in every place it could leak: responses (success AND error), the
 * audit events, every table of the database, and everything written to stdout, stderr and the console. The key is synthetic; nothing is sent to a vendor (fetch is stubbed to fail loudly).
 */
let e: AiEnv;
const KEY = `test-only-${'Xk4T'.repeat(9)}`; // 46 printable characters, synthetic
const FRAGMENTS = [KEY.slice(0, 20), KEY.slice(10, 30), KEY.slice(-20)];
const base = '/v1/admin/ai/model-providers';

const captured: string[] = [];
const sinks: { restore: () => void }[] = [];
function captureOutput() {
  const push = (chunk: unknown) =>
    void captured.push(typeof chunk === 'string' ? chunk : String(chunk));
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((c: unknown) => (push(c), true)) as never);
  const err = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((c: unknown) => (push(c), true)) as never);
  const cons = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi
      .spyOn(console, m)
      .mockImplementation((...a: unknown[]) => void push(a.map(String).join(' '))),
  );
  sinks.push({ restore: () => [out, err, ...cons].forEach((s) => s.mockRestore()) });
}
const noLeak = (text: string, where: string) => {
  expect(text, `${where}: the whole key`).not.toContain(KEY);
  for (const f of FRAGMENTS) expect(text, `${where}: a fragment of the key`).not.toContain(f);
};

beforeAll(async () => {
  e = await setupAiEnv();
}, 300_000);
afterAll(() => e.h.close());
afterEach(() => {
  vi.unstubAllGlobals();
  while (sinks.length) sinks.pop()!.restore();
});

describe('the admin credential flow never exposes the key', () => {
  it('save, read back, rotate, fail and clear: responses, audit events, tables and process output are free of the key', async () => {
    // a vendor request here would be a defect: the live gate is closed and fetch must not be reached
    const f = vi.fn(async () => {
      throw new Error('a request left the process');
    });
    vi.stubGlobal('fetch', f);
    captureOutput();
    const bodies: string[] = [];
    const act = async (who: string, method: 'GET' | 'POST', url: string, body?: object) => {
      const r = await e.admin(who, method, url, body);
      bodies.push(r.body);
      return r;
    };

    const saved = await act('padmin', 'POST', base, { action: 'save_claude_key', apiKey: KEY });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().vaultRef).toMatch(/^vault:\/\/(dev|mem)\/ai-claude$/);
    const id = saved.json().id as string;

    // every read model of the provider console after the key exists
    for (const url of [
      base,
      `${base}/capability-registry`,
      `${base}/health`,
      `${base}/${id}/rate-card-versions`,
    ])
      expect((await act('padmin', 'GET', url)).statusCode, url).toBe(200);
    expect(
      (
        await act(
          'padmin',
          'GET',
          '/v1/admin/ai/usage?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z&groupBy=provider',
        )
      ).statusCode,
    ).toBe(200);

    // the live-gated actions refuse, and their refusals do not echo the key
    for (const url of [`${base}/${id}/connection-test`, `${base}/${id}/model-discovery`]) {
      const r = await act('padmin', 'POST', url);
      expect(r.statusCode, url).toBe(422);
    }
    const probe = await act('padmin', 'POST', base, {
      action: 'probe_tool_use',
      id,
      model: 'claude-opus-5-5',
      approvalRef: 'synthetic-D9',
      maxTotalTokens: 20000,
    });
    expect(probe.statusCode, probe.body).toBeGreaterThanOrEqual(400);

    // malformed keys: refused without echoing what was typed
    const typed = [`${KEY} with spaces`, `${KEY}\nmore`, 'short', 12345, { nested: KEY }];
    for (const apiKey of typed) {
      const r = await act('padmin', 'POST', base, { action: 'save_claude_key', apiKey });
      expect(r.statusCode, JSON.stringify(apiKey)).toBeGreaterThanOrEqual(400);
    }
    // a credential smuggled through another action or another field name is refused as a credential value, and not echoed
    for (const field of ['apiKey', 'secret', 'token', 'password', 'key']) {
      const r = await act('padmin', 'POST', base, {
        action: 'configure',
        code: 'claude',
        adapter: 'anthropic',
        displayName: 'Claude',
        region: 'unspecified',
        [field]: KEY,
      });
      expect(r.statusCode, field).toBeGreaterThanOrEqual(400);
    }
    // a key where a vault reference belongs
    const asRef = await act('padmin', 'POST', base, {
      action: 'configure',
      code: 'claude',
      adapter: 'anthropic',
      displayName: 'Claude',
      region: 'unspecified',
      vaultRef: KEY,
    });
    expect(asRef.statusCode).toBeGreaterThanOrEqual(400);

    // an ordinary customer cannot reach the admin route at all, and still gets no echo
    const customer = await e.call('alice', 'POST', base, {
      action: 'save_claude_key',
      apiKey: KEY,
    });
    bodies.push(customer.body);
    expect(customer.statusCode).toBeGreaterThanOrEqual(400);
    // a request without a session
    const anon = await e.app.inject({
      method: 'POST',
      url: base,
      payload: { action: 'save_claude_key', apiKey: KEY },
    });
    bodies.push(anon.body);
    expect(anon.statusCode).toBeGreaterThanOrEqual(400);

    // rotation, then removal
    const rot = await act('padmin', 'POST', base, {
      action: 'save_claude_key',
      apiKey: `${KEY}-rotated`,
    });
    expect(rot.statusCode, rot.body).toBe(200);
    const cleared = await act('padmin', 'POST', base, { action: 'clear_credential', id });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().vaultRef).toBeNull();

    // 1. every response body
    noLeak(bodies.join('\n'), 'responses');
    // 2. the audit events recorded in memory and the audit table
    noLeak(JSON.stringify(e.sink.events), 'audit sink');
    const actions = e.sink.events.map((x) => x.action);
    expect(actions).toContain('ai.provider.credential_set');
    expect(actions).toContain('ai.provider.credential_cleared');
    // 3. every column of every table
    const tables = (await e.sql(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS t FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
    )) as { t: string }[];
    const leaks: string[] = [];
    for (const { t } of tables)
      for (const needle of [KEY, ...FRAGMENTS])
        if (
          (await e.sql(`SELECT 1 FROM ${t} x WHERE x::text LIKE $1 LIMIT 1`, [`%${needle}%`]))
            .length
        )
          leaks.push(`${t}:${needle.length}`);
    expect(leaks).toEqual([]);
    // 4. anything written to stdout, stderr or the console while all this ran
    noLeak(captured.join('\n'), 'process output');
    // 5. nothing reached the network
    expect(f).not.toHaveBeenCalled();
  });

  it('the audit event of a stored key names who and which reference, and nothing else of the key', async () => {
    const r = await e.admin('padmin', 'POST', base, {
      action: 'save_claude_key',
      apiKey: `${KEY}-again`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const ev = [...e.sink.events].reverse().find((x) => x.action === 'ai.provider.credential_set')!;
    expect(ev).toBeTruthy();
    expect(ev.actorUserId).toBe(e.ids.padmin);
    expect(ev.detail).toEqual({
      code: 'claude',
      vaultRef: expect.stringMatching(/^vault:\/\/(dev|mem)\/ai-claude$/),
    });
    noLeak(JSON.stringify(ev), 'audit event');
  });
});
