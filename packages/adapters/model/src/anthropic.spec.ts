import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  ModelAdapterError,
  runModelConformance,
  type ClaudeClient,
  type ClaudeMessage,
} from './index';

const KEY = `test-only-${'k5Rv'.repeat(8)}`;
const getApiKey = async () => KEY;

/** A deterministic stand-in for the SDK client: the contract is exercised without any network. */
function fakeClient(text = 'hello from a stub'): ClaudeClient {
  const msg = (max: number): ClaudeMessage => ({
    content: [{ type: 'thinking' }, { type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: Math.min(max, Math.ceil(text.length / 4)) },
  });
  return {
    messages: {
      create: async (p) => msg(p.max_tokens as number),
      stream: (p) => {
        const parts = text.match(/.{1,4}/g) ?? [];
        const it = (async function* () {
          for (const x of parts)
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: x } };
        })();
        return Object.assign(it, { finalMessage: async () => msg(p.max_tokens as number) });
      },
    },
  };
}
const make = () => new AnthropicModelAdapter({ getApiKey, clientFactory: () => fakeClient() });

describe('Claude adapter: the ModelAdapter contract', () => {
  it('passes the model conformance suite (a contract check only: never evidence of quality or live availability)', async () => {
    const results = await runModelConformance(make);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
  it('stays on contract 1.0 until its tool-use capability is read from the official documentation and probed (S-AG4): no 1.1 capability, and the v1.1 cases are reported as skipped', async () => {
    const a = make();
    expect(a.contractVersion).toBe('1.0.0');
    expect(
      a
        .models()
        .flatMap((m) => m.capabilities)
        .some(
          (c) => c === 'tool-use' || c === 'streaming-tool-calls' || c === 'parallel-tool-calls',
        ),
    ).toBe(false);
    const r = await runModelConformance(make);
    expect(r.some((c) => c.skipped && /implements 1\.0\.0/.test(c.detail ?? ''))).toBe(true);
    expect(r.filter((c) => !c.ok)).toEqual([]);
  });
  it('declares only documented facts and UNATTESTED data terms (a human attests, HG-09-01)', () => {
    const a = make();
    expect(a.models().map((m) => m.modelId)).toEqual([CLAUDE_MODEL_ID]);
    expect(a.dataTerms).toMatchObject({
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
    });
    expect(a.region).toBe('unspecified');
    expect(a.pricing.currency).toBe('USD');
  });
});

describe('Claude adapter: request and response shape (stubbed fetch, no real call)', () => {
  const reply = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const stub = (h: () => Response | Promise<Response>) => {
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        return h();
      }),
    );
  };
  afterEach(() => vi.unstubAllGlobals());
  const ok = (extra: Record<string, unknown> = {}) =>
    reply(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: CLAUDE_MODEL_ID,
      content: [{ type: 'text', text: '{"a":1}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
      ...extra,
    });
  const real = () => new AnthropicModelAdapter({ getApiKey });
  const req = {
    model: CLAUDE_MODEL_ID,
    messages: [
      { role: 'system' as const, content: 'You build websites.' },
      { role: 'user' as const, content: 'A site for a cafe' },
    ],
    maxTokens: 500,
    temperature: 0.9,
    responseFormat: 'json' as const,
  };

  it('posts once to the fixed host: system apart, no temperature, a hard max_tokens, JSON instruction added, usage mapped', async () => {
    stub(() => ok());
    const r = await real().complete({ callId: 'c' }, req);
    expect(r).toEqual({
      text: '{"a":1}',
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 7 },
      model: CLAUDE_MODEL_ID,
    });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).toBe('https://api.anthropic.com');
    expect(new URL(sent[0]!.url).pathname).toBe('/v1/messages');
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    const b = sent[0]!.body;
    expect(b.model).toBe(CLAUDE_MODEL_ID);
    expect(b.max_tokens).toBe(500);
    expect(b.temperature).toBeUndefined(); // removed on this model
    expect(String(b.system)).toContain('You build websites.');
    expect(String(b.system)).toContain('exactly one JSON value');
    expect(b.messages).toEqual([{ role: 'user', content: 'A site for a cafe' }]);
  });
  it('does not let the environment redirect it to another host', async () => {
    const was = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
    try {
      stub(() => ok());
      await real().complete({ callId: 'c' }, req);
      expect(new URL(sent[0]!.url).origin).toBe('https://api.anthropic.com');
    } finally {
      if (was === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = was;
    }
  });
  it('maps stop reasons: max_tokens is "length", refusal is "refusal"', async () => {
    stub(() => ok({ stop_reason: 'max_tokens' }));
    expect((await real().complete({ callId: 'c' }, req)).finishReason).toBe('length');
    stub(() => ok({ stop_reason: 'refusal' }));
    expect((await real().complete({ callId: 'c' }, req)).finishReason).toBe('refusal');
  });
  it.each([
    [429, 'rate_limited', true],
    [401, 'invalid_request', false],
    [403, 'invalid_request', false],
    [400, 'invalid_request', false],
    [500, 'unavailable', true],
    [529, 'unavailable', true],
  ] as const)(
    'HTTP %i becomes %s (retryable: %s), once, without the upstream message',
    async (status, code, retryable) => {
      stub(() => reply(status, { type: 'error', error: { type: 'x', message: `leak ${KEY}` } }));
      const e = await real()
        .complete({ callId: 'c' }, req)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelAdapterError);
      expect(e).toMatchObject({ code, retryable });
      expect(String((e as Error).message)).not.toContain(KEY);
      expect(sent).toHaveLength(1); // the gateway decides about retries, not the adapter
    },
  );
  it('carries the provider\'s Retry-After hint on a 429 and a 529 (offline, stubbed): a hint, never a decision', async () => {
    stub(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'm' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        }),
    );
    await expect(real().complete({ callId: 'c' }, req)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 2000,
    });
    stub(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'm' } }), {
          status: 529,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '750' },
        }),
    );
    await expect(real().complete({ callId: 'c' }, req)).rejects.toMatchObject({
      code: 'unavailable',
      retryAfterMs: 750,
    });
    stub(() => reply(429, { type: 'error', error: { type: 'x', message: 'm' } }));
    const e = (await real()
      .complete({ callId: 'c' }, req)
      .catch((x: unknown) => x)) as ModelAdapterError;
    expect(e.retryAfterMs).toBeUndefined();
  });
  it('a network failure is "unavailable"; an aborted signal is "aborted" and sends nothing', async () => {
    stub(() => Promise.reject(new TypeError('fetch failed')));
    await expect(real().complete({ callId: 'c' }, req)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('network'),
    });
    stub(() => ok());
    const ac = new AbortController();
    ac.abort();
    await expect(real().complete({ callId: 'c', signal: ac.signal }, req)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(sent).toHaveLength(0);
  });
  it('without a stored key it fails closed and never calls out', async () => {
    stub(() => ok());
    const none = new AnthropicModelAdapter({ getApiKey: async () => null });
    await expect(none.complete({ callId: 'c' }, req)).rejects.toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
    expect(sent).toHaveLength(0);
  });
  it('refuses a conversation that does not start with a user message, and an unknown model', async () => {
    stub(() => ok());
    await expect(
      real().complete(
        { callId: 'c' },
        { ...req, messages: [{ role: 'assistant' as const, content: 'hi' }] },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    await expect(
      real().complete({ callId: 'c' }, { ...req, model: 'gpt-x' }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(sent).toHaveLength(0);
  });
  it('picks up a replaced key on the next call (no stale key is kept)', async () => {
    let key = KEY;
    const a = new AnthropicModelAdapter({ getApiKey: async () => key });
    stub(() => ok());
    await a.complete({ callId: 'c1' }, req);
    key = `${KEY}-2`;
    await a.complete({ callId: 'c2' }, req);
    expect(sent.map((s) => s.headers.get('authorization'))).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${KEY}-2`,
    ]);
  });
});
