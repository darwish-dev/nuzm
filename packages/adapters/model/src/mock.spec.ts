import { describe, expect, it } from 'vitest';
import {
  MockModelAdapter,
  ModelAdapterError,
  recordingHandler,
  replayHandler,
  runModelConformance,
  type FixtureStore,
} from './index';

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
