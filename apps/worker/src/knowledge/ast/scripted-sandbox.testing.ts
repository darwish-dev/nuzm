import { SandboxAborted, SandboxUnavailable, type ParseSandbox } from './parser-sandbox';
import type { FactsOf, FileKind, ParseOutcome } from './sandbox-protocol';

/**
 * TEST HELPER (excluded from the build): a sandbox that delegates to a real one but fails chosen files the way the limits would, hangs until aborted, or cannot start, so the
 * stages can be exercised deterministically. Never used by the worker.
 */
export type Script = (
  path: string,
  kind: FileKind,
) => ParseOutcome<unknown> | 'hang' | 'unavailable' | null;
export function scriptedSandbox(getReal: () => ParseSandbox) {
  return class Scripted implements ParseSandbox {
    readonly size = 2;
    readonly calls: string[] = [];
    aborted = false;
    constructor(readonly script: Script) {}
    stats() {
      return { parsed: 0, failed: {}, threadsStarted: 0, threadsRecycled: 0, maxMs: 0 };
    }
    async close() {}
    async parse<K extends FileKind>(
      f: { kind: K; path: string; bytes: ArrayBuffer },
      signal?: AbortSignal,
    ): Promise<ParseOutcome<FactsOf<K>>> {
      this.calls.push(f.path);
      const r = this.script(f.path, f.kind);
      if (r === 'unavailable') throw new SandboxUnavailable('the thread could not start');
      if (r === 'hang')
        return new Promise<ParseOutcome<FactsOf<K>>>((_, reject) => {
          signal?.addEventListener('abort', () => {
            this.aborted = true;
            reject(new SandboxAborted());
          });
        });
      return (r ?? (await getReal().parse(f, signal))) as ParseOutcome<FactsOf<K>>;
    }
  };
}
