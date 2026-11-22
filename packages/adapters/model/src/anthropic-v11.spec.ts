import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  KIT_TOOLS,
  ModelAdapterError,
  assembleStream,
  runModelConformance,
  type ClaudeClient,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeStreamEvent,
  type CompleteRequest,
  type ModelAdapter,
  type ToolScenario,
} from './index';

/**
 * Claude adapter, contract 1.1 (S-AG4 preparation). EVERYTHING here is offline: a scripted client stands in for the SDK, and the SDK itself is exercised against a stubbed
 * `fetch` (no socket is opened). This proves the CONTRACT shape and the wire mapping from the documentation; it says nothing about the live service or any model's quality
 * (NOT VERIFIED until an approved live probe).
 */
const KEY = `test-only-${'k5Rv'.repeat(8)}`;
const getApiKey = async () => KEY;

type Script = { content: ClaudeContentBlock[]; stop: string };
const charsOf = (content: ClaudeContentBlock[]) =>
  content.reduce(
    (n, b) =>
      n + (b.type === 'text' ? (b.text ?? '').length : JSON.stringify(b.input ?? {}).length),
    0,
  );
/**
 * What the service would return for these parameters: it honours `tool_choice: none` (no call) and `max_tokens` (the answer is cut and a call is never completed), like a real
 * model; without parameters the script is returned as it is.
 */
const msgOf = (s: Script, params?: Record<string, unknown>): ClaudeMessage => {
  let { content, stop } = s;
  if ((params?.tool_choice as { type?: string } | undefined)?.type === 'none') {
    content = content.filter((b) => b.type === 'text');
    if (content.length === 0) content = [{ type: 'text', text: 'no tool needed' }];
    stop = 'end_turn';
  }
  let out = Math.ceil(charsOf(content) / 4);
  const max = typeof params?.max_tokens === 'number' ? params.max_tokens : Infinity;
  if (out > max) {
    content = content
      .filter((b) => b.type === 'text')
      .map((b) => ({ ...b, text: (b.text ?? '').slice(0, max * 4) }));
    stop = 'max_tokens';
    out = max;
  }
  return {
    content,
    stop_reason: stop,
    usage: { input_tokens: 12, output_tokens: out },
  };
};
/** The streaming events the provider would send for a message (so `complete` and `stream` always tell the same story). */
function eventsOf(content: ClaudeContentBlock[]): ClaudeStreamEvent[] {
  const ev: ClaudeStreamEvent[] = [];
  content.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text' } });
      for (const t of (b.text ?? '').match(/.{1,4}/g) ?? [])
        ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
    } else if (b.type === 'tool_use') {
      ev.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name },
      });
      const raw = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});
      for (const t of raw.match(/.{1,7}/g) ?? [])
        ev.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: t },
        });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  return ev;
}
interface Seen {
  params: Record<string, unknown>;
  signal?: AbortSignal;
}
function scriptedClient(script: () => Script, seen: Seen[] = []): ClaudeClient {
  return {
    messages: {
      create: async (params, opts) => {
        seen.push({ params, ...(opts?.signal ? { signal: opts.signal } : {}) });
        return msgOf(script(), params);
      },
      stream: (params, opts) => {
        seen.push({ params, ...(opts?.signal ? { signal: opts.signal } : {}) });
        const s = msgOf(script(), params);
        const it = (async function* () {
          for (const e of eventsOf(s.content)) {
            if (opts?.signal?.aborted)
              throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
            yield e;
          }
        })();
        return Object.assign(it, { finalMessage: async () => s });
      },
    },
  };
}
const SCENARIOS: Record<ToolScenario, Script> = {
  none: { content: [{ type: 'text', text: 'no tool needed' }], stop: 'end_turn' },
  single: {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } }],
    stop: 'tool_use',
  },
  parallel: {
    content: [
      { type: 'tool_use', id: 'toolu_a', name: 'echo', input: { text: 'a' } },
      { type: 'tool_use', id: 'toolu_b', name: 'lookup', input: { key: 'k' } },
    ],
    stop: 'tool_use',
  },
  malformed: {
    content: [{ type: 'tool_use', id: 'toolu_m', name: 'echo', input: '{"text": "unterminated' }],
    stop: 'tool_use',
  },
  undeclared: {
    content: [{ type: 'tool_use', id: 'toolu_u', name: 'delete_everything', input: {} }],
    stop: 'tool_use',
  },
  long: {
    content: [
      { type: 'text', text: 'x'.repeat(400) },
      { type: 'tool_use', id: 'toolu_l', name: 'echo', input: { text: 'y'.repeat(400) } },
    ],
    stop: 'tool_use',
  },
};
let current: Script = SCENARIOS.none;
const make = (o: Partial<ConstructorParameters<typeof AnthropicModelAdapter>[0]> = {}) =>
  new AnthropicModelAdapter({
    getApiKey,
    contract: '1.1',
    clientFactory: () => scriptedClient(() => current),
    ...o,
  });
