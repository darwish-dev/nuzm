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
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { ApprovalsController } from './approvals.controller';
import { ExportsController } from './exports.controller';
import { SandboxesController } from './sandboxes.controller';
import { TestRunsController } from './test-runs.controller';
import { webappExecutors } from './internal/agents/webapp-agents';
import { ApprovalService } from './internal/approvals/approval.service';
import { ChangeService } from './internal/changes/change.service';
import { AppDeploymentService, DEFAULT_DEPLOY_CONFIG } from './internal/deploy/deployment.service';
import {
  DeployTargetPort,
  DevStaticTarget,
  HealthProbePort,
  HttpHealthProbe,
  MemoryReleaseStore,
  ReleaseStorePort,
} from './internal/deploy/ports';
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

/**
 * THE ONE WIRING CHANGE TO INTEGRATE M09 (docs/reports/M10-m09-interface-assumptions.md): replace these five providers with the M09 services that implement the
 * abstract classes of `internal/ports/m09.ts` (RunStorePort -> `ai.runs`, ModelGatewayPort -> the gateway, ArtifactStorePort -> `ai.artifacts`, ProjectsPort ->
 * `builder.projects/project_files/project_versions`, OrgBudgetPort -> `ai.credit_balances`). Nothing else in this module names an M09 type.
 */
export const M09_PORT_PROVIDERS = [
  { provide: RunStorePort, useClass: MemoryRunStore },
  { provide: ModelGatewayPort, useFactory: () => new ScriptedModelGateway({}) },
  { provide: ArtifactStorePort, useClass: MemoryArtifactStore },
  { provide: ProjectsPort, useClass: MemoryProjects },
  { provide: OrgBudgetPort, useClass: StaticOrgBudget },
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
  imports: [IdentityModule],
  controllers: [SandboxesController, TestRunsController, ExportsController, ApprovalsController],
  providers: [
    ...M09_PORT_PROVIDERS,
    AppBuilderEnabledGuard,
    M09StubGuard,
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
    { provide: DeployTargetPort, useClass: DevStaticTarget },
    { provide: ReleaseStorePort, useClass: MemoryReleaseStore },
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
      useFactory: (db: Db, s: SandboxService) => new SandboxJobs(db, s),
      inject: [DB, SandboxService],
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
      ) => new AppRunService(db, a, r, p, ob, g, tf, ap),
      inject: [
        DB,
        AuditSink,
        RunStorePort,
        ProjectsPort,
        OrgBudgetPort,
        GraphRunner,
        TestFixService,
        ApprovalService,
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
  ],
})
export class AppBuilderModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(SandboxJobs) private readonly jobs: SandboxJobs) {}
  onApplicationBootstrap() {
    this.jobs.start();
  }
  onApplicationShutdown() {
    this.jobs.stop();
  }
}
