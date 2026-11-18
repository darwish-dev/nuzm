// Public surface of the automation module (M11 S51-S52).
export { AutomationModule } from './automation.module';
export { WorkflowService } from './internal/workflow.service';
export type { WorkflowDto, VersionDto } from './internal/workflow.service';
export { ExecutionService } from './internal/execution.service';
export type { ExecutionDto } from './internal/execution.service';
export { ExecutionEngine, SimulatedCrash, EXECUTION_OP_KIND } from './internal/engine';
export type { EngineHooks, CrashPoint, RunResult } from './internal/engine';
export { ConnectorService } from './internal/connector.service';
export type { ConnectorDto, ResolvedConnector } from './internal/connector.service';
export { WebhookEndpointService } from './internal/webhook-endpoint.service';
export { TriggerService } from './internal/trigger.service';
export { AbuseService } from './internal/abuse.service';
export { AutomationJobs } from './internal/jobs';
export { ActionRunner } from './internal/actions';
export {
  ActionError,
  AiRunPort,
  DeploymentPort,
  EgressHttpPort,
  EmailSendPort,
  NuzmApiPort,
  TargetResidencyPort,
} from './internal/ports';
export {
  ALLOWED_EVENT_TOPICS,
  AUTOMATION_CONFIG,
  loadAutomationConfig,
  tenantSecretId,
  isTenantRef,
} from './internal/model';
export type { AutomationConfig } from './internal/model';
export { FlagReader } from '../../common/feature-flags';
