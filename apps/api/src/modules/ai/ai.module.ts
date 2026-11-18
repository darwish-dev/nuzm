import { Global, Module } from '@nestjs/common';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { LedgerPostingService } from '../billing';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { AdminAiProvidersController } from './admin-ai-providers.controller';
import { AiModelsController } from './ai-models.controller';
import { AiEnabledGuard } from './internal/ai-enabled.guard';
import { BudgetService } from './internal/budget.service';
import { AiFlags } from './internal/flags';
import { GatewayService } from './internal/gateway.service';
import { AI_CONFIG, loadAiConfig, type AiConfig } from './internal/model';
import { ModelProviderService } from './internal/provider.service';
import { ModelAdapterRegistry, StaticModelAdapterRegistry } from './internal/registry';

void OperationsService;

/**
 * AI core (M09): model gateway, budgets/credits, providers. No provider is chosen here (D-18 OPEN): the registry is EMPTY unless `AI_LOCAL_REFERENCE=true` outside
 * production, which registers the deterministic MOCK model (`mock-model`, plumbing only, NOT VERIFIED quality). Production therefore answers 422
 * `unsupported_capability` for every AI call until a provider is decided, its data terms attested by a human and a second person enables it.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [AiModelsController, AdminAiProvidersController],
  providers: [
    { provide: AI_CONFIG, useFactory: () => loadAiConfig() },
    {
      provide: ModelAdapterRegistry,
      useFactory: (cfg: AiConfig) => {
        const r = new StaticModelAdapterRegistry();
        if (cfg.localReference)
          r.register('mock-model', new MockModelAdapter({ id: 'mock-model' }));
        return r;
      },
      inject: [AI_CONFIG],
    },
    { provide: AiFlags, useFactory: (db: Db) => new AiFlags(db), inject: [DB] },
    AiEnabledGuard,
    {
      provide: ModelProviderService,
      useFactory: (db: Db, a: AuditSink, r: ModelAdapterRegistry, cfg: AiConfig) =>
        new ModelProviderService(db, a, r, cfg),
      inject: [DB, AuditSink, ModelAdapterRegistry, AI_CONFIG],
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
  ],
  exports: [
    AI_CONFIG,
    ModelAdapterRegistry,
    AiFlags,
    AiEnabledGuard,
    ModelProviderService,
    BudgetService,
    GatewayService,
  ],
})
export class AiModule {}
