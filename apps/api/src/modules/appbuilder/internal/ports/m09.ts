/**
 * THE M09 BOUNDARY (assumptions A-01..A-12 in docs/reports/M10-m09-interface-assumptions.md).
 *
 * M09 (AI core and website builder) is built in parallel and is NOT on this base. Everything M10 needs from M09 goes through the abstract classes in this
 * file and nothing else: the run store (`ai.runs`), the model gateway, the artifact store (`ai.artifacts`), builder projects/files/versions
 * (`builder.projects`, `builder.project_files`, `builder.project_versions`) and the organization credit balance. Swapping the in-memory mocks
 * (`m09-mock.ts`, labelled NOT VERIFIED) for the real M09 services is ONE provider wiring change in `appbuilder.module.ts` (see `M09_PORT_PROVIDERS`).
 * No table of M09 is created or altered by M10; `run_id`/`project_id` columns of M10 tables are logical references.
 */

export type RunKind = 'webapp' | 'mobile' | 'test-fix' | 'edit' | 'website' | 'chat';
export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
];
/** The legal transitions of M09 §4 S38.2 (queued -> running -> waiting_approval -> terminal). */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'budget_exceeded'],
  waiting_approval: ['running', 'failed', 'cancelled', 'budget_exceeded'],
  succeeded: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
};

/** `budget{maxTokens,maxCostMinor,maxMinutes}` of POST /v1/ai/runs (M10 §6). Money is integer minor units (SAR halalas). */
export interface RunBudget {
  maxTokens: number;
  maxCostMinor: number;
  maxMinutes: number;
}
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
  steps: number;
}
export interface RunRecord {
  id: string;
  orgId: string;
  kind: RunKind;
  projectId: string;
  sessionId: string | null;
  state: RunState;
  budget: RunBudget;
  usage: RunUsage;
  dataRegion: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Stable failure/stop reason (error code), never free model text. */
  reason: string | null;
  specRef: string | null;
  operationId: string | null;
}

/** `ai.runs`: the single run table of M09. M10 only creates, reads, transitions and meters runs through this port. */
export abstract class RunStorePort {
  abstract create(
    orgId: string,
    input: {
      kind: RunKind;
      projectId: string;
      sessionId?: string | null;
      budget: RunBudget;
      dataRegion: string;
      createdBy: string | null;
      specRef?: string | null;
    },
  ): Promise<RunRecord>;
  abstract get(orgId: string, runId: string): Promise<RunRecord | null>;
  abstract list(
    orgId: string,
    filter?: { projectId?: string; state?: RunState; limit?: number },
  ): Promise<RunRecord[]>;
  /** Throws on an illegal transition (see RUN_TRANSITIONS). Terminal states are final. */
  abstract transition(
    orgId: string,
    runId: string,
    to: RunState,
    reason?: string | null,
  ): Promise<RunRecord>;
  abstract addUsage(orgId: string, runId: string, delta: Partial<RunUsage>): Promise<RunRecord>;
  /** Admin support view (`GET /v1/admin/ai/runs`): metadata only, across organizations. */
  abstract listAll(filter?: { state?: RunState; limit?: number }): Promise<RunRecord[]>;
}

export interface ModelRequest {
  orgId: string;
  runId: string;
  agent: string;
  /** A short stable label of what is asked (e.g. `app_spec`), used by the scripted adapter to pick a fixture. */
  purpose: string;
  /** Structured input. Untrusted user text is passed as DATA inside this object, never concatenated into instructions (M09 §4 S38.6). */
  input: unknown;
  maxTokens: number;
  timeoutMs: number;
  dataClass: 'customer-content';
  dataRegion: string;
}
export interface ModelResponse {
  /** Structured output: the caller validates it against the artifact schema. */
  output: unknown;
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
  modelRef: string;
  /** True when the counts are an estimate (provider did not report them). */
  estimated: boolean;
}
/** The M09 model gateway: routing, residency, dataTerms and its own budget reservation live there; M10 adds the run-level guard in front (budget enforcer). */
export abstract class ModelGatewayPort {
  abstract complete(req: ModelRequest): Promise<ModelResponse>;
  /** The price of one output token in minor units per 1000 tokens, for the pre-flight reservation (max_tokens x rate). */
  abstract rateMinorPer1kTokens(orgId: string): Promise<number>;
}
export class ModelTimeoutError extends Error {
  constructor(message = 'model call timed out') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}
export class ModelNoCapacityError extends Error {
  constructor(message = 'no model capacity') {
    super(message);
    this.name = 'ModelNoCapacityError';
  }
}

/** `ai.artifacts`: payloads of agent outputs. M10 adds the kinds `app_spec, openapi, test_report, sbom`. Returns an opaque ref. */
export abstract class ArtifactStorePort {
  abstract put(
    orgId: string,
    runId: string | null,
    kind: string,
    payload: unknown,
  ): Promise<string>;
  abstract get(orgId: string, ref: string): Promise<unknown | null>;
}

export type ProjectType = 'website' | 'webapp' | 'mobile';
export interface ProjectRecord {
  id: string;
  orgId: string;
  type: ProjectType;
  name: string;
  dataRegion: string;
  headVersionId: string | null;
  /** ETag counter (`builder.projects.version`). */
  version: number;
  referenceTemplate: string | null;
  createdBy: string | null;
  createdAt: string;
}
export interface ProjectVersion {
  id: string;
  projectId: string;
  parentId: string | null;
  label: string | null;
  source: 'user' | 'ai' | 'restore' | 'system';
  createdAt: string;
  createdBy: string | null;
  /** path -> sha256 of content. */
  manifest: Record<string, string>;
}
/** `builder.projects` + `builder.project_files` + `builder.project_versions`: the single file store of M09. Text files only (M10A scaffolds are text). */
export abstract class ProjectsPort {
  abstract get(orgId: string, projectId: string): Promise<ProjectRecord | null>;
  abstract list(
    orgId: string,
    filter?: { type?: ProjectType; limit?: number },
  ): Promise<ProjectRecord[]>;
  abstract create(
    orgId: string,
    input: {
      type: ProjectType;
      name: string;
      dataRegion: string;
      createdBy: string | null;
      referenceTemplate?: string | null;
    },
  ): Promise<ProjectRecord>;
  abstract getVersion(
    orgId: string,
    projectId: string,
    versionId: string,
  ): Promise<ProjectVersion | null>;
  abstract listVersions(orgId: string, projectId: string): Promise<ProjectVersion[]>;
  /** Creates a new head version containing EXACTLY `files` (full snapshot) and returns it. Optimistic: `baseVersionId` must be the current head (or null for the first). */
  abstract commit(
    orgId: string,
    projectId: string,
    input: {
      baseVersionId: string | null;
      files: ReadonlyMap<string, string>;
      label?: string | null;
      source: ProjectVersion['source'];
      createdBy: string | null;
    },
  ): Promise<ProjectVersion>;
  abstract readFiles(
    orgId: string,
    projectId: string,
    versionId: string,
  ): Promise<Map<string, string> | null>;
}

/** The organization's remaining AI credit (`ai.credit_balances`, a projection of the M02 wallet), in minor units. */
export abstract class OrgBudgetPort {
  abstract remainingMinor(orgId: string): Promise<number>;
}

export class StaleBaseError extends Error {
  constructor(readonly currentHead: string | null) {
    super('base version is not the project head');
    this.name = 'StaleBaseError';
  }
}
