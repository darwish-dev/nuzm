import {
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as dns } from 'node:dns';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import {
  AI_CONFIG,
  BudgetService,
  GatewayService,
  ModelAdapterRegistry,
  ModelProviderService,
  AgentToolGateway,
  AgentWorkspaceRegistry,
  RunKindRegistry,
  RunService,
  SessionService,
  type AiConfig,
} from '../ai';
import { BuilderModule, LivePreviewRegistry, ProjectDelegates, ProjectService } from '../builder';
import { ResidencyService } from '../compliance';
import { DeployService, SitePublisherPort } from '../deploy';
import { IdentityModule } from '../identity';
import { CustomerTemplateService, KnowledgeModule } from '../knowledge';
import { TemplateStartController } from './template-start.controller';
import { TemplateStartService } from './internal/studio/template-start';
import { GenerationController } from './generation.controller';
import { GenerationService } from './internal/studio/generation';
import { TemplateAdaptRunner } from './internal/studio/template-adapt';
import { AgentLoopRunner } from './internal/studio/agent-loop';
import { AgentProjectWorkspace } from './internal/studio/agent-workspace';
import { ApprovalsController } from './approvals.controller';
import { ExportsController } from './exports.controller';
import { SandboxesController } from './sandboxes.controller';
import { LivePreviewController } from './live-preview.controller';
import { WebappLivePreviewService } from './internal/preview/live-preview.service';
import { TestRunsController } from './test-runs.controller';
import { webappExecutors } from './internal/agents/webapp-agents';
import { ApprovalService } from './internal/approvals/approval.service';
import { ChangeService } from './internal/changes/change.service';
import { WebappChangesDelegate, WebappDeployDelegateImpl } from './internal/delegates';
import { AppDeploymentService, DEFAULT_DEPLOY_CONFIG } from './internal/deploy/deployment.service';
import {
  DeployTargetPort,
  DevStaticTarget,
  HealthProbePort,
  HttpHealthProbe,
  MemoryReleaseStore,
  ReleaseStorePort,
} from './internal/deploy/ports';
import { SitePublisherDeployTarget } from './internal/deploy/site-target';
import { EvaluationService } from './internal/eval/evaluation';
import { ExportService } from './internal/export/export.service';
import { AppBuilderEnabledGuard, M09StubGuard } from './internal/flag.guard';
import { GitStore } from './internal/git/git.store';
import { DEFAULT_RUNNER_CONFIG, GraphRunner } from './internal/graph/runner';
import { SandboxJobs } from './internal/jobs';
import { AdvisoryDbPort, StaticAdvisoryDb } from './internal/policy/dependencies';
import {
  ArtifactStorePort,
  ModelGatewayPort,
  OrgBudgetPort,
  ProjectsPort,
  RunStorePort,
} from './internal/ports/m09';
import {
  MemoryArtifactStore,
  MemoryProjects,
  MemoryRunStore,
  ScriptedModelGateway,
  StaticOrgBudget,
} from './internal/ports/m09-mock';
import {
  PgArtifactStore,
  PgOrgBudget,
  PgProjects,
  PgRunStore,
  RealModelGateway,
} from './internal/ports/m09-real';
import { makeStubSwitch, routed, type StubSwitch } from './internal/ports/m09-routed';
import { TestFixRunHandler, WebappRunHandler } from './internal/run-handlers';
import { AppRunService } from './internal/run.service';
import { CanaryRegistry, MemorySecurityAlerts, SecurityAlertPort } from './internal/sandbox/canary';
import { DEFAULT_ALLOW, EgressPolicy } from './internal/sandbox/egress';
import { LocalDevSandboxRuntime } from './internal/sandbox/local-dev-runtime';
import { MockSandboxRuntime } from './internal/sandbox/mock-runtime';
import { SandboxRuntime, RuntimeNoCapacity, type RuntimeSpec } from './internal/sandbox/runtime';
import { DEFAULT_SANDBOX_CONFIG, SandboxService } from './internal/sandbox/sandbox.service';
import { AppSpecService } from './internal/spec/spec.service';
import { TestFixService } from './internal/tests/test-fix.service';
import { TestRunService } from './internal/tests/test-run.service';
import { SecretStore } from '../../common/secrets';
import { ClaudeCodeService } from './internal/studio/claude-code.service';
import { StudioFileWriter } from './internal/studio/files';
import { StudioEnabledGuard } from './internal/studio/flag';
import {
  FakeGitHostAdapter,
  GitHubAppAdapter,
  type GitHostAdapter,
} from './internal/studio/git-host';
import { GitHubService } from './internal/studio/github.service';
import { InstructionsService } from './internal/studio/instructions.service';
import {
  FakeSkillSource,
  GithubPublicSkillSource,
  SkillSource,
} from './internal/studio/skill-source';
import { StudioSettingsService } from './internal/studio/settings.service';
import { SkillsService } from './internal/studio/skills.service';
import {
  AdminSkillsController,
  GithubWebhooksController,
  StudioClaudeCodeController,
  StudioFilesController,
  StudioGithubConnectionController,
  StudioInstructionsController,
  StudioProjectGithubController,
  StudioProjectSkillsController,
  StudioSettingsController,
  StudioSkillsCatalogController,
} from './studio-controllers';

