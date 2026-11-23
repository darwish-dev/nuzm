import { describe, expect, it } from 'vitest';
import {
  MODEL_CONTRACT_VERSION,
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  StreamAssembler,
  TOOL_LIMITS,
  allowedToolCalls,
  assembleStream,
  assertToolCalls,
  assertToolRequest,
  contractAtLeast,
  effectiveCapabilities,
  estimateTokens,
  normalizeModelError,
  parseToolArgs,
  toolSpecProblems,
  type ModelInfo,
  type StreamChunk,
  type ToolSpec,
} from './index';

const echo: ToolSpec = {
  name: 'echo',
  description: 'Echo.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};
const lookup: ToolSpec = {
  name: 'lookup',
  description: 'Look up.',
  inputSchema: { type: 'object' },
};
const tools = [echo, lookup];
const model = (caps: ModelInfo['capabilities']): ModelInfo => ({
  modelId: 'm',
  capabilities: caps,
  contextTokens: 1000,
  maxOutputTokens: 500,
  latencyClass: 'low',
});
const v11 = { contractVersion: MODEL_CONTRACT_VERSION_1_1 };
const v10 = { contractVersion: MODEL_CONTRACT_VERSION };
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as ModelAdapterError).code;
  }
  return null;
};

describe('contract negotiation', () => {
  it('compares versions and fails closed on anything malformed', () => {
    expect(contractAtLeast('1.1.0', '1.1.0')).toBe(true);
    expect(contractAtLeast('1.2.0', '1.1.0')).toBe(true);
    expect(contractAtLeast('2.0.0', '1.9.9')).toBe(true);
    expect(contractAtLeast('1.0.0', '1.1.0')).toBe(false);
    expect(contractAtLeast('1.1', '1.1.0')).toBe(false);
    expect(contractAtLeast('', '1.1.0')).toBe(false);
    expect(contractAtLeast('1.1.0-beta', '1.1.0')).toBe(false);
  });
  it('a 1.0 adapter never gets the 1.1 capabilities, a 1.1 adapter only coherent ones', () => {
    const all = ['chat', 'tool-use', 'streaming-tool-calls', 'parallel-tool-calls'] as const;
    expect(effectiveCapabilities('1.0.0', all)).toEqual(['chat']);
    expect(effectiveCapabilities('1.1.0', all)).toEqual([...all]);
    expect(effectiveCapabilities('1.1.0', ['chat', 'parallel-tool-calls'])).toEqual(['chat']); // parallel without tool-use is not a capability
    expect(effectiveCapabilities('garbage', ['chat', 'tool-use'])).toEqual(['chat']);
  });
  it('token estimates count blocks, tool-call arguments and tool results', () => {
    const plain = estimateTokens([{ role: 'user', content: 'x'.repeat(40) }]);
    const blocks = estimateTokens([
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_call', id: '1', name: 'echo', args: { text: 'x'.repeat(40) } }],
      },
      {
        role: 'user',
        content: '',
        blocks: [{ type: 'tool_result', callId: '1', content: 'y'.repeat(40) }],
      },
    ]);
    expect(blocks).toBeGreaterThan(plain);
    expect(estimateTokens([{ role: 'user', content: 'abcd' }])).toBe(5); // unchanged for a 1.0 message
  });
});

