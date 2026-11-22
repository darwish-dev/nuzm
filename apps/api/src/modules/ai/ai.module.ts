import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AnthropicModelAdapter, CLAUDE_PROVIDER_ID, MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { LedgerPostingService } from '../billing';
import { ResidencyService } from '../compliance';
import { SecretStore } from '../../common/secrets';
import { AccessModule, PolicyService } from '../access';
import { IdentityModule } from '../identity';
import { AdminAiProvidersController } from './admin-ai-providers.controller';
import { AdminAiRunsController } from './admin-ai-runs.controller';
import { AdminAiQualityController } from './admin-ai-quality.controller';
import { EvaluationService } from './internal/evaluation.service';
import { AiModelsController } from './ai-models.controller';
import { AiRunsController } from './ai-runs.controller';
import { AiSessionsController } from './ai-sessions.controller';
import { ChatRunHandler } from './internal/chat.handler';
import { AiJobs } from './internal/jobs';
import { RunKindRegistry, StaticRunKindRegistry } from './internal/run-kinds';
import { RunService } from './internal/run.service';
import { SessionService } from './internal/session.service';
import { SafeUrlFetcher, UrlFetchPort } from './internal/url-fetcher';
import { AiEnabledGuard } from './internal/ai-enabled.guard';
import { BudgetService } from './internal/budget.service';
import { AiFlags } from './internal/flags';
import { GatewayService } from './internal/gateway.service';
import { AgentToolGateway } from './internal/agent-tools.service';
import { AgentWorkspaceRegistry, StaticAgentWorkspaceRegistry } from './internal/agent-workspace';
import { AI_CONFIG, loadAiConfig, type AiConfig } from './internal/model';
import { probeAnthropic } from './internal/claude-probe';
import { ModelProviderService } from './internal/provider.service';
import { ModelAdapterRegistry, StaticModelAdapterRegistry } from './internal/registry';

/**
 * AI core (M09): model gateway, budgets/credits, providers. No provider is chosen here (D-18 OPEN): the registry is EMPTY unless `AI_LOCAL_REFERENCE=true` outside
 * production, which registers the deterministic MOCK model (`mock-model`, plumbing only, NOT VERIFIED quality). Production therefore answers 422
 * `unsupported_capability` for every AI call until a provider is decided, its data terms attested by a human and a second person enables it.
 */
