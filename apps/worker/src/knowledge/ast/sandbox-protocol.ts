import type { DesignFileFacts, FileFacts } from '@nuzm/domain';

/**
 * Wire protocol and limits of the parser sandbox (S-K2c hardening, ADR-065 addendum D).
 *
 * The sandbox is a pool of `worker_threads` that parse ONE file at a time. A thread gets no database handle, no credentials and an empty environment; it receives the bytes of a
 * file and returns plain facts. Nothing from an uploaded package is ever executed — the isolation protects the ingestion worker from a parser that hangs, exhausts memory or
 * crashes on hostile input; it is a fault and resource boundary, not a privilege boundary.
 */
export interface SandboxLimits {
  /** Wall-clock limit for parsing ONE file, measured from dispatch. Node 22 has no per-thread CPU accounting, and a parse is a single synchronous run, so wall time is the strict proxy. */
  timeoutMs: number;
  /** V8 old-generation heap of one thread (MiB). Exceeding it terminates the thread, not the worker. */
  maxOldGenerationSizeMb: number;
  /** V8 young-generation heap of one thread (MiB). */
  maxYoungGenerationSizeMb: number;
  /** Stack of one thread (MiB). The analyzers are iterative, so this stays small. */
  stackSizeMb: number;
  /** A file larger than this is never sent to a thread. */
  maxFileBytes: number;
  /** AST nodes visited per file (the analyzer's budget). */
  maxNodes: number;
  /** A result whose JSON exceeds this is refused. */
  maxResultBytes: number;
  /** A thread is replaced after this many files, bounding heap growth and fragmentation. */
  maxFilesPerThread: number;
  /** Time a new thread may take to load the parser and say it is ready. */
  startupTimeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  maxOldGenerationSizeMb: 384,
  maxYoungGenerationSizeMb: 48,
  stackSizeMb: 4,
  maxFileBytes: 512 * 1024,
  maxNodes: 400_000,
  maxResultBytes: 190_000,
  maxFilesPerThread: 300,
  startupTimeoutMs: 20_000,
};

/** What a thread parses: component facts (`ts`, `dart`, S-K2c) or design facts (S-K4). */
export type FileKind = 'ts' | 'dart' | 'css' | 'tokens-json' | 'theme-config' | 'dart-theme';
export type FactsOf<K extends FileKind> = K extends 'ts' | 'dart' ? FileFacts : DesignFileFacts;
export const isDesignKind = (k: FileKind): boolean => k !== 'ts' && k !== 'dart';

export interface ParseRequest {
  /** Correlates the reply with the request; chosen by the sandbox. */
  id: number;
  kind: FileKind;
  /** Only used by the TypeScript analyzer to pick the script kind (tsx/jsx/…); never opened. */
  path: string;
  /** The file bytes, transferred (not copied) to the thread. */
  bytes: ArrayBuffer;
}

export type ThreadMessage =
  | { type: 'ready' }
  | {
      type: 'result';
      id: number;
      ok: true;
      facts: FileFacts | DesignFileFacts;
      resultBytes: number;
    }
  | {
      type: 'result';
      id: number;
      ok: false;
      reason: 'too_large' | 'oversize' | 'invalid' | 'failed';
    };

/** Why a file produced no facts of its own. `cancelled` never appears here: cancellation rejects the call. */
export type FailureReason = 'timeout' | 'memory' | 'crashed' | 'too_large' | 'oversize' | 'invalid';

export type ParseOutcome<F = FileFacts> =
  | { ok: true; facts: F; ms: number }
  | { ok: false; reason: FailureReason; ms: number; detail?: string };

/** What the thread is started with (structured-clone data only). */
export interface ThreadData {
  limits: Pick<SandboxLimits, 'maxFileBytes' | 'maxNodes' | 'maxResultBytes'>;
  /** Free-form data for test fixtures; the real entry ignores it. */
  fixture?: Record<string, unknown>;
}
