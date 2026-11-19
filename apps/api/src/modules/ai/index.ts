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
export { RunService, actionHash } from './internal/run.service';
export type { RunDto } from './internal/run.service';
export { SessionService } from './internal/session.service';
export { AiJobs } from './internal/jobs';
export {
  RunKindRegistry,
  StaticRunKindRegistry,
  WorkerCrash,
  SegmentSuspend,
} from './internal/run-kinds';
export type {
  RunKindHandler,
  RunContext,
  RunRow,
  AgentCall,
  ResumedWith,
  ApprovalKind,
} from './internal/run-kinds';
export { UrlFetchPort, SafeUrlFetcher } from './internal/url-fetcher';
export type { AgentTask } from './internal/run-kinds';
export { EvaluationService } from './internal/evaluation.service';