const arrange = (_a: ModelAdapter, s: ToolScenario) => {
  current = SCENARIOS[s];
};
const base = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
  model: CLAUDE_MODEL_ID,
  messages: [{ role: 'user', content: 'edit the page' }],
  maxTokens: 500,
  ...extra,
});
const withTools = (extra: Partial<CompleteRequest> = {}) =>
  base({ tools: [...KIT_TOOLS], ...extra });

describe('contract 1.1 is opt-in and declared honestly', () => {
  it('the default adapter is still 1.0 with no tool capability, and asking it for tools is a non-retryable unsupported_capability', async () => {
    const a = new AnthropicModelAdapter({ getApiKey });
    expect(a.contractVersion).toBe('1.0.0');
    expect(a.models()[0]!.capabilities).not.toContain('tool-use');
    await expect(a.complete({ callId: 'c' }, withTools())).rejects.toMatchObject({
      code: 'unsupported_capability',
      retryable: false,
    });
  });
  it('built as 1.1 it declares tool calling for its model, and data terms stay unattested', () => {
    const a = make();
    expect(a.contractVersion).toBe('1.1.0');
    expect(a.models()[0]!.capabilities).toEqual(
      expect.arrayContaining(['tool-use', 'streaming-tool-calls', 'parallel-tool-calls']),
    );
    expect(a.dataTerms).toMatchObject({ attested: false, retainsPrompts: 'unknown' });
  });
  it('passes the whole conformance kit WITH a scenario driver (contract shape only)', async () => {
    const r = await runModelConformance(() => make(), { tools: { arrange } });
    expect(r.filter((c) => !c.ok)).toEqual([]);
    expect(r.filter((c) => c.skipped)).toEqual([]);
    expect(r.length).toBeGreaterThanOrEqual(25);
  });
});