/**
 * THE M09 BOUNDARY, WIRED TO THE REAL SERVICES (docs/reports/M10-m09-interface-assumptions.md, "Integration" section): RunStorePort -> `ai.runs`, ModelGatewayPort -> M09's
 * `GatewayService`, ArtifactStorePort -> `ai.artifacts`, ProjectsPort -> `builder.projects|project_versions|project_files`, OrgBudgetPort -> `ai.credit_balances`.
 * Each port is ROUTED per organization (`m09-routed.ts`): the in-memory stand-ins (`m09-mock.ts`, NOT VERIFIED) answer only while the organization has the dev flag
 * `app_builder.m09_stubs`, and never when NODE_ENV=production. `M09_STUB_PROVIDERS` is the stand-in set on its own (tests that build an engine without a database).
 */
export const M09_STUB_PROVIDERS = [
  { provide: RunStorePort, useClass: MemoryRunStore },
  { provide: ModelGatewayPort, useFactory: () => new ScriptedModelGateway({}) },
  { provide: ArtifactStorePort, useClass: MemoryArtifactStore },
  { provide: ProjectsPort, useClass: MemoryProjects },
  { provide: OrgBudgetPort, useClass: StaticOrgBudget },
];
const STUB_SWITCH = 'APPBUILDER_STUB_SWITCH';
export const M09_PORT_PROVIDERS = [
  { provide: STUB_SWITCH, useFactory: (db: Db) => makeStubSwitch(db), inject: [DB] },
  {
    provide: PgRunStore,
    useFactory: (db: Db, cfg: AiConfig) => new PgRunStore(db, cfg),
    inject: [DB, AI_CONFIG],
  },
  {
    provide: RunStorePort,
    useFactory: (real: PgRunStore, sw: StubSwitch) =>
      routed<RunStorePort>(real, new MemoryRunStore(), sw),
    inject: [PgRunStore, STUB_SWITCH],
  },
  {
    provide: ModelGatewayPort,
    useFactory: (
      g: GatewayService,
      p: ModelProviderService,
      reg: ModelAdapterRegistry,
      cfg: AiConfig,
      sw: StubSwitch,
    ): ModelGatewayPort =>
      routed<ModelGatewayPort>(
        new RealModelGateway(g, p, reg, cfg),
        new ScriptedModelGateway({}),
        sw,
      ),
    inject: [GatewayService, ModelProviderService, ModelAdapterRegistry, AI_CONFIG, STUB_SWITCH],
  },
  {
    provide: ArtifactStorePort,
    useFactory: (db: Db, cfg: AiConfig, sw: StubSwitch): ArtifactStorePort =>
      routed<ArtifactStorePort>(new PgArtifactStore(db, cfg), new MemoryArtifactStore(), sw),
    inject: [DB, AI_CONFIG, STUB_SWITCH],
  },
  {
    provide: ProjectsPort,
    useFactory: (db: Db, sw: StubSwitch): ProjectsPort =>
      routed<ProjectsPort>(new PgProjects(db), new MemoryProjects(), sw),
    inject: [DB, STUB_SWITCH],
  },
  {
    provide: OrgBudgetPort,
    useFactory: (b: BudgetService, cfg: AiConfig, sw: StubSwitch): OrgBudgetPort =>
      routed<OrgBudgetPort>(new PgOrgBudget(b, cfg), new StaticOrgBudget(), sw),
    inject: [BudgetService, AI_CONFIG, STUB_SWITCH],
  },
];