@Global()
@Module({
  imports: [IdentityModule, AccessModule],
  controllers: [
    AiModelsController,
    AdminAiProvidersController,
    AiSessionsController,
    AiRunsController,
    AdminAiRunsController,
    AdminAiQualityController,
  ],
  providers: [
    { provide: AI_CONFIG, useFactory: () => loadAiConfig() },
    {
      provide: ModelAdapterRegistry,
      useFactory: (cfg: AiConfig, db: Db, secrets: SecretStore) => {
        const r = new StaticModelAdapterRegistry();
        if (cfg.localReference)
          r.register(
            'mock-model',
            new MockModelAdapter({ id: 'mock-model', handler: (req) => mockModelHandler(req) }),
          );
        // Claude: registered only OUTSIDE production. A key can be stored only there (the production vault is not decided, D-12), and the adapter is not
        // enough to serve a request: the provider still needs a rate card, a human attestation, a second person's approval and a residency assessment.
        if (process.env.NODE_ENV !== 'production')
          r.register(
            CLAUDE_PROVIDER_ID,
            new AnthropicModelAdapter({
              getApiKey: async () => {
                const row = await db.withPlatformScope(
                  async (c) =>
                    (
                      await c.query(`SELECT vault_ref FROM ai.model_providers WHERE code=$1`, [
                        CLAUDE_PROVIDER_ID,
                      ])
                    ).rows[0] as { vault_ref: string | null } | undefined,
                );
                const ref = row?.vault_ref ?? null;
                return ref && /^vault:\/\/(dev|mem)\/ai-/.test(ref) ? secrets.get(ref) : null;
              },
            }),
          );
        return r;
      },
      inject: [AI_CONFIG, DB, SecretStore],
    },
    { provide: AiFlags, useFactory: (db: Db) => new AiFlags(db), inject: [DB] },
    AiEnabledGuard,
    {
      provide: ModelProviderService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: ModelAdapterRegistry,
        cfg: AiConfig,
        sec: SecretStore,
      ) => new ModelProviderService(db, a, r, cfg, sec, probeAnthropic),
      inject: [DB, AuditSink, ModelAdapterRegistry, AI_CONFIG, SecretStore],
    },
    {
      provide: BudgetService,
      useFactory: (db: Db, a: AuditSink, cfg: AiConfig) => new BudgetService(db, a, cfg),
      inject: [DB, AuditSink, AI_CONFIG],
    },
    {
      provide: GatewayService,
      useFactory: (
        db: Db,
        a: AuditSink,
        f: AiFlags,
        r: ModelAdapterRegistry,
        p: ModelProviderService,
        b: BudgetService,
        res: ResidencyService,
        l: LedgerPostingService,
        ci: FieldCipher,
        cfg: AiConfig,
      ) => new GatewayService(db, a, f, r, p, b, res, l, ci, cfg),
      inject: [
        DB,
        AuditSink,
        AiFlags,
        ModelAdapterRegistry,
        ModelProviderService,
        BudgetService,
        ResidencyService,
        LedgerPostingService,
        FieldCipher,
        AI_CONFIG,
      ],
    },
    { provide: UrlFetchPort, useFactory: () => new SafeUrlFetcher() },
    // D-46 / S-AG2: the read-only agent tool gateway and the registry the app builder fills with its project workspaces
    { provide: AgentWorkspaceRegistry, useFactory: () => new StaticAgentWorkspaceRegistry() },
    {
      provide: AgentToolGateway,
      useFactory: (
        db: Db,
        a: AuditSink,
        f: AiFlags,
        p: PolicyService,
        w: AgentWorkspaceRegistry,
        cfg: AiConfig,
      ) => new AgentToolGateway(db, a, f, p, w, cfg),
      inject: [DB, AuditSink, AiFlags, PolicyService, AgentWorkspaceRegistry, AI_CONFIG],
    },
    {
      provide: RunKindRegistry,
      useFactory: () => {
        const r = new StaticRunKindRegistry();
        r.register(new ChatRunHandler());
        return r;
      },
    },
    {
      provide: SessionService,
      useFactory: (db: Db, a: AuditSink, ci: FieldCipher, cfg: AiConfig) =>
        new SessionService(db, a, ci, cfg),
      inject: [DB, AuditSink, FieldCipher, AI_CONFIG],
    },
    {
      provide: RunService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        r: RunKindRegistry,
        g: GatewayService,
        s: SessionService,
        f: UrlFetchPort,
        cfg: AiConfig,
      ) => new RunService(db, a, o, r, g, s, f, cfg),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        RunKindRegistry,
        GatewayService,
        SessionService,
        UrlFetchPort,
        AI_CONFIG,
      ],
    },
    {
      provide: EvaluationService,
      useFactory: (db: Db, a: AuditSink, cfg: AiConfig) => new EvaluationService(db, a, cfg),
      inject: [DB, AuditSink, AI_CONFIG],
    },
    {
      provide: AiJobs,
      useFactory: (db: Db, r: RunService, b: BudgetService) => new AiJobs(db, r, b),
      inject: [DB, RunService, BudgetService],
    },
  ],
  exports: [
    AI_CONFIG,
    ModelAdapterRegistry,
    AiFlags,
    AiEnabledGuard,
    ModelProviderService,
    BudgetService,
    GatewayService,
    RunKindRegistry,
    RunService,
    SessionService,
    EvaluationService,
    AiJobs,
    UrlFetchPort,
    AgentToolGateway,
    AgentWorkspaceRegistry,
  ],
})
export class AiModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(AiJobs) private readonly jobs: AiJobs) {}
  onApplicationBootstrap() {
    this.jobs.start(AiJobs.intervalFromEnv());
  }
  onApplicationShutdown() {
    this.jobs.stop();
  }
}
