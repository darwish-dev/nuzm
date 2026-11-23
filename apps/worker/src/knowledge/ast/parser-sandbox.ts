import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SANDBOX_LIMITS,
  isDesignKind,
  type FactsOf,
  type FileKind,
  type ParseOutcome,
  type SandboxLimits,
  type ThreadData,
  type ThreadMessage,
} from './sandbox-protocol';
import type { DesignFileFacts, FileFacts } from '@nuzm/domain';

/**
 * Parser sandbox (S-K2c hardening). A small pool of `worker_threads`, each parsing ONE file at a time under hard limits:
 *  - wall-clock timeout per file (the thread is terminated, not asked to stop — `terminate()` interrupts a synchronous run),
 *  - V8 heap limits per thread (`resourceLimits`; exceeding them kills the thread, never the worker process),
 *  - file size and AST node limits (the file never reaches a thread above the size limit; the analyzer stops at the node budget),
 *  - result size limit, and a structural check of every reply (a thread's answer is data, never trusted blindly),
 *  - an empty environment and no handles: a thread cannot read secrets or reach the database,
 *  - cancellation (an AbortSignal terminates the in-flight parse at once) and `close()` that terminates everything,
 *  - thread recycling after N files, and a replacement thread after any failure (a failed thread is never reused).
 * A file that cannot be parsed within the limits yields a typed failure; the caller decides what that means. A thread that cannot start at all is an infrastructure error.
 */
export class SandboxAborted extends Error {
  constructor() {
    super('the parse was aborted');
    this.name = 'SandboxAborted';
  }
}
export class SandboxClosed extends Error {
  constructor() {
    super('the parser sandbox is closed');
    this.name = 'SandboxClosed';
  }
}
/** The parser could not start (missing entry file, load failure, startup timeout): not a property of any file, so the job fails and is retried. */
export class SandboxUnavailable extends Error {
  constructor(detail: string) {
    super(`the parser sandbox could not start: ${detail}`);
    this.name = 'SandboxUnavailable';
  }
}

export interface SandboxOptions extends Partial<SandboxLimits> {
  /** Threads that may run at the same time (default 2, at most 4 and at most the CPU count). */
  threads?: number;
  /** Test seam: the thread script. Defaults to the compiled parser thread. */
  entry?: string;
  /** Test seam: forwarded to the thread as `workerData.fixture`. */
  fixture?: Record<string, unknown>;
}

export interface SandboxStats {
  parsed: number;
  failed: Record<string, number>;
  threadsStarted: number;
  threadsRecycled: number;
  maxMs: number;
}

export interface ParseSandbox {
  /** Number of files that may be parsed at the same time. */
  readonly size: number;
  parse<K extends FileKind>(
    file: { kind: K; path: string; bytes: ArrayBuffer },
    signal?: AbortSignal,
  ): Promise<ParseOutcome<FactsOf<K>>>;
  stats(): SandboxStats;
  close(): Promise<void>;
}

const here = __dirname;
/** Compiled worker: the `.js` next to this module. From source (tsx, vitest) the `.ts` entry is loaded through tsx. */
function resolveEntry(): { file: string; execArgv: string[] } {
  if (__filename.endsWith('.js')) return { file: join(here, 'parser-thread.js'), execArgv: [] };
  return {
    file: join(here, 'parser-thread.ts'),
    execArgv: ['--require', require.resolve('tsx/cjs')],
  };
}

const isDesignFacts = (x: unknown): x is DesignFileFacts => {
  const f = x as Partial<DesignFileFacts> | null;
  return (
    !!f &&
    typeof f === 'object' &&
    (f.kind === 'css' ||
      f.kind === 'tokens-json' ||
      f.kind === 'theme-config' ||
      f.kind === 'dart-theme') &&
    Array.isArray(f.tokens) &&
    Array.isArray(f.usage) &&
    Array.isArray(f.schemes) &&
    !!f.traits &&
    typeof f.traits === 'object' &&
    typeof f.truncated === 'boolean' &&
    (f.skipped === null || typeof f.skipped === 'string')
  );
};
const isFacts = (x: unknown): x is FileFacts => {
  const f = x as Partial<FileFacts> | null;
  return (
    !!f &&
    typeof f === 'object' &&
    (f.lang === 'ts' || f.lang === 'dart') &&
    Array.isArray(f.imports) &&
    Array.isArray(f.exports) &&
    Array.isArray(f.reexports) &&
    Array.isArray(f.components) &&
    Array.isArray(f.directives) &&
    Array.isArray(f.routeRefs) &&
    typeof f.hasTheme === 'boolean' &&
    typeof f.truncated === 'boolean' &&
    (f.skipped === null || typeof f.skipped === 'string')
  );
};

