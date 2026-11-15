/**
 * Run `tick` repeatedly until `signal` aborts. A failing tick is reported and the loop continues
 * after the interval (a poisoned batch must not kill the worker). Ticks never overlap.
 */
export async function runLoop(
  tick: () => Promise<void>,
  opts: { intervalMs: number; signal: AbortSignal; onError: (e: unknown) => void },
): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await tick();
    } catch (e) {
      opts.onError(e);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.intervalMs);
      opts.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
