import { describe, expect, it } from 'vitest';
import {
  GEMINI_MODEL_ID,
  GeminiModelAdapter,
  ModelAdapterError,
  OPENAI_MODEL_ID,
  OpenAIModelAdapter,
  assembleStream,
  geminiPricingStale,
  runModelConformance,
  type CompleteRequest,
  type FetchLike,
  type StreamChunk,
} from './index';

/**
 * The REST adapters against a STUBBED transport. The wire shapes below are written from the vendors' documentation (docs/adapters/openai.md, gemini.md): they are
 * doc-shaped, NOT recorded from the real services. Everything here is SIMULATED; nothing is evidence that a provider works.
 */
const KEY = `test-only-${'q7Zt'.repeat(8)}`;
const getApiKey = async () => KEY;
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
function stub(handler: (s: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const s: Seen = {
      url,
      method: String(init.method),
      headers,
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    seen.push(s);
    return handler(s, seen.length);
  };
  return { f, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const sse = (events: unknown[], tail = '') =>
  new Response(
    events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('') + tail,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );

const STUB_TEXT = 'hello from a stub';
const outTokens = (max: unknown) => Math.min(Number(max), Math.ceil(STUB_TEXT.length / 4));
/** A stub that answers like the vendor for a plain text request, honouring the output ceiling and the streaming switch (for the conformance suite). */
const conformantOpenAI: FetchLike = async (_url, init) => {
  const b = JSON.parse(String(init.body)) as { stream?: boolean; max_completion_tokens: number };
  const usage = { prompt_tokens: 5, completion_tokens: outTokens(b.max_completion_tokens) };
  if (b.stream)
    return sse([
      { choices: [{ index: 0, delta: { content: STUB_TEXT }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
      '[DONE]',
    ]);
  return json(200, {
    choices: [{ message: { role: 'assistant', content: STUB_TEXT }, finish_reason: 'stop' }],
    usage,
  });
};
const conformantGemini: FetchLike = async (url, init) => {
  const b = JSON.parse(String(init.body)) as { generationConfig: { maxOutputTokens: number } };
  const usageMetadata = {
    promptTokenCount: 5,
    candidatesTokenCount: outTokens(b.generationConfig.maxOutputTokens),
  };
  const cand = { content: { parts: [{ text: STUB_TEXT }] }, finishReason: 'STOP' };
  if (url.includes(':streamGenerateContent')) return sse([{ candidates: [cand], usageMetadata }]);
  return json(200, { candidates: [cand], usageMetadata });
};
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];
const ctx = (id = 'c1') => ({ callId: id });
const collect = async (it: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};
const errOf = async (p: Promise<unknown>): Promise<ModelAdapterError> => {
  try {
    await p;
  } catch (e) {
    return e as ModelAdapterError;
  }
  throw new Error('expected an error');
};

// ───────────────────────────── OpenAI ─────────────────────────────
const oaText = (text: string) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: text, refusal: null },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});
const oaCall = (calls: { id: string; name: string; args: string }[]) => ({
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 9 },
});
const oa = (
  h: Parameters<typeof stub>[0],
  o: Partial<ConstructorParameters<typeof OpenAIModelAdapter>[0]> = {},
) => {
  const s = stub(h);
  return { s, a: new OpenAIModelAdapter({ getApiKey, fetchImpl: s.f, contract: '1.1', ...o }) };
};
const oaReq = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
  model: OPENAI_MODEL_ID,
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 64,
  ...extra,
});

