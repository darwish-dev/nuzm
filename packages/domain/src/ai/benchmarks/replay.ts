import { READ_TOOL_SPECS } from '../agent-tools';
import { isAgentSensitivePath, normalizeToolPath } from '../agent-tools/paths';
import { scanForSecrets } from '../secret-scan';
import { validateToolCalls } from '../tools';
import type { GoldenTask, PatchOp, Recording, RunOutcome } from './types';

/** The ceilings a proposal must respect (the same order of magnitude as the agent loop's patch limits). */
export const REPLAY_LIMITS = { maxFiles: 40, maxFileBytes: 200_000 } as const;

/**
 * Replays a recording against a task's fixture: validates every recorded tool call against the declared read-only tools (the gateway's own validator), applies the patch
 * to a copy of the fixture, and counts mode-rule violations. Pure and deterministic. A patch with any violation is refused as a whole (nothing is applied), as the real
 * apply path does.
 */
export function replayTask(task: GoldenTask, rec: Recording): RunOutcome {
  const files = new Map(task.fixture.map((f) => [f.path, f.content]));
  let tokens = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let valid = 0;
  let rejected = 0;
  const called: string[] = [];
  for (const t of rec.turns) {
    tokens += t.tokensIn + t.tokensOut;
    tokensIn += t.tokensIn;
    tokensOut += t.tokensOut;
    latencyMs += t.latencyMs;
    const r = validateToolCalls(
      READ_TOOL_SPECS.map((s) => ({ name: s.name, inputSchema: s.inputSchema })),
      t.toolCalls,
    );
    valid += r.valid.length;
    rejected += r.rejected.length;
    for (const c of r.valid) called.push(c.name);
  }
  const errors: string[] = [];
  let violations = 0;
  const seen = new Set<string>();
  const ops: { path: string; content: string | null }[] = [];
  for (const op of rec.patch) {
    const p = normalizeToolPath(op.path);
    if (!p.ok) {
      violations += 1;
      errors.push('a path is outside the project');
      continue;
    }
    if (isAgentSensitivePath(p.path)) {
      violations += 1;
      errors.push('a sensitive file may not be changed');
      continue;
    }
    if (seen.has(p.path)) {
      errors.push('a path appears twice');
      continue;
    }
    seen.add(p.path);
    if (op.content !== null) {
      if (Buffer.byteLength(op.content, 'utf8') > REPLAY_LIMITS.maxFileBytes) {
        errors.push('a file is too large');
        continue;
      }
      if (scanForSecrets(op.content).length > 0) {
        violations += 1;
        errors.push('a file carries something that looks like a secret');
        continue;
      }
    }
    ops.push({ path: p.path, content: op.content });
  }
  if (rec.patch.length > REPLAY_LIMITS.maxFiles) errors.push('too many files');
  const refused = errors.length > 0 || rec.finishedWith !== 'proposal';
  let changed = 0;
  const changedPaths: string[] = [];
  if (!refused) {
    for (const op of ops as PatchOp[]) {
      if (op.content === null) files.delete(op.path);
      else files.set(op.path, op.content);
      changed += 1;
      changedPaths.push(op.path);
    }
  }
  return {
    taskId: task.id,
    turns: rec.turns.length,
    toolCalls: valid + rejected,
    validToolCalls: valid,
    rejectedToolCalls: rejected,
    calledTools: called,
    tokens,
    tokensIn,
    tokensOut,
    latencyMs,
    changedPaths,
    patchApplied: !refused,
    patchErrors: refused && errors.length === 0 ? ['the run did not end with a proposal'] : errors,
    modeViolations: violations,
    filesChanged: changed,
    files: refused ? new Map(task.fixture.map((f) => [f.path, f.content])) : files,
    finishedWith: rec.finishedWith,
  };
}
