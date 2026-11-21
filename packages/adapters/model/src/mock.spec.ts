import { describe, expect, it } from 'vitest';
import {
  KIT_TOOLS,
  MOCK_SERIAL_TOOL_MODEL_ID,
  MOCK_TOOL_MODEL_ID,
  MOCK_TOOL_MODELS,
  MockModelAdapter,
  ModelAdapterError,
  mockToolArrange,
  recordingHandler,
  replayHandler,
  runModelConformance,
  type FixtureStore,
} from './index';

const DEFAULT_MOCK_MODELS = () => new MockModelAdapter().models();

describe('MockModelAdapter', () => {
  it('passes the conformance suite', async () => {
    const r = await runModelConformance(() => new MockModelAdapter());
    expect(r.filter((c) => !c.ok)).toEqual([]);
    expect(r.length).toBeGreaterThanOrEqual(10);
  });
  it('also conforms when it reports no usage', async () => {
    const r = await runModelConformance(() => new MockModelAdapter({ reportUsage: false }));
    expect(r.filter((c) => !c.ok)).toEqual([]);
  });
  it('injects faults once each and then recovers', async () => {
    const a = new MockModelAdapter();
    a.failNext(new ModelAdapterError('rate_limited', 'slow down'), 2);
    const req = {
      model: 'mock-chat-1',
      messages: [{ role: 'user' as const, content: 'x' }],
      maxTokens: 10,
    };
    await expect(a.complete({ callId: '1' }, req)).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    await expect(a.complete({ callId: '2' }, req)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(a.complete({ callId: '3' }, req)).resolves.toMatchObject({ finishReason: 'stop' });
  });
  it('truncates at maxTokens and says so', async () => {
    const a = new MockModelAdapter({ handler: () => 'x'.repeat(1000) });
    const r = await a.complete(
      { callId: '1' },
      { model: 'mock-chat-1', messages: [], maxTokens: 5 },
    );
    expect(r.finishReason).toBe('length');
    expect(r.usage?.outputTokens).toBe(5);
  });
  it('records and replays, and refuses an unrecorded request', async () => {
    const store: FixtureStore = {};
    const rec = new MockModelAdapter({ handler: recordingHandler(() => 'hello', store) });
    const req = {
      model: 'mock-chat-1',
      messages: [{ role: 'user' as const, content: 'hi' }],
      maxTokens: 10,
    };
    await rec.complete({ callId: '1' }, req);
    const rep = new MockModelAdapter({ handler: replayHandler(JSON.parse(JSON.stringify(store))) });
    expect((await rep.complete({ callId: '2' }, req)).text).toBe('hello');
    await expect(rep.complete({ callId: '3' }, { ...req, messages: [] })).rejects.toThrow(
      /no recorded fixture/,
    );
  });
});

describe('contract 1.1 on the mock (D-46, SCR-K-10 §2)', () => {
  const models = () => [...DEFAULT_MOCK_MODELS(), ...MOCK_TOOL_MODELS];
  it('passes the 1.0 cases AND every tool case with a scenario driver (nothing skipped)', async () => {
    const r = await runModelConformance(() => new MockModelAdapter({ models: models() }), {
      tools: { arrange: mockToolArrange },
    });
    expect(r.filter((c) => !c.ok)).toEqual([]);
    expect(r.filter((c) => c.skipped)).toEqual([]);
    expect(r.length).toBeGreaterThanOrEqual(25);
    expect(r.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'a stream assembles into the same tool calls as complete',
        'cancelling in the middle of a stream ends it with aborted',
      ]),
    );
  });
  it('without a scenario driver the behaviour cases are reported as skipped, never as passed', async () => {
    const r = await runModelConformance(() => new MockModelAdapter({ models: models() }));
    expect(r.filter((c) => !c.ok)).toEqual([]);
    expect(r.some((c) => c.skipped && /scenario driver/.test(c.detail ?? ''))).toBe(true);
  });
  it('the default mock is unchanged for every existing consumer: the same two models, no tool capability, 1.0 requests answered as before', async () => {
    const a = new MockModelAdapter();
    expect(a.models().map((m) => m.modelId)).toEqual(['mock-chat-1', 'mock-long-1']);
    expect(a.models().every((m) => !m.capabilities.includes('tool-use'))).toBe(true);
    expect(a.contractVersion).toBe('1.1.0');
    const r = await a.complete(
      { callId: '1' },
      {
        model: 'mock-chat-1',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 20,
        task: 'chat',
      },
    );
    expect(r).toMatchObject({ text: 'mock reply (chat)', finishReason: 'stop' });
    expect(r.toolCalls).toBeUndefined();
    await expect(
      a.complete(
        { callId: '2' },
        {
          model: 'mock-chat-1',
          messages: [],
          maxTokens: 5,
          tools: [{ name: 'echo', description: 'x', inputSchema: { type: 'object' } }],
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_capability', retryable: false });
  });
  it('scripts tool calls with deterministic ids and usage that counts them', async () => {
    const a = new MockModelAdapter({ models: models() });
    mockToolArrange(a, 'single');
    const req = {
      model: MOCK_TOOL_MODEL_ID,
      messages: [{ role: 'user' as const, content: 'go' }],
      maxTokens: 200,
      tools: [...KIT_TOOLS],
    };
    const r1 = await a.complete({ callId: 'c1' }, req);
    const r2 = await a.complete({ callId: 'c1' }, req);
    expect(r1.toolCalls).toEqual(r2.toolCalls);
    expect(r1.toolCalls![0]).toMatchObject({ id: 'call_c1_0', name: 'echo', args: { text: 'hi' } });
    expect(r1.usage!.outputTokens).toBeGreaterThan(0);
    expect(r1.usage!.inputTokens).toBeGreaterThan(a.tokenCount(MOCK_TOOL_MODEL_ID, req.messages)); // the tool specs count as input
  });
  it('a serial model returns one call even when the script asks for two', async () => {
    const a = new MockModelAdapter({ models: models() });
    mockToolArrange(a, 'parallel');
    const r = await a.complete(
      { callId: 'c' },
      { model: MOCK_SERIAL_TOOL_MODEL_ID, messages: [], maxTokens: 200, tools: [...KIT_TOOLS] },
    );
    expect(r.toolCalls).toHaveLength(1);
    const p = await a.complete(
      { callId: 'c' },
      { model: MOCK_TOOL_MODEL_ID, messages: [], maxTokens: 200, tools: [...KIT_TOOLS] },
    );
    expect(p.toolCalls).toHaveLength(2);
  });
  it('a stream can be cancelled in the middle and then reports aborted, without a done chunk', async () => {
    const a = new MockModelAdapter({ models: models(), chunkDelayMs: 1 });
    mockToolArrange(a, 'long');
    const ac = new AbortController();
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const c of a.stream(
          { callId: 's', signal: ac.signal },
          { model: MOCK_TOOL_MODEL_ID, messages: [], maxTokens: 500, tools: [...KIT_TOOLS] },
        )) {
          seen.push(c);
          if (seen.length === 2) ac.abort();
        }
      })(),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(seen.some((c) => 'done' in (c as object))).toBe(false);
  });
  it('a response cut at the ceiling carries no tool call and says length', async () => {
    const a = new MockModelAdapter({ models: models() });
    mockToolArrange(a, 'long');
    const r = await a.complete(
      { callId: 'c' },
      { model: MOCK_TOOL_MODEL_ID, messages: [], maxTokens: 3, tools: [...KIT_TOOLS] },
    );
    expect(r).toMatchObject({ finishReason: 'length' });
    expect(r.toolCalls).toBeUndefined();
    expect(r.usage!.outputTokens).toBe(3);
  });
  it('malformed and undeclared answers are rejected like a real provider would be', async () => {
    const a = new MockModelAdapter({ models: models() });
    const req = { model: MOCK_TOOL_MODEL_ID, messages: [], maxTokens: 200, tools: [...KIT_TOOLS] };
    mockToolArrange(a, 'malformed');
    await expect(a.complete({ callId: '1' }, req)).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
    mockToolArrange(a, 'undeclared');
    await expect(a.complete({ callId: '2' }, req)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