type SlotState = 'idle' | 'busy' | 'dead';
class Slot {
  /** `busy` from the moment it is handed out (including while it starts), `idle` once released, `dead` after any failure or kill: a dead slot is never reused. */
  state: SlotState = 'busy';
  served = 0;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private fail: ((e: Error) => void) | null = null;
  constructor(
    private readonly boot: () => Worker,
    private readonly startupMs: number,
  ) {}

  /** Starts the thread (once) and resolves when it says it is ready. Rejects with SandboxUnavailable. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let done = false;
      const settle = (e?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (e) {
          this.kill();
          reject(e);
        } else resolve();
      };
      const timer = setTimeout(
        () => settle(new SandboxUnavailable('startup timed out')),
        this.startupMs,
      );
      try {
        const w = this.boot();
        this.worker = w;
        // permanent listeners: an 'error' event nobody listens to would take the whole worker process down, and an idle thread that dies must not be reused
        w.on('error', () => undefined);
        w.once('exit', () => {
          if (this.worker === w) this.worker = null;
          if (this.state !== 'busy') this.state = 'dead';
        });
        this.fail = (e) => settle(e);
        w.on('message', (m: ThreadMessage) => {
          if (m && m.type === 'ready') settle();
        });
        w.once('error', (e) => settle(new SandboxUnavailable(String((e as Error).message ?? e))));
        w.once('exit', () => settle(new SandboxUnavailable('the thread exited while starting')));
      } catch (e) {
        settle(new SandboxUnavailable(String((e as Error).message ?? e)));
      }
    });
    // a start that nobody awaits any more must not become an unhandled rejection
    this.ready.catch(() => undefined);
    return this.ready;
  }

  /** Runs one request on a started thread. Resolves with an outcome, rejects with SandboxAborted. */
  run(
    id: number,
    msg: { kind: FileKind; path: string; bytes: ArrayBuffer },
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ParseOutcome<FileFacts | DesignFileFacts>> {
    const w = this.worker;
    if (!w) return Promise.resolve({ ok: false, reason: 'crashed', ms: 0, detail: 'no thread' });
    const t0 = Date.now();
    return new Promise<ParseOutcome<FileFacts | DesignFileFacts>>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        fn();
      };
      const failWith = (reason: 'timeout' | 'memory' | 'crashed' | 'invalid', detail?: string) =>
        finish(() => {
          this.kill();
          resolve({ ok: false, reason, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
        });
      const onMessage = (m: unknown) => {
        const r = m as ThreadMessage | null;
        if (!r || r.type !== 'result' || r.id !== id) return; // not ours: ignore (a thread only answers the request it has)
        if (r.ok) {
          if (!(isDesignKind(msg.kind) ? isDesignFacts(r.facts) : isFacts(r.facts)))
            return failWith('invalid', 'the reply was not a facts object of the expected kind');
          finish(() => resolve({ ok: true, facts: r.facts, ms: Date.now() - t0 }));
        } else if (r.reason === 'failed') failWith('crashed', 'the analyzer failed on this file');
        else if (r.reason === 'invalid') failWith('invalid', 'the thread refused the request');
        else
          finish(() =>
            resolve({
              ok: false,
              reason: r.reason === 'oversize' ? 'oversize' : 'too_large',
              ms: Date.now() - t0,
            }),
          );
      };
      const onError = (e: Error & { code?: string }) =>
        failWith(
          e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crashed',
          e?.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'the thread ran out of memory'
            : 'the thread threw',
        );
      const onExit = (code: number) => failWith('crashed', `the thread exited (${code})`);
      const onAbort = () =>
        finish(() => {
          this.kill();
          reject(new SandboxAborted());
        });
      const timer = setTimeout(() => failWith('timeout', `over ${timeoutMs} ms`), timeoutMs);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      try {
        w.postMessage({ id, ...msg }, [msg.bytes]);
      } catch {
        failWith('crashed', 'the request could not be sent');
      }
    });
  }