describe('OpenAI adapter (stubbed transport, doc-shaped; SIMULATED)', () => {
  it('passes the model conformance suite on contract 1.0 and 1.1 (a contract check only)', async () => {
    const make = (contract: '1.0' | '1.1') => () =>
      new OpenAIModelAdapter({
        getApiKey,
        contract,
        fetchImpl: conformantOpenAI,
      });
    for (const c of ['1.0', '1.1'] as const) {
      const r = await runModelConformance(make(c));
      expect(r.filter((x) => !x.ok)).toEqual([]);
    }
  });
  it('declares only documented facts, UNATTESTED terms, and no 1.1 capability on 1.0', () => {
    const a = new OpenAIModelAdapter({ getApiKey });
    expect(a.contractVersion).toBe('1.0.0');
    expect(a.models().flatMap((m) => m.capabilities)).not.toContain('tool-use');
    expect(a.dataTerms).toMatchObject({
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
    });
    expect(a.region).toBe('unspecified');
  });
  it('sends one request to the fixed host with Bearer auth, max_completion_tokens and no temperature or key in the body', async () => {
    const { s, a } = oa(() => json(200, oaText('hi'), { 'x-request-id': 'req_abcd1234' }));
    const r = await a.complete(
      ctx(),
      oaReq({
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
      }),
    );
    expect(r).toMatchObject({
      text: 'hi',
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 3 },
      requestId: 'req_abcd1234',
    });
    expect(s.seen).toHaveLength(1);
    const q = s.seen[0]!;
    expect(q.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(q.body).toMatchObject({ model: OPENAI_MODEL_ID, max_completion_tokens: 64 });
    expect(q.body).not.toHaveProperty('temperature');
    expect(q.body).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(q.body)).not.toContain(KEY);
    expect((q.body!.messages as { role: string }[])[0]!.role).toBe('developer');
  });
  it('drops a request id that is not of the documented shape (it ends up in evidence files)', async () => {
    const { a } = oa(() => json(200, oaText('hi'), { 'x-request-id': 'not an id\n' }));
    expect((await a.complete(ctx(), oaReq())).requestId).toBeUndefined();
  });
  it('JSON mode: response_format json_object plus an instruction message', async () => {
    const { s, a } = oa(() => json(200, oaText('{}')));
    await a.complete(ctx(), oaReq({ responseFormat: 'json' }));
    expect(s.seen[0]!.body).toMatchObject({ response_format: { type: 'json_object' } });
    expect(JSON.stringify(s.seen[0]!.body!.messages)).toContain('JSON');
  });
  it('refuses before the key is read while the live gate is closed; nothing is sent', async () => {
    let read = 0;
    const s = stub(() => json(200, oaText('x')));
    const a = new OpenAIModelAdapter({
      getApiKey: async () => (read++, KEY),
      fetchImpl: s.f,
      liveEnabled: () => false,
    });
    const e = await errOf(a.complete(ctx(), oaReq()));
    expect(e).toMatchObject({ code: 'unavailable', retryable: false });
    expect(read).toBe(0);
    expect(s.seen).toHaveLength(0);
  });
  it('no stored key → non-retryable unavailable, nothing sent', async () => {
    const s = stub(() => json(200, oaText('x')));
    const a = new OpenAIModelAdapter({ getApiKey: async () => null, fetchImpl: s.f });
    expect(await errOf(a.complete(ctx(), oaReq()))).toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
    expect(s.seen).toHaveLength(0);
  });
  it('maps HTTP errors onto the contract codes and never carries the vendor message', async () => {
    const body = { error: { message: `leak: ${KEY} and the prompt text`, type: 'x', code: 'x' } };
    const cases: [number, string, boolean][] = [
      [400, 'invalid_request', false],
      [401, 'invalid_request', false],
      [403, 'invalid_request', false],
      [404, 'invalid_request', false],
      [408, 'timeout', true],
      [429, 'rate_limited', true],
      [500, 'unavailable', true],
      [503, 'unavailable', true],
    ];
    for (const [status, code, retryable] of cases) {
      const { a } = oa(() => json(status, body));
      const e = await errOf(a.complete(ctx(), oaReq()));
      expect({ status, code: e.code, retryable: e.retryable }).toEqual({ status, code, retryable });
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain('prompt text');
    }
  });
  it('a 429 for credit, spend or quota is NOT retryable (documented codes); a plain 429 is, with the Retry-After hint', async () => {
    for (const code of [
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
      'insufficient_quota',
    ]) {
      const { a } = oa(() =>
        json(429, { error: { message: 'm', type: 'insufficient_quota', code } }),
      );
      expect(await errOf(a.complete(ctx(), oaReq()))).toMatchObject({
        code: 'rate_limited',
        retryable: false,
      });
    }
    const { a } = oa(() =>
      json(429, { error: { code: 'slow_down', type: 'rate_limit_error' } }, { 'retry-after': '3' }),
    );
    expect(await errOf(a.complete(ctx(), oaReq()))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 3000,
    });
  });
  it('a network failure is retryable unavailable; the caller abort is aborted; a hung request times out', async () => {
    const down = new OpenAIModelAdapter({
      getApiKey,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await errOf(down.complete(ctx(), oaReq()))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    const ac = new AbortController();
    const hang: FetchLike = (_u, init) =>
      new Promise((_r, rej) =>
        init.signal!.addEventListener('abort', () =>
          rej(Object.assign(new Error('x'), { name: 'AbortError' })),
        ),
      );
    const hung = new OpenAIModelAdapter({ getApiKey, fetchImpl: hang, timeoutMs: 20 });
    expect(await errOf(hung.complete(ctx(), oaReq()))).toMatchObject({ code: 'timeout' });
    const p = errOf(
      new OpenAIModelAdapter({ getApiKey, fetchImpl: hang }).complete(
        { callId: 'a', signal: ac.signal },
        oaReq(),
      ),
    );
    setTimeout(() => ac.abort(), 10);
    expect(await p).toMatchObject({ code: 'aborted', retryable: false });
  });
  it('tool calling: declarations, forced choice, no parallel flag set for one call, reasoning_effort none (documented requirement)', async () => {
    const { s, a } = oa(() =>
      json(200, oaCall([{ id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }])),
    );
    const r = await a.complete(ctx(), oaReq({ tools: TOOLS, toolChoice: { name: 'read_file' } }));
    await a.complete(ctx(), oaReq({ tools: TOOLS, maxToolCalls: 1 }));
    expect(s.seen[1]!.body).toMatchObject({ parallel_tool_calls: false });
    expect(r).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }],
    });
    expect(s.seen[0]!.body).toMatchObject({
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: TOOLS[0]!.inputSchema } },
      ],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
      parallel_tool_calls: true,
      reasoning_effort: 'none',
    });
  });
  it('tool calling is refused on contract 1.0 and for malformed specs before anything is sent', async () => {
    const s = stub(() => json(200, oaText('x')));
    const a = new OpenAIModelAdapter({ getApiKey, fetchImpl: s.f });
    expect(await errOf(a.complete(ctx(), oaReq({ tools: TOOLS })))).toMatchObject({
      code: 'unsupported_capability',
    });
    const b = new OpenAIModelAdapter({ getApiKey, fetchImpl: s.f, contract: '1.1' });
    expect(
      await errOf(
        b.complete(
          ctx(),
          oaReq({
            tools: [{ name: 'Bad Name', description: 'x', inputSchema: { type: 'object' } }],
          }),
        ),
      ),
    ).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(s.seen).toHaveLength(0);
  });
  it('malformed arguments, an undeclared tool and a truncated call are invalid_response (never passed on)', async () => {
    for (const calls of [
      [{ id: 'c1', name: 'read_file', args: '{"path":' }],
      [{ id: 'c1', name: 'nope', args: '{}' }],
      [{ id: 'c1', name: 'read_file', args: '[1]' }],
    ]) {
      const { a } = oa(() => json(200, oaCall(calls)));
      expect(await errOf(a.complete(ctx(), oaReq({ tools: TOOLS })))).toMatchObject({
        code: 'invalid_response',
        retryable: false,
      });
    }
    const cut = oaCall([{ id: 'c1', name: 'read_file', args: '{"pa' }]);
    cut.choices[0]!.finish_reason = 'length';
    const { a } = oa(() => json(200, cut));
    expect(await errOf(a.complete(ctx(), oaReq({ tools: TOOLS })))).toMatchObject({
      code: 'invalid_response',
    });
  });
  it('two calls in one response are refused when parallel calls were not asked for (serial request)', async () => {
    const { a } = oa(() =>
      json(
        200,
        oaCall([
          { id: 'c1', name: 'read_file', args: '{"path":"a"}' },
          { id: 'c2', name: 'read_file', args: '{"path":"b"}' },
        ]),
      ),
    );
    expect(await errOf(a.complete(ctx(), oaReq({ tools: TOOLS, maxToolCalls: 1 })))).toMatchObject({
      code: 'invalid_response',
    });
    const p = oa(() =>
      json(
        200,
        oaCall([
          { id: 'c1', name: 'read_file', args: '{"path":"a"}' },
          { id: 'c2', name: 'read_file', args: '{"path":"b"}' },
        ]),
      ),
    );
    const r = await p.a.complete(ctx(), oaReq({ tools: TOOLS, maxToolCalls: 2 }));
    expect(r.toolCalls).toHaveLength(2);
    expect(p.s.seen[0]!.body).toMatchObject({ parallel_tool_calls: true });
  });
  it('round trip: the assistant call and the tool result are sent as the documented assistant tool_calls and tool messages', async () => {
    const { s, a } = oa(() => json(200, oaText('the answer')));
    await a.complete(
      ctx(),
      oaReq({
        tools: TOOLS,
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            blocks: [
              { type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
            ],
          },
          {
            role: 'user',
            content: '',
            blocks: [{ type: 'tool_result', callId: 'call_1', content: 'file text' }],
          },
        ],
      }),
    );
    expect(s.seen[0]!.body!.messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
    ]);
  });
  it('a conversation with an unanswered tool call is refused before a billed call', async () => {
    const { s, a } = oa(() => json(200, oaText('x')));
    const e = await errOf(
      a.complete(
        ctx(),
        oaReq({
          tools: TOOLS,
          messages: [
            { role: 'user', content: 'x' },
            {
              role: 'assistant',
              content: '',
              blocks: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }],
            },
            { role: 'user', content: 'again' },
          ],
        }),
      ),
    );
    expect(e).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(s.seen).toHaveLength(0);
  });
  it('a refusal and a content filter are finishReason refusal', async () => {
    const { a } = oa(() =>
      json(200, {
        choices: [
          { message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    expect((await a.complete(ctx(), oaReq())).finishReason).toBe('refusal');
    const f = oa(() =>
      json(200, {
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
      }),
    );
    expect(await f.a.complete(ctx(), oaReq())).toMatchObject({
      finishReason: 'refusal',
      usage: null,
    });
  });
  it('stream: text deltas, usage from the final choices:[] chunk, [DONE]; asks for include_usage', async () => {
    const { s, a } = oa(
      () =>
        sse(
          [
            {
              choices: [
                { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
              ],
            },
            { choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
            '[DONE]',
          ],
          '',
        ),
      {},
    );
    const chunks = await collect(a.stream(ctx(), oaReq()));
    expect(chunks.filter((c) => 'delta' in c)).toEqual([{ delta: 'Hel' }, { delta: 'lo' }]);
    expect(chunks.at(-1)).toEqual({
      done: true,
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(s.seen[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });
  it('stream: tool-call fragments by index assemble into the same call as complete', async () => {
    const { a } = oa(() =>
      sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'read_file', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.txt"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 6 } },
        '[DONE]',
      ]),
    );
    const r = await assembleStream(a.stream(ctx(), oaReq({ tools: TOOLS })), { tools: TOOLS });
    expect(r).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_9', name: 'read_file', args: { path: 'b.txt' } }],
      usage: { inputTokens: 11, outputTokens: 6 },
    });
  });
  it('stream cut before [DONE] is a retryable unavailable; a consumer that stops reading cancels the request', async () => {
    const cut = oa(() =>
      sse([{ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }]),
    );
    expect(await errOf(collect(cut.a.stream(ctx(), oaReq())))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    let aborted = false;
    const f: FetchLike = async (_u, init) => {
      init.signal!.addEventListener('abort', () => (aborted = true));
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] })}\n\n`,
            ),
          );
        },
      });
      return new Response(body, { status: 200 });
    };
    const a = new OpenAIModelAdapter({ getApiKey, fetchImpl: f });
    for await (const _c of a.stream(ctx(), oaReq())) break;
    expect(aborted).toBe(true);
  });
  it('cancel mid-stream with the caller signal ends with aborted', async () => {
    const ac = new AbortController();
    const f: FetchLike = async (_u, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] })}\n\n`,
              ),
            );
            init.signal!.addEventListener('abort', () =>
              c.error(Object.assign(new Error('x'), { name: 'AbortError' })),
            );
          },
        }),
        { status: 200 },
      );
    const a = new OpenAIModelAdapter({ getApiKey, fetchImpl: f });
    const e = await errOf(
      (async () => {
        for await (const c of a.stream({ callId: 's', signal: ac.signal }, oaReq()))
          if ('delta' in c) ac.abort();
      })(),
    );
    expect(e).toMatchObject({ code: 'aborted', retryable: false });
  });
  it('model discovery: GET /models, sanitised ids, nothing billed, the gate applies', async () => {
    const { s, a } = oa(() =>
      json(200, {
        object: 'list',
        data: [
          { id: OPENAI_MODEL_ID, object: 'model', created: 1_700_000_000, owned_by: 'x' },
          { id: 'bad id!' },
        ],
      }),
    );
    const m = await a.discoverModels(ctx());
    expect(m.map((x) => x.modelId)).toEqual([OPENAI_MODEL_ID]);
    expect(s.seen[0]).toMatchObject({ method: 'GET', url: 'https://api.openai.com/v1/models' });
    expect(s.seen[0]!.body).toBeNull();
    const closed = new OpenAIModelAdapter({ getApiKey, fetchImpl: s.f, liveEnabled: () => false });
    expect(await errOf(closed.discoverModels(ctx()))).toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
  });
});

