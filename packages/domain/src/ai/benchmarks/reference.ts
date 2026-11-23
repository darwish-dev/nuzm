import type { RequestedCall } from '../tools';
import type { GoldenTask, Recording } from './types';

const argsFor = (tool: string, task: GoldenTask): unknown => {
  const first = task.fixture[0]?.path ?? 'package.json';
  switch (tool) {
    case 'read_file':
      return { path: task.solution.find((s) => s.content !== null)?.path ?? first };
    case 'search_code':
      return { query: 'export' };
    case 'list_files':
      return {};
    default:
      return {};
  }
};

/**
 * The REFERENCE recording of a task: what an ideal run looks like (exactly the required read-only calls, then the reference solution). Produced by this repository, not by a
 * model: `origin: 'REFERENCE'`. It is the offline baseline and the proof that the replay, scoring and thresholds work; it says nothing about any real model.
 */
export function referenceRecording(task: GoldenTask): Recording {
  const calls: RequestedCall[] = task.tools.mustCall.map((name, i) => ({
    id: `ref-${task.id}-${i}`,
    name,
    args: argsFor(name, task),
  }));
  return {
    taskId: task.id,
    adapterId: 'reference-oracle',
    model: 'reference',
    contractVersion: '1.1.0',
    origin: 'REFERENCE',
    turns: [
      ...(calls.length > 0
        ? [{ toolCalls: calls, tokensIn: 900, tokensOut: 120, latencyMs: 1_500 }]
        : []),
      { toolCalls: [], tokensIn: 1_400, tokensOut: 600, latencyMs: 4_000 },
    ],
    patch: task.solution,
    finishedWith: 'proposal',
  };
}