  /** Terminates the thread; idempotent. After this the slot is never used again. */
  kill(): void {
    this.state = 'dead';
    const w = this.worker;
    this.worker = null;
    this.fail?.(new SandboxUnavailable('closed'));
    this.fail = null;
    if (w) void w.terminate().catch(() => undefined);
  }
}

export class ThreadParserSandbox implements ParseSandbox {
  readonly size: number;
  private readonly limits: SandboxLimits;
  private readonly slots = new Set<Slot>();
  private readonly waiters: (() => void)[] = [];
  private closed = false;
  private seq = 0;
  private readonly st: SandboxStats = {
    parsed: 0,
    failed: {},
    threadsStarted: 0,
    threadsRecycled: 0,
    maxMs: 0,
  };

  constructor(private readonly opts: SandboxOptions = {}) {
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...stripUndefined(opts) };
    this.size = Math.max(1, Math.min(opts.threads ?? 2, 4, Math.max(1, availableParallelism())));
  }

  stats(): SandboxStats {
    return { ...this.st, failed: { ...this.st.failed } };
  }

  async parse<K extends FileKind>(
    file: { kind: K; path: string; bytes: ArrayBuffer },
    signal?: AbortSignal,
  ): Promise<ParseOutcome<FactsOf<K>>> {
    if (file.bytes.byteLength > this.limits.maxFileBytes) {
      this.count('too_large');
      return { ok: false, reason: 'too_large', ms: 0 };
    }
    const slot = await this.acquire(signal);
    try {
      await slot.start();
      const out = await slot.run(++this.seq, file, this.limits.timeoutMs, signal);
      if (out.ok) this.st.parsed++;
      else this.count(out.reason);
      this.st.maxMs = Math.max(this.st.maxMs, out.ms);
      if (out.ok && ++slot.served >= this.limits.maxFilesPerThread) {
        this.st.threadsRecycled++;
        slot.kill();
      }
      return out as ParseOutcome<FactsOf<K>>;
    } finally {
      this.release(slot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of this.slots) s.kill();
    this.slots.clear();
    for (const w of this.waiters.splice(0)) w();
  }

  private count(reason: string): void {
    this.st.failed[reason] = (this.st.failed[reason] ?? 0) + 1;
  }

  private async acquire(signal: AbortSignal | undefined): Promise<Slot> {
    for (;;) {
      if (this.closed) throw new SandboxClosed();
      if (signal?.aborted) throw new SandboxAborted();
      for (const s of this.slots) if (s.state === 'dead') this.slots.delete(s);
      for (const s of this.slots) if (s.state === 'idle') return this.take(s);
      if (this.slots.size < this.size) {
        const s = new Slot(() => this.spawn(), this.limits.startupTimeoutMs);
        this.slots.add(s);
        this.st.threadsStarted++;
        return this.take(s);
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new SandboxAborted());
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  private take(s: Slot): Slot {
    s.state = 'busy';
    return s;
  }
  private release(s: Slot): void {
    if (s.state === 'dead') this.slots.delete(s);
    else s.state = 'idle';
    this.waiters.shift()?.();
  }

  private spawn(): Worker {
    const entry = this.opts.entry
      ? { file: this.opts.entry, execArgv: [] as string[] }
      : resolveEntry();
    const data: ThreadData = {
      limits: {
        maxFileBytes: this.limits.maxFileBytes,
        maxNodes: this.limits.maxNodes,
        maxResultBytes: this.limits.maxResultBytes,
      },
      ...(this.opts.fixture ? { fixture: this.opts.fixture } : {}),
    };
    const w = new Worker(entry.file, {
      workerData: data,
      env: {}, // no secrets, no configuration: a copy of an EMPTY environment
      argv: [],
      execArgv: entry.execArgv,
      stdin: false,
      stdout: true, // captured, never forwarded: thread output cannot reach the worker's logs
      stderr: true,
      trackUnmanagedFds: true,
      resourceLimits: {
        maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.limits.maxYoungGenerationSizeMb,
        stackSizeMb: this.limits.stackSizeMb,
        codeRangeSizeMb: 32,
      },
    });
    w.stdout.resume();
    w.stderr.resume();
    return w;
  }
}

function stripUndefined(o: SandboxOptions): Partial<SandboxLimits> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(DEFAULT_SANDBOX_LIMITS) as (keyof SandboxLimits)[]) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out as Partial<SandboxLimits>;
}