/** Production has no isolating runtime yet (D-21 OPEN): it answers "no capacity" instead of pretending. */
class UnavailableRuntime extends SandboxRuntime {
  readonly kind = 'isolated' as const;
  readonly isolation = 'none' as const;
  async freeSlots() {
    return 0;
  }
  async create(_s: RuntimeSpec): Promise<string> {
    throw new RuntimeNoCapacity();
  }
  async writeFiles(): Promise<void> {
    throw new RuntimeNoCapacity();
  }
  async readFiles(): Promise<Map<string, string>> {
    throw new RuntimeNoCapacity();
  }
  async exec(): Promise<never> {
    throw new RuntimeNoCapacity();
  }
  async stats(): Promise<never> {
    throw new RuntimeNoCapacity();
  }
  async destroy(): Promise<void> {
    /* nothing runs */
  }
}
export const makeRuntime = (env: NodeJS.ProcessEnv = process.env): SandboxRuntime =>
  env.NODE_ENV === 'production'
    ? new UnavailableRuntime()
    : env.APPBUILDER_SANDBOX_RUNTIME === 'local-dev'
      ? new LocalDevSandboxRuntime()
      : new MockSandboxRuntime();

/**
 * The customer GitHub integration (D-39). The real App is used only when the owner registered it and stored its key and webhook secret as vault
 * references (HG-AS-01): GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_REF, GITHUB_APP_WEBHOOK_SECRET_REF. Outside production the in-memory
 * fake stands in; production without the App answers 503 instead of pretending.
 */
export const STUDIO_GIT_HOST = 'STUDIO_GIT_HOST';
export interface StudioGitHost {
  adapter: GitHostAdapter | null;
}
export async function makeGitHost(
  secrets: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StudioGitHost> {
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_SLUG: appSlug,
    GITHUB_APP_PRIVATE_KEY_REF: keyRef,
    GITHUB_APP_WEBHOOK_SECRET_REF: hookRef,
  } = env;
  if (appId && appSlug && keyRef?.startsWith('vault://') && hookRef?.startsWith('vault://'))
    return {
      adapter: new GitHubAppAdapter({
        appId,
        appSlug,
        privateKeyPem: await secrets.get(keyRef),
        webhookSecret: await secrets.get(hookRef),
      }),
    };
  return { adapter: env.NODE_ENV === 'production' ? null : new FakeGitHostAdapter() };
}

class LogSecurityAlerts extends SecurityAlertPort {
  async alert(a: { kind: string; sandboxId: string | null; canaryId?: string; where: string }) {
    process.stderr.write(JSON.stringify({ securityAlert: a, at: new Date().toISOString() }) + '\n'); // wired to paging in M12
  }
}

/**
 * App builder, part A (M10A S42-S47): agent graph + approvals + budgets, generated-app scaffolds, sandbox, IDE back end (changes, Git, tests), deployments, export.
 * Feature flag `app_builder.enabled` (default OFF); M09-owned routes are stand-ins behind `app_builder.m09_stubs` (dev only). No provider and no isolating runtime is chosen
 * (D-21 OPEN): production answers 404 (M09 not connected) / 503 (no sandbox capacity).
 */
