import { sha256Hex } from './canonical';
import { referenceRecording } from './reference';
import type { GoldenTask, PatchOp, Recording } from './types';

/**
 * Scripted MOCK models for exercising the benchmark pipeline (comparison, dashboards, gates). They are deterministic functions of the task id and a profile; every recording is
 * labelled `origin: 'MOCK'`, so a report built from them says so and the rollout gate refuses it. They are NOT models and say nothing about any provider.
 */
export type MockProfile = 'ideal' | 'sloppy-tools' | 'verbose' | 'slow' | 'half-done' | 'leaky' | 'insecure';
export const MOCK_PROFILES: readonly MockProfile[] = ['ideal', 'sloppy-tools', 'verbose', 'slow', 'half-done', 'leaky', 'insecure'];
/** 0-99, stable per (task, salt) */
const bucket = (taskId: string, salt: string) => Number.parseInt(sha256Hex(`${salt}:${taskId}`).slice(0, 8), 16) % 100;

export function mockRecording(task: GoldenTask, profile: MockProfile, salt = ''): Recording {
  const ref = referenceRecording(task);
  const b = bucket(task.id, salt + profile);
  const rec: Recording = { ...ref, adapterId: 'mock-model', model: profile, origin: 'MOCK' };
  switch (profile) {
    case 'ideal':
      return rec;
    case 'sloppy-tools':
      if (b % 2 === 0) rec.turns = rec.turns.map((t, i) => (i === 0 ? { ...t, toolCalls: [...t.toolCalls, { id: `x-${task.id}`, name: 'run_shell', args: { cmd: 'ls' } }] } : t));
      return rec;
    case 'verbose':
      rec.turns = rec.turns.map((t) => ({ ...t, tokensIn: t.tokensIn * 6, tokensOut: t.tokensOut * 6 }));
      return rec;
    case 'slow':
      rec.turns = rec.turns.map((t) => ({ ...t, latencyMs: 120_000 }));
      return rec;
    case 'half-done':
      if (b < 40) rec.patch = task.solution.length > 1 ? task.solution.slice(0, -1) : [];
      return rec;
    case 'leaky':
      if (b < 13) rec.patch = [...task.solution, { path: 'notes.txt', content: `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n` }];
      return rec;
    case 'insecure':
      rec.patch = task.solution.map((op): PatchOp => (op.content !== null && /\.(ts|tsx|js)$/.test(op.path) ? { path: op.path, content: `${op.content}eval(input);\n` } : op));
      return rec;
  }
}
export const mockSuite = (tasks: readonly GoldenTask[], profile: MockProfile, salt = ''): Map<string, Recording> =>
  new Map(tasks.map((t) => [t.id, mockRecording(t, profile, salt)]));
