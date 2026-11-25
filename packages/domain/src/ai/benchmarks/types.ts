import type { RequestedCall } from '../tools';
import type { TaskCategory } from './categories';

/**
 * S-AG5 (offline preparation): the golden task suite, the replay of recorded model behaviour and the scoring. Nothing here calls a model, a network or a clock: a
 * benchmark run is a pure function of (task, recording). Every task is SYNTHETIC (authored for this suite, no customer data, data class `public`).
 */
export type TaskKind = 'website' | 'webapp' | 'code-edit' | 'tool-calling';
export interface FixtureFile {
  path: string;
  content: string;
}
/** A structural check of the project after the proposed patch is applied. */
export type Check =
  | { type: 'file_exists'; path: string }
  | { type: 'file_absent'; path: string }
  | { type: 'contains'; path: string; text: string }
  | { type: 'not_contains'; path: string; text: string }
  | { type: 'json_valid'; path: string }
  /** the file matches a regular expression (authored with the task; never user input) */
  | { type: 'matches'; path: string; pattern: string; flags?: string }
  | { type: 'not_matches'; path: string; pattern: string; flags?: string }
  /** a dotted path inside a JSON file equals a value (`a.b.0.c`) */
  | { type: 'json_field_equals'; path: string; field: string; value: string | number | boolean }
  | { type: 'max_files_changed'; n: number };
/** One file operation of a proposal: new content, or `null` to delete. */
export interface PatchOp {
  path: string;
  content: string | null;
}
export interface GoldenTask {
  id: string;
  kind: TaskKind;
  /** the finer axis (23 categories); every category maps to exactly one kind (`CATEGORY_KIND`) */
  category: TaskCategory;
  /** bumped whenever the task's prompt, fixture, checks, tools, budget or solution change; the registry refuses a content change without it */
  revision: number;
  locale: 'ar' | 'en';
  title: string;
  /** what a person would type (synthetic) */
  prompt: string;
  fixture: FixtureFile[];
  checks: Check[];
  tools: { mustCall: string[]; mustNotCall: string[]; maxCalls: number };
  budget: { maxTurns: number; maxTokens: number };
  /** the reference answer: proves the checks can be satisfied, and is the baseline recording's patch */
  solution: PatchOp[];
  dataClass: 'public';
  synthetic: true;
}
export interface RecordedTurn {
  toolCalls: RequestedCall[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}
/** What a real or mock model did for one task, recorded once and replayed offline forever. */
export interface Recording {
  taskId: string;
  adapterId: string;
  model: string;
  contractVersion: string;
  /**
   * 'REFERENCE' = produced by this repository's oracle (not a model); 'MOCK' = scripted by a mock model or a test double (plumbing, not a model);
   * 'RECORDED' = captured from a real run through the gated live runner (only after S-AG4 closes, and only with `capture` provenance).
   */
  origin: 'REFERENCE' | 'MOCK' | 'RECORDED';
  /** the dataset version the recording was made against; a recording of another version is never mixed into a report */
  datasetVersion?: string;
  /** who/what captured a RECORDED run: required for `RECORDED` to count as evidence */
  capture?: CaptureProvenance;
  turns: RecordedTurn[];
  patch: PatchOp[];
  finishedWith: 'proposal' | 'fallback' | 'cancelled' | 'failed';
}
export interface CaptureProvenance {
  runId: string;
  /** reference of the approval that allowed the live capture (budget, provider verification) */
  approvalRef: string;
  providerEvidenceRef: string;
  capturedAt: string;
}
export interface RunOutcome {
  taskId: string;
  turns: number;
  toolCalls: number;
  validToolCalls: number;
  rejectedToolCalls: number;
  calledTools: string[];
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** paths the applied patch changed (empty when refused) */
  changedPaths: string[];
  patchApplied: boolean;
  /** why the patch was refused as a whole (empty when applied) */
  patchErrors: string[];
  /** a proposal that touches a path outside the project, a sensitive file, or carries a secret: counted, and the run scores 0 */
  modeViolations: number;
  filesChanged: number;
  files: Map<string, string>;
  finishedWith: Recording['finishedWith'];
}
/** Per-dimension scores 0-100; `null` = the dimension does not apply to what the patch changed (never counted as 100). */
export interface DimensionScores {
  functional: number;
  codeQuality: number | null;
  security: number | null;
  uiQuality: number | null;
}
export interface TaskScore {
  taskId: string;
  kind: TaskKind;
  category: TaskCategory;
  dimensions: DimensionScores;
  /** deterministic efficiency 0-100 (tokens vs budget, turns, latency) */
  efficiency: number;
  tokensIn: number;
  tokensOut: number;
  checksPassed: number;
  checksTotal: number;
  validPatch: boolean;
  toolCallValidity: number;
  mustCallSatisfied: boolean;
  withinBudget: boolean;
  modeViolations: number;
  tokens: number;
  toolCalls: number;
  turns: number;
  latencyMs: number;
  /** 0 to 100; 0 whenever a mode rule was violated or the patch was refused */
  quality: number;
  passed: boolean;
}