describe('what is sent (the real SDK against a stubbed fetch: no socket)', () => {
  const sent: Record<string, unknown>[] = [];
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const stub = (script: Script) => {
    sent.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body ?? '{}')));
        return reply({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: CLAUDE_MODEL_ID,
          ...msgOf(script),
        });
      }),
    );
  };
  afterEach(() => vi.unstubAllGlobals());
  const real = (o: Record<string, unknown> = {}) =>
    new AnthropicModelAdapter({ getApiKey, contract: '1.1', ...o });

  it('tools, one call per response by default, and the answer comes back as validated tool calls', async () => {
    stub(SCENARIOS.single);
    const r = await real().complete({ callId: 'c' }, withTools({ maxToolCalls: 1 }));
    expect(r).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'toolu_1', name: 'echo', args: { text: 'hi' } }],
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const b = sent[0]!;
    expect((b.tools as { name: string; input_schema: unknown }[]).map((t) => t.name)).toEqual([
      'echo',
      'lookup',
    ]);
    expect((b.tools as { input_schema: { type: string } }[])[0]!.input_schema.type).toBe('object');
    expect(b.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });
  it('parallel calls are allowed only when asked for; none and a named tool map to the documented choices', async () => {
    stub(SCENARIOS.parallel);
    const r = await real().complete({ callId: 'c' }, withTools({ maxToolCalls: 2 }));
    expect(r.toolCalls).toHaveLength(2);
    expect(sent[0]!.tool_choice).toEqual({ type: 'auto' });
    stub(SCENARIOS.none);
    await real().complete({ callId: 'c' }, withTools({ toolChoice: 'none' }));
    expect(sent[0]!.tool_choice).toEqual({ type: 'none' });
    stub(SCENARIOS.single);
    await real().complete(
      { callId: 'c' },
      withTools({ toolChoice: { name: 'echo' }, maxToolCalls: 1 }),
    );
    expect(sent[0]!.tool_choice).toEqual({
      type: 'tool',
      name: 'echo',
      disable_parallel_tool_use: true,
    });
  });
  it('a history with a tool exchange becomes tool_use and tool_result blocks, results first, and a model answer follows', async () => {
    stub(SCENARIOS.none);
    await real().complete(
      { callId: 'c' },
      withTools({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'looking',
            blocks: [
              { type: 'text', text: 'looking' },
              { type: 'tool_call', id: 'toolu_1', name: 'echo', args: { text: 'hi' } },
            ],
          },
          {
            role: 'user',
            content: 'next',
            blocks: [
              { type: 'text', text: 'next' },
              { type: 'tool_result', callId: 'toolu_1', content: 'hi', isError: true },
            ],
          },
        ],
      }),
    );
    const m = sent[0]!.messages as { role: string; content: unknown }[];
    expect(m[1]!.content).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
    ]);
    expect(m[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi', is_error: true },
      { type: 'text', text: 'next' },
    ]);
  });
  it('the forced last turn of the agent loop has no tools: the history is sent as plain text, never as tool blocks', async () => {
    stub(SCENARIOS.none);
    await real().complete(
      { callId: 'c' },
      base({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            blocks: [
              { type: 'tool_call', id: 'toolu_1', name: 'read_file', args: { path: 'a.ts' } },
            ],
          },
          {
            role: 'user',
            content: '',
            blocks: [
              { type: 'tool_result', callId: 'toolu_1', content: '<<fence:tool-result>> data' },
            ],
          },
        ],
      }),
    );
    const b = sent[0]!;
    expect(b.tools).toBeUndefined();
    const text = JSON.stringify(b.messages);
    expect(text).not.toContain('tool_use');
    expect(text).not.toContain('tool_result');
    expect(text).toContain('read_file');
    expect(text).toContain('<<fence:tool-result>> data');
  });
  it('a conversation the API would refuse is refused first (nothing is sent): unanswered call, orphan result, bad id', async () => {
    stub(SCENARIOS.none);
    const call = {
      role: 'assistant' as const,
      content: '',
      blocks: [{ type: 'tool_call' as const, id: 'toolu_1', name: 'echo', args: {} }],
    };
    const result = (id: string) => ({
      role: 'user' as const,
      content: '',
      blocks: [{ type: 'tool_result' as const, callId: id, content: 'x' }],
    });
    const user = { role: 'user' as const, content: 'go' };
    for (const messages of [
      [user, call, { role: 'user' as const, content: 'no result' }],
      [user, call, result('toolu_other')],
      [user, result('toolu_1')],
      [user, { ...call, blocks: [{ ...call.blocks[0]!, id: 'bad id!' }] }, result('bad id!')],
    ])
      await expect(real().complete({ callId: 'c' }, withTools({ messages }))).rejects.toMatchObject(
        {
          code: 'invalid_request',
          retryable: false,
        },
      );
    expect(sent).toHaveLength(0);
  });
});

