import type { SkipReason } from '@nuzm/domain';
import { SandboxAborted, type ParseSandbox } from './parser-sandbox';
import type { FactsOf, FileKind } from './sandbox-protocol';

/**
 * Runs a list of files through the parser sandbox for a stage (COMPONENTS, DESIGN): one lane per sandbox thread, each file read from the store and sent to a thread, with the
 * stage-level protections shared by every stage:
 *  - cancellation or a lost lease aborts the parses in flight within ~200 ms (threads terminated) and stops the stage,
 *  - a wall-clock budget and a failure breaker: once spent, the remaining files are skipped as `deadline` (reported, never guessed),
 *  - typed per-file outcomes become skip reasons; results of limit hits (`timeout`, `memory`, `crashed`, `deadline`, `invalid`) are NOT cacheable, deterministic ones are.
 * The result order never depends on thread timing.
 */
export interface LaneFile<K extends FileKind> {
  hash: string;
  path: string;
  kind: K;
  objectKey: string;
  bytes: number;
}
export interface LaneResult<K extends FileKind> {
  facts: FactsOf<K>;
  /** True when the facts are a property of the content (safe to cache by hash), false when a limit of this run produced them. */
  cache: boolean;
}
export interface LaneOptions<K extends FileKind> {
  sandbox: ParseSandbox;
  files: LaneFile<K>[];
  read: (objectKey: string) => Promise<Buffer>;
  stopped: () => 'cancelled' | 'lease_lost' | null;
  stop: (why: 'cancelled' | 'lease_lost') => Error;
  budgetMs: number;
  maxFailures: number;
  maxFileBytes: number;
  empty: (file: LaneFile<K>, skipped: SkipReason) => FactsOf<K>;
}
export interface LaneReport<K extends FileKind> {
  results: Map<string, LaneResult<K>>;
  /** Files that hit a limit on this run, by reason. */
  limited: Record<string, number>;
  ms: number;
}

export async function runLanes<K extends FileKind>(o: LaneOptions<K>): Promise<LaneReport<K>> {
  const t0 = Date.now();
  const deadline = t0 + o.budgetMs;
  const limited: Record<string, number> = {};
  const hit = (k: string) => (limited[k] = (limited[k] ?? 0) + 1);
  const results = new Map<string, LaneResult<K>>();
  if (!o.files.length) return { results, limited, ms: 0 };
  let failures = 0;
  let next = 0;
  const abort = new AbortController();
  const watch = setInterval(() => {
    if (o.stopped()) abort.abort();
  }, 200);
  const lane = async (): Promise<void> => {
    for (;;) {
      const s = o.stopped();
      if (s) throw o.stop(s);
      if (abort.signal.aborted) return;
      const f = o.files[next++];
      if (!f) return;
      if (f.bytes > o.maxFileBytes) {
        results.set(f.hash, { facts: o.empty(f, 'too_large'), cache: true });
        continue;
      }
      if (Date.now() >= deadline || failures >= o.maxFailures) {
        hit('deadline');
        results.set(f.hash, { facts: o.empty(f, 'deadline'), cache: false });
        continue;
      }
      const buf = await o.read(f.objectKey);
      const bytes = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
      let out;
      try {
        out = await o.sandbox.parse({ kind: f.kind, path: f.path, bytes }, abort.signal);
      } catch (e) {
        if (e instanceof SandboxAborted) {
          const why = o.stopped();
          if (why) throw o.stop(why);
          return;
        }
        throw e;
      }
      if (out.ok) results.set(f.hash, { facts: out.facts, cache: true });
      else {
        const deterministic = out.reason === 'too_large' || out.reason === 'oversize';
        if (!deterministic) {
          failures++;
          hit(out.reason);
        }
        const skipped: SkipReason =
          out.reason === 'too_large'
            ? 'too_large'
            : out.reason === 'oversize'
              ? 'budget'
              : out.reason === 'invalid'
                ? 'parse_error'
                : out.reason;
        results.set(f.hash, { facts: o.empty(f, skipped), cache: deterministic });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(o.sandbox.size, o.files.length) }, lane)).catch(
      (e) => {
        abort.abort(); // the other lanes stop; their in-flight parses are terminated
        throw e;
      },
    );
  } finally {
    clearInterval(watch);
  }
  const s = o.stopped();
  if (s) throw o.stop(s);
  for (const f of o.files) if (!results.has(f.hash)) throw o.stop('lease_lost'); // cannot happen: every lane finished without an abort
  return { results, limited, ms: Date.now() - t0 };
}

/** The log line every stage writes after its parsing phase. */
export function limitsMessage(
  stage: string,
  limited: Record<string, number>,
  parsed: number,
): { level: 'info' | 'warn'; code: string; message: string } {
  const total = Object.values(limited).reduce((a, b) => a + b, 0);
  return total
    ? {
        level: 'warn',
        code: `${stage}.parser_limits`,
        message: `${total} file(s) hit a parser limit (${Object.entries(limited)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}); they are reported as skipped, nothing was guessed`,
      }
    : {
        level: 'info',
        code: `${stage}.parser`,
        message: `parsed ${parsed} file(s) in the parser sandbox`,
      };
}
