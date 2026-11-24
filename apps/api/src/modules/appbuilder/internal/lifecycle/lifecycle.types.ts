import type { builderTools } from '@nuzm/domain';

type LC = typeof builderTools.lifecycle;
export type LifecycleState = builderTools.lifecycle.LifecycleState;
export type StepId = builderTools.lifecycle.StepId;
export type Usage = builderTools.lifecycle.Usage;
export type FileOp = builderTools.FileOp;
export type Finding = builderTools.Finding;
export type Diagnostic = builderTools.Diagnostic;
export type ExecutionPurpose = builderTools.lifecycle.ExecutionPurpose;
export type { LC };

/**
 * What the lifecycle keeps in the run checkpoint BESIDE the state machine: small results the later steps need. File contents never live here (they go to the artifact store and
 * the checkpoint holds the id), so a checkpoint stays small however big the project is.
 */
export interface LifecycleArtifacts {
  analysis?: builderTools.planning.ImplementationPlan['analysis'] & {
    productType: string;
    locale: string;
    confidence: number;
  };
  project?: {
    files: number;
    codeFiles: number;
    symbols: number;
    components: number;
    unresolvedImports: number;
    memoryEntries: number;
    empty: boolean;
  };
  architecture?: { productType: string; stackId: string; parts: string[]; reason: string };
  plan?: builderTools.planning.ImplementationPlan;
  /** artifact id of the generated change set (ops) */
  changeSetRef?: string;
  generator?: 'skeleton' | 'model';
  generatedFiles?: number;
  /** the version this run created (the change apply) and the one it started from */
  baseVersionId?: string | null;
  appliedVersionId?: string;
  review?: { errors: number; warnings: number; infos: number; top: Finding[] };
  executionOrigin?: 'MOCK' | 'REAL';
  lastBuild?: {
    phase: 'build' | 'rebuild' | 'tests';
    passed: boolean;
    runs: { profile: string; status: string; durationMs: number }[];
    diagnostics: Diagnostic[];
  };
  fingerprints?: string[];
  repairRef?: string;
  repairNote?: string;
  repairedVersions?: string[];
  rejected?: { at: string; code: string; message: string }[];
  preview?: { files: number; bytes: number; entry: string | null; previewUrl: null };
  deployment?: builderTools.lifecycle.DeploymentPlan;
  approvalId?: string;
}

/** The run engine's side: persistence, events, audit, cancellation. One implementation over `RunContext` (DB), one in memory for tests. */
export interface LifecycleHost {
  orgId: string;
  runId: string;
  projectId: string;
  userId: string | null;
  permissions: ReadonlySet<string>;
  budget: { maxTokens?: number; maxCredits?: number };
  input: { prompt: string; maxRepairRounds?: number; maxMinutes?: number };
  now(): string;
  load(): Promise<{ state: LifecycleState; artifacts: LifecycleArtifacts } | null>;
  /** persist after EVERY step (the run checkpoint) */
  save(state: LifecycleState, artifacts: LifecycleArtifacts, step: string): Promise<void>;
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  audit(
    action: string,
    outcome: 'success' | 'failure',
    detail: Record<string, unknown>,
  ): Promise<void>;
  cancelled(): Promise<boolean>;
  /** the persistent step record (`ai.run_steps`): one row per step, a repair round a new row */
  stepBegin(step: StepId, round: number, attempt: number): Promise<string>;
  stepEnd(
    id: string,
    status: 'succeeded' | 'failed',
    o: { usage?: Usage; code?: string },
  ): Promise<void>;
  storeArtifact(type: 'change_set' | 'evaluation_report', payload: unknown): Promise<string>;
  loadArtifact(id: string): Promise<unknown | null>;
  /** the run state on the engine side (e.g. `waiting_approval`), kept in step with the lifecycle */
  setRunState(state: 'running' | 'waiting_approval'): Promise<void>;
}

export interface FileGenerator {
  readonly kind: 'skeleton' | 'model';
  generate(
    input: builderTools.lifecycle.GenerationInput,
    current: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ops: FileOp[]; note?: string }>;
}

export interface ExecutionBudgetPort {
  /** throws a `ProblemException` (`budget_required`, `quota_exceeded`, `residency_denied`, `sandbox_quota_exceeded`) when execution may not start */
  assertStart(orgId: string, purpose: ExecutionPurpose): Promise<{ gates: string[] }>;
  /** one metering event per execution (idempotent by `eventKey`): there is no unmetered execution */
  meter(
    orgId: string,
    projectId: string,
    e: {
      eventKey: string;
      profile: string;
      durationMs: number;
      origin: 'MOCK' | 'REAL';
      /** when this attempt of the step began (ISO): the metering window is derived from it, so a replay of the same call is the same event */
      at: string;
    },
  ): Promise<void>;
}

/** The project and its collaborators, bound to ONE run of ONE organization (the verified auth context, never model input). */
export interface LifecycleEnv {
  head(): Promise<{ versionId: string | null; files: Map<string, string> }>;
  /** the validated safe-change path, source `ai` (AI branch only, never `main`) */
  apply(ops: FileOp[], label: string): Promise<{ versionId: string }>;
  generator: FileGenerator;
  repair: builderTools.RepairStrategy;
  /** which model steps really call a model (the others cost no tokens, so they reserve none) */
  modelBacked: { file_generation: boolean; repair: boolean };
  /** null = no build service is configured: the execution steps refuse (the sandbox runtime is not approved) */
  build: builderTools.BuildPort | null;
  budget: ExecutionBudgetPort;
  /** the deployment approval request (`production_deploy`, an owner or admin decides); returns the open approval */
  requestDeployApproval(
    summary: Record<string, unknown>,
  ): Promise<{ id: string; scopeHash: string }>;
  /** the decision of that approval, as the approvals inbox has it */
  deployApprovalStatus(id: string): Promise<'pending' | 'approved' | 'rejected' | 'expired'>;
  /** tokens and credits the model steps used since the last call (read-and-reset) */
  takeUsage(): Usage;
}

export class StepFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}