describe('tool specs and requests', () => {
  it('accepts well-formed specs and reports every kind of problem', () => {
    expect(toolSpecProblems(tools)).toEqual([]);
    expect(toolSpecProblems(undefined)).toEqual([]);
    expect(toolSpecProblems([]).join()).toMatch(/not be empty/);
    expect(toolSpecProblems([{ ...echo, name: 'Bad-Name' }]).join()).toMatch(/name must match/);
    expect(toolSpecProblems([echo, echo]).join()).toMatch(/duplicate/);
    expect(toolSpecProblems([{ ...echo, description: '' }]).join()).toMatch(/description/);
    expect(toolSpecProblems([{ ...echo, inputSchema: { type: 'string' } }]).join()).toMatch(
      /type must be "object"/,
    );
    expect(toolSpecProblems([{ ...echo, inputSchema: [] as never }]).join()).toMatch(
      /must be an object/,
    );
    expect(
      toolSpecProblems([
        { ...echo, inputSchema: { type: 'object', pad: 'x'.repeat(TOOL_LIMITS.schemaMaxBytes) } },
      ]).join(),
    ).toMatch(/larger than/);
    expect(
      toolSpecProblems(
        Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => ({ ...echo, name: `t${i}` })),
      ).join(),
    ).toMatch(/at most/);
  });
  it('a request without tool fields passes for every adapter, including 1.0 ones and unknown models', () => {
    expect(() => assertToolRequest(v10, model(['chat']), {})).not.toThrow();
    expect(() => assertToolRequest(v11, undefined, {})).not.toThrow();
  });
  it('tool fields need contract 1.1 AND the tool-use capability, both non-retryable', () => {
    expect(code(() => assertToolRequest(v10, model(['chat', 'tool-use']), { tools }))).toBe(
      'unsupported_capability',
    );
    expect(code(() => assertToolRequest(v11, model(['chat']), { tools }))).toBe(
      'unsupported_capability',
    );
    expect(code(() => assertToolRequest(v11, undefined, { tools }))).toBe('invalid_request');
    expect(() => assertToolRequest(v11, model(['tool-use']), { tools })).not.toThrow();
    try {
      assertToolRequest(v11, model(['chat']), { tools });
    } catch (e) {
      expect((e as ModelAdapterError).retryable).toBe(false);
    }
  });
  it('checks the choice, the limit and parallel capability', () => {
    const m = model(['tool-use']);
    expect(code(() => assertToolRequest(v11, m, { tools, toolChoice: { name: 'nope' } }))).toBe(
      'invalid_request',
    );
    expect(() => assertToolRequest(v11, m, { tools, toolChoice: { name: 'echo' } })).not.toThrow();
    expect(() => assertToolRequest(v11, m, { tools, toolChoice: 'none' })).not.toThrow();
    expect(code(() => assertToolRequest(v11, m, { toolChoice: 'auto' }))).toBe('invalid_request'); // a choice needs tools
    expect(code(() => assertToolRequest(v11, m, { tools, maxToolCalls: 0 }))).toBe(
      'invalid_request',
    );
    expect(code(() => assertToolRequest(v11, m, { tools, maxToolCalls: 2 }))).toBe(
      'unsupported_capability',
    ); // not parallel
    expect(() =>
      assertToolRequest(v11, model(['tool-use', 'parallel-tool-calls']), {
        tools,
        maxToolCalls: 2,
      }),
    ).not.toThrow();
    expect(
      code(() =>
        assertToolRequest(v11, model(['tool-use', 'parallel-tool-calls']), {
          tools,
          maxToolCalls: TOOL_LIMITS.maxToolCallsPerResponse + 1,
        }),
      ),
    ).toBe('invalid_request');
  });
  it('how many calls a response may carry', () => {
    expect(allowedToolCalls(model(['tool-use']), {})).toBe(1);
    expect(allowedToolCalls(model(['tool-use', 'parallel-tool-calls']), {})).toBe(
      TOOL_LIMITS.maxToolCallsPerResponse,
    );
    expect(allowedToolCalls(model(['tool-use', 'parallel-tool-calls']), { maxToolCalls: 3 })).toBe(
      3,
    );
    expect(allowedToolCalls(model(['tool-use']), { maxToolCalls: 5 })).toBe(1);
  });
});

