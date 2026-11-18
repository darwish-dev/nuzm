import { createEnv, ORG_A, ORG_B, type TestEnv } from '@nuzm/platform/testing';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { ApprovalService } from '../approvals/approval.service';
import { WEBAPP_ARTIFACTS } from '../graph/dag';
import {
  GraphRunner,
  DEFAULT_RUNNER_CONFIG,
  type AgentExecutor,
  type AgentResult,
  type RunnerConfig,
} from '../graph/runner';
import { AGENTS, type AgentId } from '../core';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { AppSpecService } from '../spec/spec.service';
import { EvaluationService } from '../eval/evaluation';
import { StaticAdvisoryDb } from '../policy/dependencies';
import { webappExecutors } from '../agents/webapp-agents';
import {
  MemoryArtifactStore,
  MemoryProjects,
  MemoryRunStore,
  ScriptedModelGateway,
  StaticOrgBudget,
} from '../ports/m09-mock';

export class RecordingSink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
const file = (path: string, content = 'x') => ({ path, content });

/** Valid minimal artifacts per kind: the scripted model's recorded fixtures for the plumbing tests (NOT model quality). */
export const MINIMAL_FIXTURES: Record<string, () => unknown> = {
  requirements: () => ({
    summary: 'A task tracker',
    entities: [{ name: 'Project' }, { name: 'Task' }],
    roles: ['admin', 'member'],
    locales: ['ar', 'en'],
  }),
  app_spec: () => SAMPLE_SPEC,
  db_schema: () => ({
    migrations: [
      {
        version: 1,
        name: 'init',
        up: 'CREATE TABLE t (id int);',
        down: 'DROP TABLE t;',
        destructive: [],
      },
    ],
    tables: ['t'],
    files: [file('db/001.sql')],
  }),
  api_contract: () => ({
    openapi: { openapi: '3.1.0' },
    rbac: {},
    dependencies: {},
    files: [file('api/openapi.json')],
  }),
  frontend_bundle: () => ({ pages: ['/'], files: [file('web/index.html')] }),
  test_plan: () => ({
    summary: { contractTests: 1, unitTests: 1 },
    files: [file('tests/a.test.ts')],
  }),
  deploy_plan: () => ({
    healthPath: '/health',
    env: ['DATABASE_URL'],
    files: [file('deploy/run.json')],
  }),
};

/** Executor that asks the (scripted) model for its artifact kind: the generic plumbing used by the S42 tests. */
export class ModelFixtureExecutor implements AgentExecutor {
  constructor(
    readonly agent: AgentId,
    private readonly produces: string,
    private readonly hook?: (r: AgentResult) => AgentResult,
  ) {}
  async execute(ctx: Parameters<AgentExecutor['execute']>[0]): Promise<AgentResult> {
    const artifact = await ctx.model.ask<unknown>({
      agent: this.agent,
      purpose: this.produces,
      input: { inputs: Object.keys(ctx.inputs) },
      schema: WEBAPP_ARTIFACTS[this.produces]!.schema,
      maxTokens: 4_000,
    });
    const r: AgentResult = {
      artifact,
      toolCalls: [{ tool: 'model.complete', args: { purpose: this.produces } }],
    };
    return this.hook ? this.hook(r) : r;
  }
}

export interface EngineEnv {
  env: TestEnv;
  sink: RecordingSink;
  runs: MemoryRunStore;
  artifacts: MemoryArtifactStore;
  projects: MemoryProjects;
  model: ScriptedModelGateway;
  orgBudget: StaticOrgBudget;
  approvals: ApprovalService;
  specs: AppSpecService;
  evals: EvaluationService;
  /** Replace the plumbing executors with the real seven agents (scaffolders). */
  useRealAgents: () => void;
  executors: Map<AgentId, AgentExecutor>;
  runner: (cfg?: Partial<RunnerConfig>) => GraphRunner;
  orgA: string;
  orgB: string;
  newRun: (
    org?: string,
    budget?: { maxTokens: number; maxCostMinor: number; maxMinutes: number },
  ) => Promise<string>;
  close: () => Promise<void>;
}

export async function setupEngineEnv(): Promise<EngineEnv> {
  const env = await createEnv();
  const sink = new RecordingSink();
  const runs = new MemoryRunStore();
  const artifacts = new MemoryArtifactStore();
  const projects = new MemoryProjects();
  const orgBudget = new StaticOrgBudget();
  const fixtures: Record<string, (r: never) => unknown> = {};
  for (const [k, f] of Object.entries(MINIMAL_FIXTURES)) fixtures[k] = () => f();
  const model = new ScriptedModelGateway(fixtures as never);
  const approvals = new ApprovalService(env.app, sink);
  const specs = new AppSpecService(env.app, sink);
  const evals = new EvaluationService(env.app);
  const executors = new Map<AgentId, AgentExecutor>();
  const produces: Record<string, string> = {
    requirements: 'requirements',
    architecture: 'app_spec',
    database: 'db_schema',
    backend: 'api_contract',
    frontend: 'frontend_bundle',
    qa: 'test_plan',
    devops: 'deploy_plan',
  };
  for (const a of AGENTS)
    if (produces[a]) executors.set(a, new ModelFixtureExecutor(a, produces[a]!));
  return {
    env,
    sink,
    runs,
    artifacts,
    projects,
    model,
    orgBudget,
    approvals,
    specs,
    evals,
    useRealAgents: () => {
      for (const [k, v] of webappExecutors({ specs, projects, advisories: new StaticAdvisoryDb() }))
        executors.set(k, v);
    },
    executors,
    runner: (cfg = {}) =>
      new GraphRunner(env.app, sink, runs, artifacts, model, orgBudget, approvals, executors, {
        ...DEFAULT_RUNNER_CONFIG,
        ...cfg,
      }),
    orgA: ORG_A,
    orgB: ORG_B,
    newRun: async (
      org = ORG_A,
      budget = { maxTokens: 500_000, maxCostMinor: 100_000, maxMinutes: 30 },
    ) => {
      const p = await projects.create(org, {
        type: 'webapp',
        name: 'p',
        dataRegion: 'sa-central',
        createdBy: null,
      });
      return (
        await runs.create(org, {
          kind: 'webapp',
          projectId: p.id,
          budget,
          dataRegion: 'sa-central',
          createdBy: null,
        })
      ).id;
    },
    close: () => env.close(),
  };
}
