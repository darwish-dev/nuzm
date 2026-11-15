import { describe, expect, it } from 'vitest';
import { runLoop } from './loop';

describe('runLoop', () => {
  it('keeps going after a failing tick and stops promptly on abort', async () => {
    const ac = new AbortController();
    const errors: unknown[] = [];
    let n = 0;
    const done = runLoop(
      async () => {
        n++;
        if (n === 1) throw new Error('poisoned batch');
        if (n === 3) ac.abort();
      },
      { intervalMs: 5, signal: ac.signal, onError: (e) => errors.push(e) },
    );
    await done;
    expect(n).toBe(3);
    expect(errors).toHaveLength(1);
  });
  it('does not start when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    await runLoop(async () => void n++, {
      intervalMs: 1,
      signal: ac.signal,
      onError: () => undefined,
    });
    expect(n).toBe(0);
  });
});
