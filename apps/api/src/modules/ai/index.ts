// Public surface of the ai module (M09). Other modules import ONLY from here.
export { AiModule } from './ai.module';
export { GatewayService } from './internal/gateway.service';
export { BudgetService, BudgetDenied, withDeadlockRetry } from './internal/budget.service';
export { ModelProviderService } from './internal/provider.service';
export { KillSwitchDrillService } from './internal/kill-switch-drill.service';
export { runKillSwitchDrill, KILL_SWITCH_BOUND_MS } from './internal/kill-switch-drill';
export type { DrillReport, DrillStep } from './internal/kill-switch-drill';
export { ProviderInsightsService } from './internal/provider-insights.service';
export type {
  DiscoveryResult,
  UsageGroupBy,
  UsageReport,
  UsageReportQuery,
  UsageReportRow,
} from './internal/provider-insights.service';
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
export { AgentToolGateway, redactArgs } from './internal/agent-tools.service';
export type {
  RequestedToolCall,
  ToolBatch,
  ToolCallContext,
  ToolOutcome,
} from './internal/agent-tools.service';
export { AgentWorkspaceRegistry, StaticAgentWorkspaceRegistry } from './internal/agent-workspace';
export type { AgentWorkspaceProvider } from './internal/agent-workspace';
export { AI_AGENT_EXEC_TOOLS_FLAG, AI_AGENT_READ_TOOLS_FLAG } from './internal/flags';
export { AiContentAccess, AI_CONTENT_OPERATIONS } from './internal/ai-content-access.service';
export type { AiContentOperation } from './internal/ai-content-access.service';