// ───────────────────────────── Gemini ─────────────────────────────
const gmText = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  ...extra,
});
const gm = (
  h: Parameters<typeof stub>[0],
  o: Partial<ConstructorParameters<typeof GeminiModelAdapter>[0]> = {},
) => {
  const s = stub(h);
  return { s, a: new GeminiModelAdapter({ getApiKey, fetchImpl: s.f, contract: '1.1', ...o }) };
};
const gmReq = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
  model: GEMINI_MODEL_ID,
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 64,
  ...extra,
});

describe('Gemini adapter (stubbed transport, doc-shaped; SIMULATED)', () => {
  it('passes the model conformance suite on contract 1.0 and 1.1', async () => {
    for (const c of ['1.0', '1.1'] as const) {
      const r = await runModelConformance(
        () =>
          new GeminiModelAdapter({
            getApiKey,
            contract: c,
            fetchImpl: conformantGemini,
          }),
      );
      expect(r.filter((x) => !x.ok)).toEqual([]);
    }
  });
  it('declares tool-use only as a candidate (parallel and streamed calls are not stated for generateContent: unsupported)', () => {
    const caps = new GeminiModelAdapter({ getApiKey, contract: '1.1' }).models()[0]!.capabilities;
    expect(caps).toContain('tool-use');
    expect(caps).not.toContain('parallel-tool-calls');
    expect(caps).not.toContain('streaming-tool-calls');
    expect(new GeminiModelAdapter({ getApiKey }).models()[0]!.capabilities).not.toContain(
      'tool-use',
    );
  });
  it('the key travels in the x-goog-api-key header, never in the URL or body; fixed host and path; no temperature', async () => {
    const { s, a } = gm(() => json(200, gmText('hi')));
    const r = await a.complete(
      ctx(),
      gmReq({
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'again' },
        ],
      }),
    );
    expect(r).toMatchObject({
      text: 'hi',
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const q = s.seen[0]!;
    expect(q.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ID}:generateContent`,
    );
    expect(q.headers['x-goog-api-key']).toBe(KEY);
    expect(q.url).not.toContain(KEY);
    expect(JSON.stringify(q.body)).not.toContain(KEY);
    expect(q.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      generationConfig: { maxOutputTokens: 64 },
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'again' }] },
      ],
    });
    expect(q.body!.generationConfig).not.toHaveProperty('temperature');
  });
  it('usage counts the tool-use prompt as input and thinking tokens as output (billed as output)', async () => {
    const { a } = gm(() =>
      json(
        200,
        gmText('x', {
          usageMetadata: {
            promptTokenCount: 10,
            toolUsePromptTokenCount: 2,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
          },
        }),
      ),
    );
    expect((await a.complete(ctx(), gmReq())).usage).toEqual({ inputTokens: 12, outputTokens: 10 });
    const none = gm(() => json(200, gmText('x', { usageMetadata: undefined })));
    expect((await none.a.complete(ctx(), gmReq())).usage).toBeNull();
  });
  it('JSON mode uses responseMimeType application/json', async () => {
    const { s, a } = gm(() => json(200, gmText('{}')));
    await a.complete(ctx(), gmReq({ responseFormat: 'json' }));
    expect(s.seen[0]!.body!.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
    });
  });
  it('finish reasons: MAX_TOKENS length, SAFETY refusal, a blocked prompt refusal, malformed call invalid_response', async () => {
    const reply = (finishReason: string) => ({
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }],
    });
    expect(
      (await gm(() => json(200, reply('MAX_TOKENS'))).a.complete(ctx(), gmReq())).finishReason,
    ).toBe('length');
    expect(
      (await gm(() => json(200, reply('SAFETY'))).a.complete(ctx(), gmReq())).finishReason,
    ).toBe('refusal');
    expect(
      (
        await gm(() => json(200, { promptFeedback: { blockReason: 'SAFETY' } })).a.complete(
          ctx(),
          gmReq(),
        )
      ).finishReason,
    ).toBe('refusal');
    for (const f of [
      'MALFORMED_FUNCTION_CALL',
      'MISSING_THOUGHT_SIGNATURE',
      'UNEXPECTED_TOOL_CALL',
    ])
      expect(await errOf(gm(() => json(200, reply(f))).a.complete(ctx(), gmReq()))).toMatchObject({
        code: 'invalid_response',
        retryable: false,
      });
  });
  it('maps HTTP errors by status only (the generateContent error body is not documented) and never carries the body', async () => {
    const body = { error: { code: 400, message: `leak ${KEY}`, status: 'INVALID_ARGUMENT' } };
    for (const [status, code, retryable] of [
      [400, 'invalid_request', false],
      [402, 'invalid_request', false],
      [403, 'invalid_request', false],
      [404, 'invalid_request', false],
      [429, 'rate_limited', true],
      [500, 'unavailable', true],
      [503, 'unavailable', true],
      [504, 'timeout', true],
    ] as const) {
      const e = await errOf(gm(() => json(status, body)).a.complete(ctx(), gmReq()));
      expect({ status, code: e.code, retryable: e.retryable }).toEqual({ status, code, retryable });
      expect(e.message).not.toContain(KEY);
    }
  });
  it('refuses before the key is read while the live gate is closed', async () => {
    let read = 0;
    const s = stub(() => json(200, gmText('x')));
    const a = new GeminiModelAdapter({
      getApiKey: async () => (read++, KEY),
      fetchImpl: s.f,
      liveEnabled: () => false,
    });
    expect(await errOf(a.complete(ctx(), gmReq()))).toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
    expect(await errOf(collect(a.stream(ctx(), gmReq())))).toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
    expect(read).toBe(0);
    expect(s.seen).toHaveLength(0);
  });
  it('function calling: declarations as parametersJsonSchema, ANY with the allowed name when forced, an id derived when the vendor sends none', async () => {
    const { s, a } = gm(() =>
      json(200, {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      }),
    );
    const r = await a.complete(ctx(), gmReq({ tools: TOOLS, toolChoice: { name: 'read_file' } }));
    expect(s.seen[0]!.body).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            { name: 'read_file', parametersJsonSchema: TOOLS[0]!.inputSchema },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } },
    });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({ name: 'read_file', args: { path: 'a.txt' } });
    expect(r.toolCalls![0]!.id).toMatch(/^gc0_[0-9a-f]{12}$/);
    const none = gm(() => json(200, gmText('x')));
    await none.a.complete(ctx(), gmReq({ tools: TOOLS, toolChoice: 'none' }));
    expect(none.s.seen[0]!.body).toMatchObject({
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
  });
  it('two calls in one response are refused (parallel calls are not declared); an undeclared tool is invalid_response', async () => {
    const two = {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'read_file', args: { path: 'a' } } },
              { functionCall: { name: 'read_file', args: { path: 'b' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };
    expect(
      await errOf(gm(() => json(200, two)).a.complete(ctx(), gmReq({ tools: TOOLS }))),
    ).toMatchObject({ code: 'invalid_response' });
    const bad = {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'nope', args: {} } }] },
          finishReason: 'STOP',
        },
      ],
    };
    expect(
      await errOf(gm(() => json(200, bad)).a.complete(ctx(), gmReq({ tools: TOOLS }))),
    ).toMatchObject({ code: 'invalid_response' });
    const s = gm(() => json(200, gmText('x')));
    expect(
      await errOf(s.a.complete(ctx(), gmReq({ tools: TOOLS, maxToolCalls: 2 }))),
    ).toMatchObject({ code: 'unsupported_capability' });
    expect(s.s.seen).toHaveLength(0);
  });
  it('round trip: the call is a model functionCall part, the result a user functionResponse part naming the function', async () => {
    const { s, a } = gm(() => json(200, gmText('the answer')));
    await a.complete(
      ctx(),
      gmReq({
        tools: TOOLS,
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            blocks: [{ type: 'tool_call', id: 'c_1', name: 'read_file', args: { path: 'a.txt' } }],
          },
          {
            role: 'user',
            content: '',
            blocks: [{ type: 'tool_result', callId: 'c_1', content: 'file text' }],
          },
        ],
      }),
    );
    expect(s.seen[0]!.body!.contents).toEqual([
      { role: 'user', parts: [{ text: 'read it' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' }, id: 'c_1' } }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', id: 'c_1', response: { output: 'file text' } } },
        ],
      },
    ]);
    const err = gm(() => json(200, gmText('x')));
    await err.a.complete(
      ctx(),
      gmReq({
        tools: TOOLS,
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: '',
            blocks: [{ type: 'tool_call', id: 'c_1', name: 'read_file', args: {} }],
          },
          {
            role: 'user',
            content: '',
            blocks: [{ type: 'tool_result', callId: 'c_1', content: 'boom', isError: true }],
          },
        ],
      }),
    );
    expect(JSON.stringify(err.s.seen[0]!.body!.contents)).toContain('"response":{"error":"boom"}');
  });
  it('stream: SSE chunks give deltas; usage from the last chunk that has it; no finish reason is a retryable unavailable', async () => {
    const { s, a } = gm(() =>
      sse([
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        {
          candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      ]),
    );
    const chunks = await collect(a.stream(ctx(), gmReq()));
    expect(chunks.filter((c) => 'delta' in c)).toEqual([{ delta: 'Hel' }, { delta: 'lo' }]);
    expect(chunks.at(-1)).toEqual({
      done: true,
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(s.seen[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ID}:streamGenerateContent?alt=sse`,
    );
    const cut = gm(() => sse([{ candidates: [{ content: { parts: [{ text: 'a' }] } }] }]));
    expect(await errOf(collect(cut.a.stream(ctx(), gmReq())))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });
  it('stream: a whole function call in one chunk is delivered as call deltas that assemble', async () => {
    const { a } = gm(() =>
      sse([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'z' } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        },
      ]),
    );
    const r = await assembleStream(a.stream(ctx(), gmReq({ tools: TOOLS })), {
      tools: TOOLS,
      maxCalls: 1,
    });
    expect(r).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [{ name: 'read_file', args: { path: 'z' } }],
    });
  });
  it('model discovery strips the models/ prefix and sanitises; pricing staleness is flagged after the documented change date', async () => {
    const { s, a } = gm(() =>
      json(200, {
        models: [
          { name: `models/${GEMINI_MODEL_ID}`, displayName: 'G' },
          { name: 'models/bad id' },
        ],
      }),
    );
    expect((await a.discoverModels(ctx())).map((m) => m.modelId)).toEqual([GEMINI_MODEL_ID]);
    expect(s.seen[0]!.url).toContain('/v1beta/models?pageSize=100');
    expect(geminiPricingStale(new Date('2026-12-31T23:00:00Z'))).toBe(false);
    expect(geminiPricingStale(new Date('2027-01-01T00:00:00Z'))).toBe(true);
  });
});
