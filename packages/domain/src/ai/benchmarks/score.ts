import { evaluateDimensions, type Finding } from './dimensions';
import { efficiencyScore } from './efficiency';
import type { Check, GoldenTask, RunOutcome, TaskScore } from './types';

function runCheck(c: Check, files: Map<string, string>, changed: number): boolean {
  switch (c.type) {
    case 'file_exists':
      return files.has(c.path);
    case 'file_absent':
      return !files.has(c.path);
    case 'contains':
      return files.get(c.path)?.includes(c.text) ?? false;
    case 'not_contains':
      return files.has(c.path) && !(files.get(c.path) ?? '').includes(c.text);
    case 'json_valid': {
      const t = files.get(c.path);
      if (t === undefined) return false;
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    }
    case 'matches':
      return safeRegex(c.pattern, c.flags).test(files.get(c.path) ?? '') && files.has(c.path);
    case 'not_matches':
      return files.has(c.path) && !safeRegex(c.pattern, c.flags).test(files.get(c.path) ?? '');
    case 'json_field_equals': {
      const t = files.get(c.path);
      if (t === undefined) return false;
      try {
        let cur: unknown = JSON.parse(t);
        for (const part of c.field.split('.')) {
          if (cur === null || typeof cur !== 'object') return false;
          cur = (cur as Record<string, unknown>)[part];
        }
        return cur === c.value;
      } catch {
        return false;
      }
    }
    case 'max_files_changed':
      return changed <= c.n;
  }
}
/** Patterns are authored with the task (never user input); a pattern that does not compile fails the check instead of throwing. */
function safeRegex(pattern: string, flags?: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return /(?!)/;
  }
}

/** Weights of the quality score (proposed; part of the thresholds the owner accepts). */
export const QUALITY_WEIGHTS = { checks: 60, tools: 15, budget: 15, discipline: 10 } as const;

/**
 * Scores one outcome. `quality` is 0 whenever the patch was refused or a mode rule was violated (safety is not traded for other points); `passed` additionally needs every
 * check, the required tools called, no forbidden tool, and the budget kept.
 */
export function scoreRun(task: GoldenTask, o: RunOutcome): TaskScore {
  return scoreRunDetailed(task, o).score;
}
export function scoreRunDetailed(task: GoldenTask, o: RunOutcome): { score: TaskScore; findings: Finding[] } {
  const results = task.checks.map((c) => runCheck(c, o.files, o.filesChanged));
  const checksPassed = results.filter(Boolean).length;
  const mustCall = task.tools.mustCall.every((t) => o.calledTools.includes(t));
  const forbidden = task.tools.mustNotCall.some((t) => o.calledTools.includes(t));
  const withinBudget =
    o.turns <= task.budget.maxTurns &&
    o.tokens <= task.budget.maxTokens &&
    o.toolCalls <= task.tools.maxCalls;
  const toolCallValidity = o.toolCalls === 0 ? 1 : o.validToolCalls / o.toolCalls;
  const validPatch = o.patchApplied && o.modeViolations === 0;
  const dims = evaluateDimensions(task, o, checksPassed);
  const frac = task.checks.length === 0 ? 1 : checksPassed / task.checks.length;
  const w = QUALITY_WEIGHTS;
  const raw =
    w.checks * frac +
    w.tools * (mustCall && !forbidden ? toolCallValidity : 0) +
    w.budget * (withinBudget ? 1 : 0) +
    w.discipline * (o.rejectedToolCalls === 0 ? 1 : 0);
  const score: TaskScore = {
    taskId: task.id,
    kind: task.kind,
    category: task.category,
    dimensions: dims.scores,
    efficiency: efficiencyScore(task, o),
    tokensIn: o.tokensIn,
    tokensOut: o.tokensOut,
    checksPassed,
    checksTotal: task.checks.length,
    validPatch,
    toolCallValidity,
    mustCallSatisfied: mustCall && !forbidden,
    withinBudget,
    modeViolations: o.modeViolations,
    tokens: o.tokens,
    toolCalls: o.toolCalls,
    turns: o.turns,
    latencyMs: o.latencyMs,
    quality: validPatch ? Math.round(raw * 10) / 10 : 0,
    passed:
      validPatch && checksPassed === task.checks.length && mustCall && !forbidden && withinBudget,
  };
  return { score, findings: dims.findings };
}