describe('answers that cannot be trusted are errors, never data to act on', () => {
  const rejects = async (s: Script, code = 'invalid_response') => {
    current = s;
    await expect(make().complete({ callId: 'c' }, withTools())).rejects.toMatchObject({
      code,
      retryable: false,
    });
  };
  it('an undeclared tool, arguments that are not an object, a duplicate id, and too many calls', async () => {
    await rejects(SCENARIOS.undeclared);
    await rejects(SCENARIOS.malformed);
    await rejects({
      content: [
        { type: 'tool_use', id: 'toolu_d', name: 'echo', input: { text: 'a' } },
        { type: 'tool_use', id: 'toolu_d', name: 'echo', input: { text: 'b' } },
      ],
      stop: 'tool_use',
    });
    current = SCENARIOS.parallel;
    await expect(
      make().complete({ callId: 'c' }, withTools({ maxToolCalls: 1 })),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('a call cut off by the token limit, a stop for a call that is not there, and a paused turn', async () => {
    await rejects({ content: SCENARIOS.single.content, stop: 'max_tokens' });
    await rejects({ content: [{ type: 'text', text: 'x' }], stop: 'tool_use' });
    await rejects({ content: [{ type: 'text', text: 'x' }], stop: 'pause_turn' });
  });
  it('a tool the request did not offer is undeclared even if the name exists elsewhere', async () => {
    current = SCENARIOS.single;
    await expect(
      make().complete({ callId: 'c' }, base({ tools: [KIT_TOOLS[1]!] })),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('streaming: tool calls are assembled from the provider events', () => {
  it('text and calls arrive as contract chunks and assemble to the same answer as complete()', async () => {
    current = SCENARIOS.long;
    const a = make();
    const streamed = await assembleStream(a.stream({ callId: 's' }, withTools()), {
      tools: KIT_TOOLS,
    });
    const whole = await a.complete({ callId: 'c' }, withTools());
    expect(streamed.toolCalls).toEqual(whole.toolCalls);
    expect(streamed.text).toBe(whole.text);
    expect(streamed.finishReason).toBe('tool_calls');
    expect(streamed.usage).toEqual(whole.usage);
  });
  it('the SDK itself parses a recorded-shape event stream: input_json_delta fragments become one call', async () => {
    const sse = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    const body =
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: CLAUDE_MODEL_ID,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 30, output_tokens: 1 },
        },
      }) +
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Reading' },
      }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sse('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_s', name: 'echo', input: {} },
      }) +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"te' },
      }) +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'xt": "hi"}' },
      }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 14 },
      }) +
      sse('message_stop', { type: 'message_stop' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    try {
      const a = new AnthropicModelAdapter({ getApiKey, contract: '1.1' });
      const r = await assembleStream(a.stream({ callId: 's' }, withTools()), { tools: KIT_TOOLS });
      expect(r).toMatchObject({
        text: 'Reading',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'toolu_s', name: 'echo', args: { text: 'hi' } }],
        usage: { inputTokens: 30, outputTokens: 14 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('a stream that ends mid-call or carries broken arguments is an invalid_response', async () => {
    current = SCENARIOS.malformed;
    await expect(
      assembleStream(make().stream({ callId: 's' }, withTools()), { tools: KIT_TOOLS }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('cancellation and live-call gate', () => {
  it('an aborted signal sends nothing; an abort in the middle of a stream is "aborted"; stopping to read aborts the request', async () => {
    const seen: Seen[] = [];
    const a = new AnthropicModelAdapter({
      getApiKey,
      contract: '1.1',
      clientFactory: () => scriptedClient(() => SCENARIOS.long, seen),
    });
    const pre = new AbortController();
    pre.abort();
    await expect(
      a.complete({ callId: 'c', signal: pre.signal }, withTools()),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(seen).toHaveLength(0);

    const mid = new AbortController();
    const got: unknown[] = [];
    await expect(
      (async () => {
        for await (const c of a.stream({ callId: 's', signal: mid.signal }, withTools())) {
          got.push(c);
          if (got.length === 2) mid.abort();
        }
      })(),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(seen.at(-1)!.signal!.aborted).toBe(true);

    const it = a.stream({ callId: 's2' }, withTools())[Symbol.asyncIterator]();
    await it.next();
    await it.return?.(undefined);
    expect(seen.at(-1)!.signal!.aborted).toBe(true); // the consumer left: the provider call is not left running
  });
  it('the live gate refuses before the key is read and before anything is built or sent', async () => {
    const keyRead = vi.fn(getApiKey);
    const factory = vi.fn(() => scriptedClient(() => current));
    const a = new AnthropicModelAdapter({
      getApiKey: keyRead,
      contract: '1.1',
      clientFactory: factory,
      liveEnabled: () => false,
    });
    await expect(a.complete({ callId: 'c' }, withTools())).rejects.toMatchObject({
      code: 'unavailable',
      retryable: false,
    });
    await expect(
      (async () => {
        for await (const _ of a.stream({ callId: 's' }, withTools())) void _;
      })(),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false });
    expect(keyRead).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it('errors never carry the key or the upstream message', async () => {
    const a = new AnthropicModelAdapter({
      getApiKey,
      contract: '1.1',
      clientFactory: () => ({
        messages: {
          create: async () => {
            throw Object.assign(new Error(`boom ${KEY} the prompt was secret`), { status: 500 });
          },
          stream: () => {
            throw new Error('unused');
          },
        },
      }),
    });
    const e = (await a.complete({ callId: 'c' }, withTools()).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(ModelAdapterError);
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain('secret');
  });
});
