/**
 * The 18-step builder lifecycle (PHASE-2 S05). Pure data: what the steps are, in what order, what each one may use and what it may cost. The runner (API) executes them; this file
 * decides nothing about the outside world. Every step is recorded, resumable (its result is in the checkpoint), cancellable between steps and metered.
 */
export const LIFECYCLE_STEP_IDS = [
  'requirements',
  'project_analysis',
  'architecture',
  'plan',
  'tasks',
  'file_generation',
  'change_apply',
  'review',
  'execution_request',
  'build',
  'error_analysis',
  'repair',
  'repair_apply',
  'rebuild',
  'tests',
  'preview',
  'deployment_preparation',
  'deployment_approval',
] as const;
export type StepId = (typeof LIFECYCLE_STEP_IDS)[number];

/** where a step gets its result: deterministic code, a model call, the Execution Gateway (request only), a change on the project, or a person */
export type StepKind = 'local' | 'model' | 'execution' | 'change' | 'approval';

export interface StepDef {
  id: StepId;
  kind: StepKind;
  /** i18n key of the customer-facing name (`bt.lc.step.<id>`) */
  labelKey: string;
  /** the tools this step may call (see the registry): nothing else is reachable from it */
  tools: readonly string[];
  /** the steps that only run inside the repair loop: skipped when the first build passes */
  repairOnly: boolean;
  /** estimated tokens one attempt of a model step may use (a budget reservation, never a promise); 0 for steps without a model */
  estTokens: number;
}

const d = (
  id: StepId,
  kind: StepKind,
  tools: readonly string[],
  o: { repairOnly?: boolean; estTokens?: number } = {},
): StepDef => ({
  id,
  kind,
  labelKey: `bt.lc.step.${id}`,
  tools,
  repairOnly: o.repairOnly ?? false,
  estTokens: o.estTokens ?? 0,
});

export const STEP_DEFS: Readonly<Record<StepId, StepDef>> = {
  requirements: d('requirements', 'local', ['analyze_requirements']),
  project_analysis: d('project_analysis', 'local', [
    'list_files',
    'read_file',
    'find_symbols',
    'analyze_imports',
    'list_components',
    'read_memory',
  ]),
  architecture: d('architecture', 'local', ['choose_architecture']),
  plan: d('plan', 'local', ['build_plan']),
  tasks: d('tasks', 'local', ['derive_tasks']),
  file_generation: d('file_generation', 'model', ['propose_files', 'read_file'], {
    estTokens: 6000,
  }),
  change_apply: d('change_apply', 'change', ['preview_change', 'apply_change']),
  review: d('review', 'local', ['review_project']),
  execution_request: d('execution_request', 'execution', ['request_execution']),
  build: d('build', 'execution', ['request_execution']),
  error_analysis: d('error_analysis', 'local', ['diagnose_build'], { repairOnly: true }),
  repair: d('repair', 'model', ['propose_repair', 'read_file'], {
    repairOnly: true,
    estTokens: 4000,
  }),
  repair_apply: d('repair_apply', 'change', ['preview_change', 'apply_change'], {
    repairOnly: true,
  }),
  rebuild: d('rebuild', 'execution', ['request_execution'], { repairOnly: true }),
  tests: d('tests', 'execution', ['request_execution']),
  preview: d('preview', 'local', ['preview_change']),
  deployment_preparation: d('deployment_preparation', 'local', ['prepare_deployment']),
  deployment_approval: d('deployment_approval', 'approval', ['request_deploy_approval']),
};

export const stepOrder = (): readonly StepId[] => LIFECYCLE_STEP_IDS;

/** the repair loop in order: error analysis → repair → repair apply → rebuild, repeated while the rebuild fails and a round is left */
export const REPAIR_STEPS: readonly StepId[] = [
  'error_analysis',
  'repair',
  'repair_apply',
  'rebuild',
];

export interface LifecycleLimits {
  /** attempts of ONE step for a transient failure (first try included) */
  maxStepAttempts: number;
  /** rounds of error analysis → repair → apply → rebuild */
  maxRepairRounds: number;
  /** step executions in one run, repeats included: a hard stop against a loop nobody foresaw */
  maxStepRuns: number;
  /** files one generation step may propose */
  maxGeneratedFiles: number;
  /** ceiling of tokens the run may account (estimates before a call, real counts after) when the run carries no budget of its own */
  maxTokens: number;
  /** wall-clock minutes of the whole run */
  maxMinutes: number;
  /** execution requests (build, rebuild, tests) one run may make */
  maxExecutionRequests: number;
}

/** Defaults. A run's own `budget` and `maxMinutes` can only LOWER these. */
export const LIFECYCLE_LIMITS: LifecycleLimits = {
  maxStepAttempts: 2,
  maxRepairRounds: 3,
  maxStepRuns: 60,
  maxGeneratedFiles: 120,
  maxTokens: 400_000,
  maxMinutes: 60,
  maxExecutionRequests: 12,
};

/** a failure code worth ONE more attempt of the same step (the others end the step at once) */
export const TRANSIENT_CODES: readonly string[] = [
  'timeout',
  'unavailable',
  'rate_limited',
  'internal_error',
];
