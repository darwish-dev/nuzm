import { referenceRecording } from './reference';
import { replayTask } from './replay';
import { scoreRun } from './score';
import type { GoldenTask, PatchOp } from './types';

/**
 * Dataset proofs. For one task: (1) SATISFIABLE: its reference recording passes with quality 100; (2) NON-VACUOUS: the untouched fixture and a set of deterministic mutants of the
 * reference patch all FAIL. A mutant that still passes means a check is too weak to tell the solution from a broken answer; the dataset must not ship with one.
 */
export interface Mutant {
  name: string;
  patch: PatchOp[];
}
export function mutantsOf(task: GoldenTask): Mutant[] {
  const out: Mutant[] = [{ name: 'empty-patch', patch: [] }];
  task.solution.forEach((op, i) => {
    if (task.solution.length > 1) out.push({ name: `drop-op-${i}`, patch: task.solution.filter((_, j) => j !== i) });
    if (op.content !== null) {
      out.push({ name: `blank-op-${i}`, patch: task.solution.map((o, j) => (j === i ? { path: o.path, content: '' } : o)) });
      out.push({ name: `shift-path-op-${i}`, patch: task.solution.map((o, j) => (j === i ? { path: `${o.path}.bak`, content: o.content } : o)) });
    }
  });
  return out;
}
export interface TaskProof {
  taskId: string;
  satisfiable: boolean;
  /** names of mutants that PASSED (must be empty) */
  survivingMutants: string[];
}
export function proveTask(task: GoldenTask): TaskProof {
  const ref = scoreRun(task, replayTask(task, referenceRecording(task)));
  const survivors: string[] = [];
  for (const m of mutantsOf(task)) {
    const rec = { ...referenceRecording(task), patch: m.patch };
    if (scoreRun(task, replayTask(task, rec)).passed) survivors.push(m.name);
  }
  return { taskId: task.id, satisfiable: ref.passed && ref.quality === 100, survivingMutants: survivors };
}