@Module({
  imports: [IdentityModule, BuilderModule, KnowledgeModule],
  controllers: [
    SandboxesController,
    TestRunsController,
    ExportsController,
    ApprovalsController,
    LivePreviewController,
    StudioInstructionsController,
    StudioProjectSkillsController,
    StudioSkillsCatalogController,
    StudioFilesController,
    StudioGithubConnectionController,
    StudioProjectGithubController,
    GithubWebhooksController,
    StudioClaudeCodeController,
    AdminSkillsController,
    StudioSettingsController,
    TemplateStartController,
    GenerationController,
  ],
  providers: [
    ...M09_PORT_PROVIDERS,
    AppBuilderEnabledGuard,
    M09StubGuard,
    StudioEnabledGuard,
    {
      provide: TemplateStartService,
      useFactory: (
        db: Db,
        t: CustomerTemplateService,
        b: ProjectService,
        p: ProjectsPort,
        c: ChangeService,
      ) => new TemplateStartService(db, t, b, p, c),
      inject: [DB, CustomerTemplateService, ProjectService, ProjectsPort, ChangeService],
    },
    // S-K6: the adaptation of a copied template
    {
      provide: GenerationService,
      useFactory: (
        db: Db,
        a: AuditSink,
        t: CustomerTemplateService,
        p: ProjectsPort,
        r: RunService,
        s: SessionService,
      ) => new GenerationService(db, a, t, p, r, s),
      inject: [DB, AuditSink, CustomerTemplateService, ProjectsPort, RunService, SessionService],
    },
    {
      provide: AgentLoopRunner,
      useFactory: (
        db: Db,
        a: AuditSink,
        g: GenerationService,
        t: TemplateAdaptRunner,
        tg: AgentToolGateway,
        gw: GatewayService,
      ) => new AgentLoopRunner(db, a, g, t, tg, gw),
      inject: [
        DB,
        AuditSink,
        GenerationService,
        TemplateAdaptRunner,
        AgentToolGateway,
        GatewayService,
      ],
    },
    {
      provide: TemplateAdaptRunner,
      useFactory: (db: Db, g: GenerationService, c: ChangeService) =>
        new TemplateAdaptRunner(db, g, c),
      inject: [DB, GenerationService, ChangeService],
    },
    // ---- AI Studio (ADR-064) --------------------------------------------------------------------------------------------------------
    {
      provide: StudioFileWriter,
      useFactory: (p: ProjectsPort, ch: ChangeService) => new StudioFileWriter(p, ch),
      inject: [ProjectsPort, ChangeService],
    },
    {
      provide: SkillSource,
      useFactory: () =>
        process.env.NODE_ENV === 'test' ? new FakeSkillSource() : new GithubPublicSkillSource(),
    },
    {
      provide: InstructionsService,
      useFactory: (db: Db, a: AuditSink, f: StudioFileWriter) => new InstructionsService(db, a, f),
      inject: [DB, AuditSink, StudioFileWriter],
    },
    {
      provide: SkillsService,
      useFactory: (db: Db, a: AuditSink, src: SkillSource, f: StudioFileWriter) =>
        new SkillsService(db, a, src, f),
      inject: [DB, AuditSink, SkillSource, StudioFileWriter],
    },
    {
      provide: STUDIO_GIT_HOST,
      useFactory: (s: SecretStore) => makeGitHost(s),
      inject: [SecretStore],
    },
    {
      provide: GitHubService,
      useFactory: (db: Db, a: AuditSink, p: ProjectsPort, f: StudioFileWriter, h: StudioGitHost) =>
        new GitHubService(db, a, p, f, h.adapter, process.env.STUDIO_STATE_KEY),
      inject: [DB, AuditSink, ProjectsPort, StudioFileWriter, STUDIO_GIT_HOST],
    },
    {
      provide: StudioSettingsService,
      useFactory: (db: Db, a: AuditSink) => new StudioSettingsService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: ClaudeCodeService,
      useFactory: (db: Db, a: AuditSink, s: SandboxService) => new ClaudeCodeService(db, a, s),
      inject: [DB, AuditSink, SandboxService],
    },
    { provide: SandboxRuntime, useFactory: () => makeRuntime() },
    {
      provide: SecurityAlertPort,
      useFactory: () =>
        process.env.NODE_ENV === 'test' ? new MemorySecurityAlerts() : new LogSecurityAlerts(),
    },
    {
      provide: CanaryRegistry,
      useFactory: (a: SecurityAlertPort) => new CanaryRegistry(a),
      inject: [SecurityAlertPort],
    },
    { provide: AdvisoryDbPort, useFactory: () => new StaticAdvisoryDb() },
    { provide: ReleaseStorePort, useClass: MemoryReleaseStore },
    {
      provide: DeployTargetPort,
      useFactory: (db: Db, pub: SitePublisherPort, r: ReleaseStorePort, sw: StubSwitch) =>
        routed<DeployTargetPort>(
          new SitePublisherDeployTarget(db, pub, r),
          new DevStaticTarget(),
          sw,
        ),
      inject: [DB, SitePublisherPort, ReleaseStorePort, STUB_SWITCH],
    },
    {
      provide: HealthProbePort,
      useFactory: () =>
        new HttpHealthProbe(async (h) =>
          (await dns.lookup(h, { all: true })).map((x) => x.address),
        ),
    },
    {
      provide: GitStore,
      useFactory: () =>
        new GitStore(process.env.APPBUILDER_GIT_ROOT ?? join(tmpdir(), 'nuzm-appbuilder-git')),
    },
    {
      provide: EgressPolicy,
      useFactory: () =>
        new EgressPolicy(DEFAULT_ALLOW, async (h) =>
          (await dns.lookup(h, { all: true })).map((x) => x.address),
        ),
    },
    {
      provide: ApprovalService,
      useFactory: (db: Db, a: AuditSink) => new ApprovalService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: AppSpecService,
      useFactory: (db: Db, a: AuditSink) => new AppSpecService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: WebappLivePreviewService,
      useFactory: (db: Db, a: AuditSink, s: AppSpecService, r: LivePreviewRegistry) =>
        new WebappLivePreviewService(db, a, s, r),
      inject: [DB, AuditSink, AppSpecService, LivePreviewRegistry],
    },
    { provide: EvaluationService, useFactory: (db: Db) => new EvaluationService(db), inject: [DB] },
    {
      provide: SandboxService,
      useFactory: (
        db: Db,
        a: AuditSink,
        rt: SandboxRuntime,
        res: ResidencyService,
        ob: OrgBudgetPort,
        c: CanaryRegistry,
      ) => new SandboxService(db, a, rt, res, ob, c, DEFAULT_SANDBOX_CONFIG),
      inject: [DB, AuditSink, SandboxRuntime, ResidencyService, OrgBudgetPort, CanaryRegistry],
    },
    {
      provide: SandboxJobs,
      useFactory: (db: Db, s: SandboxService, ap: ApprovalService) => new SandboxJobs(db, s, ap),
      inject: [DB, SandboxService, ApprovalService],
    },
    {
      provide: ChangeService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: ProjectsPort,
        g: GitStore,
        c: CanaryRegistry,
        adv: AdvisoryDbPort,
      ) => new ChangeService(db, a, p, g, c, adv),
      inject: [DB, AuditSink, ProjectsPort, GitStore, CanaryRegistry, AdvisoryDbPort],
    },
    {
      provide: TestRunService,
      useFactory: (
        db: Db,
        a: AuditSink,
        s: SandboxService,
        p: ProjectsPort,
        ar: ArtifactStorePort,
        c: CanaryRegistry,
        adv: AdvisoryDbPort,
      ) => new TestRunService(db, a, s, p, ar, c, adv),
      inject: [
        DB,
        AuditSink,
        SandboxService,
        ProjectsPort,
        ArtifactStorePort,
        CanaryRegistry,
        AdvisoryDbPort,
      ],
    },
    {
      provide: TestFixService,
      useFactory: (
        a: AuditSink,
        r: RunStorePort,
        g: ModelGatewayPort,
        ob: OrgBudgetPort,
        t: TestRunService,
        ch: ChangeService,
        p: ProjectsPort,
      ) => new TestFixService(a, r, g, ob, t, ch, p),
      inject: [
        AuditSink,
        RunStorePort,
        ModelGatewayPort,
        OrgBudgetPort,
        TestRunService,
        ChangeService,
        ProjectsPort,
      ],
    },
    {
      provide: AppDeploymentService,
      useFactory: (
        db: Db,
        a: AuditSink,
        ap: ApprovalService,
        t: DeployTargetPort,
        r: ReleaseStorePort,
        h: HealthProbePort,
        s: SandboxService,
        p: ProjectsPort,
        c: CanaryRegistry,
        res: ResidencyService,
        adv: AdvisoryDbPort,
      ) => new AppDeploymentService(db, a, ap, t, r, h, s, p, c, res, adv, DEFAULT_DEPLOY_CONFIG),
      inject: [
        DB,
        AuditSink,
        ApprovalService,
        DeployTargetPort,
        ReleaseStorePort,
        HealthProbePort,
        SandboxService,
        ProjectsPort,
        CanaryRegistry,
        ResidencyService,
        AdvisoryDbPort,
      ],
    },
    {
      provide: ExportService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: ProjectsPort,
        r: ReleaseStorePort,
        ar: ArtifactStorePort,
        ap: ApprovalService,
        c: CanaryRegistry,
        res: ResidencyService,
        adv: AdvisoryDbPort,
      ) => new ExportService(db, a, p, r, ar, ap, c, res, adv),
      inject: [
        DB,
        AuditSink,
        ProjectsPort,
        ReleaseStorePort,
        ArtifactStorePort,
        ApprovalService,
        CanaryRegistry,
        ResidencyService,
        AdvisoryDbPort,
      ],
    },
    {
      provide: GraphRunner,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: RunStorePort,
        ar: ArtifactStorePort,
        g: ModelGatewayPort,
        ob: OrgBudgetPort,
        ap: ApprovalService,
        specs: AppSpecService,
        p: ProjectsPort,
        adv: AdvisoryDbPort,
      ) =>
        new GraphRunner(
          db,
          a,
          r,
          ar,
          g,
          ob,
          ap,
          webappExecutors({ specs, projects: p, advisories: adv }),
          DEFAULT_RUNNER_CONFIG,
        ),
      inject: [
        DB,
        AuditSink,
        RunStorePort,
        ArtifactStorePort,
        ModelGatewayPort,
        OrgBudgetPort,
        ApprovalService,
        AppSpecService,
        ProjectsPort,
        AdvisoryDbPort,
      ],
    },
    {
      provide: AppRunService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: RunStorePort,
        p: ProjectsPort,
        ob: OrgBudgetPort,
        g: GraphRunner,
        tf: TestFixService,
        ap: ApprovalService,
        engine: RunService,
      ) => new AppRunService(db, a, r, p, ob, g, tf, ap, undefined, engine),
      inject: [
        DB,
        AuditSink,
        RunStorePort,
        ProjectsPort,
        OrgBudgetPort,
        GraphRunner,
        TestFixService,
        ApprovalService,
        RunService,
      ],
    },
  ],
  exports: [
    ApprovalService,
    AppSpecService,
    SandboxService,
    ChangeService,
    TestRunService,
    AppDeploymentService,
    ExportService,
    AppRunService,
    GraphRunner,
    EvaluationService,
    SkillsService,
    InstructionsService,
    GitHubService,
    STUDIO_GIT_HOST,
  ],
})
export class AppBuilderModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(SandboxJobs) private readonly jobs: SandboxJobs,
    @Inject(RunKindRegistry) private readonly registry: RunKindRegistry,
    @Inject(PgRunStore) private readonly store: PgRunStore,
    @Inject(ProjectsPort) private readonly projects: ProjectsPort,
    @Inject(GraphRunner) private readonly graph: GraphRunner,
    @Inject(TestFixService) private readonly testFix: TestFixService,
    @Inject(AppRunService) _runs: AppRunService, // constructed at start: it listens for approval decisions
    @Inject(ProjectDelegates) private readonly projectDelegates: ProjectDelegates,
    @Inject(DeployService) private readonly deployService: DeployService,
    @Inject(ChangeService) private readonly changes: ChangeService,
    @Inject(AppDeploymentService) private readonly deployments: AppDeploymentService,
    @Inject(DB) private readonly db: Db,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(TemplateAdaptRunner) private readonly adapt: TemplateAdaptRunner,
    @Inject(AgentLoopRunner) private readonly agentLoop: AgentLoopRunner,
    @Inject(AgentWorkspaceRegistry) private readonly agentWorkspaces: AgentWorkspaceRegistry,
    @Inject(GenerationService) private readonly generation: GenerationService,
  ) {}
  onApplicationBootstrap() {
    // the run kinds, the safe-diff changes and the deployments of web-app projects join M09's registries (M09 contract §3; the paths stay M09's)
    this.registry.register(
      new WebappRunHandler(this.store, this.projects, this.graph, this.adapt, this.agentLoop),
    );
    // S-AG2: the read-only agent tools read a web-app project through this provider (and nothing else)
    this.agentWorkspaces.register('webapp', new AgentProjectWorkspace(this.generation));
    this.registry.register(new TestFixRunHandler(this.store, this.projects, this.testFix));
    this.projectDelegates.register(
      'webapp',
      new WebappChangesDelegate(this.db, this.projects, this.changes),
    );
    this.deployService.webapp = new WebappDeployDelegateImpl(
      this.db,
      this.projects,
      this.deployments,
    );
    this.jobs.start();
    // the Nuzm-owned starter skills (idempotent; a failure is logged and retried on the next start, it never blocks the API)
    void this.skills
      .ensureBuiltins()
      .catch((e: unknown) =>
        process.stderr.write(
          JSON.stringify({ msg: 'ai studio builtins not seeded', error: String(e) }) + '\n',
        ),
      );
  }
  onApplicationShutdown() {
    this.jobs.stop();
  }
}
