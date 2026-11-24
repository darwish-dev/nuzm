import { describe, expect, it } from 'vitest';
import { fitContext, promptBudget } from './context';
import type { ModelMessage } from './types';

const t = (role: ModelMessage['role'], content: string): ModelMessage => ({ role, content });
const calls = (...ids: string[]): ModelMessage => ({
  role: 'assistant',
  content: '',
  blocks: ids.map((id) => ({
    type: 'tool_call' as const,
    id,
    name: 'read_file',
    args: { path: 'a' },
  })),
});
const results = (len: number, ...ids: string[]): ModelMessage => ({
  role: 'user',
  content: '',
  blocks: ids.map((id) => ({ type: 'tool_result' as const, callId: id, content: 'r'.repeat(len) })),
});
const words = (n: number) => 'x'.repeat(n * 4); // ≈ n tokens (+4 framing)
/** a counter that is exactly one token per character: makes the arithmetic of the tests obvious */
const chars = (ms: ModelMessage[]) =>
  ms.reduce(
    (n, m) =>
      n +
      m.content.length +
      (m.blocks ?? []).reduce(
        (k, b) =>
          k + (b.type === 'text' ? b.text.length : b.type === 'tool_call' ? 10 : b.content.length),
        0,
      ),
    0,
  );
const opt = { count: chars, safetyTokens: 0 };

describe('promptBudget', () => {
  it('is window minus output minus safety, never negative', () => {
    expect(promptBudget({ contextTokens: 200_000, maxOutputTokens: 8000 }, 4000, 1000)).toBe(
      195_000,
    );
    expect(promptBudget({ contextTokens: 1000, maxOutputTokens: 8000 }, 4000, 0)).toBe(0);
    expect(promptBudget({ contextTokens: 100_000, maxOutputTokens: 8000 }, 1000)).toBe(
      100_000 - 1000 - 3000,
    );
  });
});

