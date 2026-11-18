// Public surface of the ai module (M09). Other modules import ONLY from here.
export { AiModule } from './ai.module';
export { GatewayService } from './internal/gateway.service';
export { BudgetService, BudgetDenied } from './internal/budget.service';
export { ModelProviderService } from './internal/provider.service';
export { ModelAdapterRegistry, StaticModelAdapterRegistry } from './internal/registry';
export { AiFlags } from './internal/flags';
export { AiEnabledGuard } from './internal/ai-enabled.guard';
export { AI_CONFIG, loadAiConfig } from './internal/model';
export type { AiConfig, GatewayCall, GatewayResult } from './internal/model';