describe('tool arguments and calls', () => {
  it('arguments are a JSON object of bounded size; anything else is an invalid_response', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs('')).toEqual({});
    expect(code(() => parseToolArgs('{"a":'))).toBe('invalid_response');
    expect(code(() => parseToolArgs('[1]'))).toBe('invalid_response');
    expect(code(() => parseToolArgs('"x"'))).toBe('invalid_response');
    expect(code(() => parseToolArgs('null'))).toBe('invalid_response');
    expect(
      code(() => parseToolArgs(JSON.stringify({ a: 'x'.repeat(TOOL_LIMITS.argsMaxBytes) }))),
    ).toBe('invalid_response');
  });
  it('calls must be declared, unique, bounded and carry object arguments', () => {
    const ok = [
      { id: 'a', name: 'echo', args: {} },
      { id: 'b', name: 'lookup', args: {} },
    ];
    expect(() => assertToolCalls(ok, tools, 2)).not.toThrow();
    expect(code(() => assertToolCalls(ok, tools, 1))).toBe('invalid_response');
    expect(code(() => assertToolCalls([{ id: 'a', name: 'nope', args: {} }], tools, 2))).toBe(
      'invalid_response',
    );
    expect(code(() => assertToolCalls([ok[0]!, { ...ok[1]!, id: 'a' }], tools, 2))).toBe(
      'invalid_response',
    );
    expect(code(() => assertToolCalls([{ id: '', name: 'echo', args: {} }], tools, 2))).toBe(
      'invalid_response',
    );
    expect(code(() => assertToolCalls([{ id: 'a', name: 'echo', args: [] }], tools, 2))).toBe(
      'invalid_response',
    );
    expect(code(() => assertToolCalls([{ id: 'a', name: 'echo', args: 'x' }], undefined, 2))).toBe(
      'invalid_response',
    ); // no tools declared: nothing may be called
  });
});

describe('stream assembly', () => {
  const chunks = (...c: StreamChunk[]): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      for (const x of c) yield x;
    },
  });
  const done = (finishReason: 'stop' | 'tool_calls' | 'length' = 'tool_calls'): StreamChunk => ({
    done: true,
    finishReason,
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  it('assembles text and a tool call split anywhere into one response', async () => {
    const r = await assembleStream(
      chunks(
        { delta: 'thinking' },
        { toolCallDelta: { index: 0, id: 'c1', name: 'echo', argsDelta: '{"te' } },
        { toolCallDelta: { index: 0, argsDelta: 'xt":"h' } },
        { toolCallDelta: { index: 0, argsDelta: 'i"}' } },
        { toolCallDone: { index: 0 } },
        done(),
      ),
      { tools },
    );
    expect(r).toEqual({
      text: 'thinking',
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 2 },
      toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'hi' } }],
    });
  });
  it('assembles parallel calls whose pieces interleave, in index order', async () => {
    const r = await assembleStream(
      chunks(
        { toolCallDelta: { index: 0, id: 'a', name: 'echo', argsDelta: '{"text"' } },
        { toolCallDelta: { index: 1, id: 'b', name: 'lookup', argsDelta: '{' } },
        { toolCallDelta: { index: 0, argsDelta: ':"x"}' } },
        { toolCallDelta: { index: 1, argsDelta: '}' } },
        { toolCallDone: { index: 1 } },
        { toolCallDone: { index: 0 } },
        done(),
      ),
      { tools },
    );
    expect(r.toolCalls?.map((c) => c.id)).toEqual(['a', 'b']);
  });
  it('a plain text stream and a call without arguments are fine', async () => {
    expect((await assembleStream(chunks({ delta: 'a' }, { delta: 'b' }, done('stop')))).text).toBe(
      'ab',
    );
    const r = await assembleStream(
      chunks(
        { toolCallDelta: { index: 0, id: 'x', name: 'lookup' } },
        { toolCallDone: { index: 0 } },
        done(),
      ),
      { tools },
    );
    expect(r.toolCalls).toEqual([{ id: 'x', name: 'lookup', args: {} }]);
  });
  it('rejects every malformed stream with invalid_response', async () => {
    const bad = async (
      c: StreamChunk[],
      opts: { tools?: ToolSpec[]; maxCalls?: number } = { tools },
    ) => {
      try {
        await assembleStream(chunks(...c), opts);
        return null;
      } catch (e) {
        return (e as ModelAdapterError).code;
      }
    };
    const start: StreamChunk = {
      toolCallDelta: { index: 0, id: 'a', name: 'echo', argsDelta: '{}' },
    };
    expect(await bad([{ delta: 'x' }])).toBe('invalid_response'); // no done
    expect(await bad([done('stop'), { delta: 'x' }])).toBe('invalid_response'); // data after done
    expect(await bad([start, done()])).toBe('invalid_response'); // unfinished call
    expect(await bad([{ toolCallDone: { index: 0 } }, done()])).toBe('invalid_response'); // finished before started
    expect(
      await bad([start, { toolCallDone: { index: 0 } }, { toolCallDone: { index: 0 } }, done()]),
    ).toBe('invalid_response');
    expect(await bad([{ toolCallDelta: { index: 1, id: 'a', name: 'echo' } }, done()])).toBe(
      'invalid_response',
    ); // not contiguous
    expect(await bad([{ toolCallDelta: { index: 0, argsDelta: '{}' } }, done()])).toBe(
      'invalid_response',
    ); // no id or name
    expect(
      await bad([
        start,
        { toolCallDelta: { index: 0, name: 'lookup' } },
        { toolCallDone: { index: 0 } },
        done(),
      ]),
    ).toBe('invalid_response'); // renamed
    expect(
      await bad([
        start,
        { toolCallDone: { index: 0 } },
        { toolCallDelta: { index: 0, argsDelta: 'x' } },
        done(),
      ]),
    ).toBe('invalid_response'); // piece after finish
    expect(
      await bad([
        { toolCallDelta: { index: 0, id: 'a', name: 'echo', argsDelta: '{"x":' } },
        { toolCallDone: { index: 0 } },
        done(),
      ]),
    ).toBe('invalid_response'); // malformed JSON
    expect(
      await bad([
        { toolCallDelta: { index: 0, id: 'a', name: 'nope', argsDelta: '{}' } },
        { toolCallDone: { index: 0 } },
        done(),
      ]),
    ).toBe('invalid_response'); // undeclared
    expect(await bad([start, { toolCallDone: { index: 0 } }, done('stop')])).toBe(
      'invalid_response',
    ); // calls with finishReason stop
    expect(await bad([done('tool_calls')])).toBe('invalid_response'); // tool_calls without a call
    expect(
      await bad(
        [
          start,
          { toolCallDone: { index: 0 } },
          { toolCallDelta: { index: 1, id: 'b', name: 'echo', argsDelta: '{}' } },
          { toolCallDone: { index: 1 } },
          done(),
        ],
        { tools, maxCalls: 1 },
      ),
    ).toBe('invalid_response'); // over the limit
    expect(await bad([{ toolCallDelta: { index: -1, id: 'a', name: 'echo' } }, done()])).toBe(
      'invalid_response',
    );
  });
  it('is usable chunk by chunk, and reports chunks to a listener', async () => {
    const seen: StreamChunk[] = [];
    await assembleStream(chunks({ delta: 'a' }, done('stop')), { onChunk: (c) => seen.push(c) });
    expect(seen).toHaveLength(2);
    const a = new StreamAssembler();
    expect(() => a.result()).toThrow(/without a done chunk/);
  });
});