describe('fitContext', () => {
  it('returns the conversation untouched when it fits', () => {
    const ms = [t('system', 'sys'), t('user', 'hi'), t('assistant', 'yo'), t('user', 'again')];
    const r = fitContext(ms, { contextTokens: 1000, maxTokens: 100, ...opt });
    expect(r).toMatchObject({ fits: true, droppedMessages: 0, clippedToolResults: 0 });
    expect(r.messages).toEqual(ms);
  });
  it('drops the oldest middle turns first and keeps the system head, the task and the last turn', () => {
    const ms = [
      t('system', 'S'.repeat(10)),
      t('user', 'TASK'.padEnd(20, '.')),
      t('assistant', 'a'.repeat(100)),
      t('user', 'u'.repeat(100)),
      t('assistant', 'b'.repeat(100)),
      t('user', 'LAST'.padEnd(20, '.')),
    ];
    const r = fitContext(ms, { contextTokens: 190, maxTokens: 1, ...opt }); // budget 189
    expect(r.fits).toBe(true);
    // 350 characters against a budget of 189: the two OLDEST middle turns go, the newer one stays
    expect(r.messages.map((m) => m.content.slice(0, 4))).toEqual(['SSSS', 'TASK', 'bbbb', 'LAST']);
    expect(r.droppedMessages).toBe(2);
    expect(r.messages[0]!.role).toBe('system');
    expect(r.messages[1]!.content.startsWith('TASK')).toBe(true);
    expect(r.messages.at(-1)!.content.startsWith('LAST')).toBe(true);
    expect(r.promptTokens).toBeLessThanOrEqual(r.budgetTokens);
  });
  it('drops a tool call and its results TOGETHER, never one without the other', () => {
    const ms = [
      t('user', 'TASK'),
      calls('c1'),
      results(300, 'c1'),
      calls('c2'),
      results(30, 'c2'),
      t('user', 'LAST'),
    ];
    const r = fitContext(ms, { contextTokens: 120, maxTokens: 1, ...opt }); // budget 119: the 300-char result cannot stay
    expect(r.fits).toBe(true);
    const ids = (k: 'tool_call' | 'tool_result') =>
      r.messages.flatMap((m) =>
        (m.blocks ?? [])
          .filter((b) => b.type === k)
          .map((b) => (b.type === 'tool_call' ? b.id : b.type === 'tool_result' ? b.callId : '')),
      );
    expect(ids('tool_call')).toEqual(ids('tool_result')); // paired
    expect(ids('tool_call')).toEqual(['c2']);
    expect(r.droppedMessages).toBe(2);
  });
  it('keeps the pinned last turn when it is a tool round trip (the assistant message that made the calls stays with the results)', () => {
    const ms = [
      t('user', 'TASK'),
      t('assistant', 'a'.repeat(500)),
      t('user', 'u'.repeat(500)),
      calls('c9'),
      results(20, 'c9'),
    ];
    const r = fitContext(ms, { contextTokens: 100, maxTokens: 1, ...opt });
    expect(r.fits).toBe(true);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.messages[1]!.blocks![0]).toMatchObject({ type: 'tool_call', id: 'c9' });
  });
  it('without a leading user task, a leading assistant turn left by the trimming is dropped too', () => {
    const ms = [
      t('assistant', 'a'.repeat(50)),
      t('user', 'u'.repeat(50)),
      t('assistant', 'b'.repeat(5)),
      t('user', 'LAST'),
    ];
    const r = fitContext(ms, { contextTokens: 70, maxTokens: 1, ...opt });
    expect(r.messages[0]!.role).toBe('user');
  });
  it('reports, and does not cut, a pinned part that alone is too large', () => {
    const ms = [
      t('system', 'S'),
      t('user', 'u'.repeat(500)),
      t('assistant', 'a'.repeat(5)),
      t('user', 'q'.repeat(500)),
    ];
    const r = fitContext(ms, { contextTokens: 300, maxTokens: 1, ...opt });
    expect(r).toMatchObject({ fits: false, reason: 'pinned_part_too_large' });
    expect(r.messages).toHaveLength(3); // system + first user + last user, uncut
    expect(r.messages[1]!.content).toHaveLength(500);
  });
  it('says so when the output alone fills the window', () => {
    const r = fitContext([t('user', 'hi')], { contextTokens: 100, maxTokens: 100, ...opt });
    expect(r).toMatchObject({ fits: false, reason: 'no_room_for_prompt', budgetTokens: 0 });
  });
  it('clips long tool results (start and end kept) and says how many', () => {
    const ms = [t('user', 'TASK'), calls('c1'), results(10_000, 'c1'), t('user', 'LAST')];
    const r = fitContext(ms, {
      contextTokens: 100_000,
      maxTokens: 10,
      ...opt,
      maxToolResultChars: 200,
    });
    expect(r.clippedToolResults).toBe(1);
    const b = r.messages[2]!.blocks![0]!;
    expect(b.type === 'tool_result' && b.content.length).toBeLessThan(300);
    expect(b.type === 'tool_result' && b.content).toContain('characters clipped');
    expect(ms[2]!.blocks![0]).toMatchObject({ content: 'r'.repeat(10_000) }); // the input is never mutated
  });
  it('handles only-system and empty input, uses the contract estimate by default, never mutates the input', () => {
    expect(fitContext([], { contextTokens: 1000, maxTokens: 10, safetyTokens: 0 })).toMatchObject({
      fits: true,
      messages: [],
    });
    expect(
      fitContext([t('system', words(5000))], {
        contextTokens: 1000,
        maxTokens: 10,
        safetyTokens: 0,
      }),
    ).toMatchObject({ fits: false });
    const ms = [t('user', words(10)), t('assistant', words(10)), t('user', words(10))];
    const copy = JSON.stringify(ms);
    const r = fitContext(ms, { contextTokens: 40, maxTokens: 1, safetyTokens: 0 });
    expect(JSON.stringify(ms)).toBe(copy);
    expect(r.fits).toBe(true);
    expect(r.droppedMessages).toBe(1);
  });
  it('rejects invalid sizes', () => {
    expect(() => fitContext([], { contextTokens: 100, maxTokens: 0 })).toThrow(RangeError);
    expect(() => fitContext([], { contextTokens: 1.5, maxTokens: 1 })).toThrow(RangeError);
  });
});
