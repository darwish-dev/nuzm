import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { analyzeDart, type FileFacts } from '@nuzm/domain';
import { analyzeTsFile } from './ts-file';
import type { ParseRequest, ThreadData, ThreadMessage } from './sandbox-protocol';

/**
 * Entry point of one parser thread (S-K2c sandbox). Receives `ParseRequest`s one at a time, parses the bytes with the parse-only analyzers and replies with plain facts.
 * It opens no file, no socket and no database, reads no environment (the sandbox starts it with an empty one) and executes nothing from the package: the analyzers only read text.
 */
type Limits = ThreadData['limits'];

/** Pure request handler (also used by tests without a thread). Never throws for hostile input: every failure is a typed reply. */
export function handle(req: unknown, limits: Limits): ThreadMessage {
  const r = req as Partial<ParseRequest> | null;
  const id = typeof r?.id === 'number' ? r.id : -1;
  if (
    !r ||
    (r.kind !== 'ts' && r.kind !== 'dart') ||
    typeof r.path !== 'string' ||
    r.path.length > 600 ||
    !(r.bytes instanceof ArrayBuffer)
  )
    return { type: 'result', id, ok: false, reason: 'invalid' };
  if (r.bytes.byteLength > limits.maxFileBytes)
    return { type: 'result', id, ok: false, reason: 'too_large' };
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(r.bytes);
    const facts: FileFacts =
      r.kind === 'dart'
        ? analyzeDart(text)
        : analyzeTsFile(text, r.path, { maxNodes: limits.maxNodes });
    const resultBytes = JSON.stringify(facts).length;
    if (resultBytes > limits.maxResultBytes)
      return { type: 'result', id, ok: false, reason: 'oversize' };
    return { type: 'result', id, ok: true, facts, resultBytes };
  } catch {
    return { type: 'result', id, ok: false, reason: 'failed' };
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const data = workerData as ThreadData;
  port.on('message', (req: unknown) => port.postMessage(handle(req, data.limits)));
  port.postMessage({ type: 'ready' } satisfies ThreadMessage);
}