describe('error normalisation', () => {
  it('maps what providers and stacks throw onto the contract codes and retry rules', () => {
    const n = (e: unknown) => normalizeModelError(e);
    expect(n({ name: 'AbortError' })).toMatchObject({ code: 'aborted', retryable: false });
    expect(n({ status: 429 })).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(n({ status: 408 })).toMatchObject({ code: 'timeout', retryable: true });
    expect(n({ code: 'ETIMEDOUT' })).toMatchObject({ code: 'timeout' });
    for (const status of [400, 404, 413, 422])
      expect(n({ status })).toMatchObject({ code: 'invalid_request', retryable: false });
    for (const status of [500, 502, 503, 529])
      expect(n({ status })).toMatchObject({ code: 'unavailable', retryable: true });
    expect(n({ status: 401 })).toMatchObject({ code: 'unavailable' });
    expect(n({ code: 'ECONNRESET' })).toMatchObject({ code: 'unavailable' });
    expect(n({ type: 'content_filter' })).toMatchObject({
      code: 'content_filtered',
      retryable: false,
    });
    expect(n(new Error('weird'))).toMatchObject({ code: 'unavailable' });
    expect(n(undefined)).toMatchObject({ code: 'unavailable' });
  });
  it('never carries the provider message (it may echo a prompt or a key)', () => {
    const e = normalizeModelError({ status: 500, message: 'sk-live-SECRET echoed prompt' });
    expect(e.message).not.toMatch(/SECRET|echoed/);
  });
  it('passes a contract error through untouched', () => {
    const own = new ModelAdapterError('rate_limited', 'x');
    expect(normalizeModelError(own)).toBe(own);
  });
});
