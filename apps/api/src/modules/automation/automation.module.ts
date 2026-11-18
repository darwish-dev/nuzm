import { Global, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { OperationsService, type Db } from '@nuzm/platform';
import { SafeHttpClient } from '@nuzm/domain';
import { AuditSink } from '../../common/audit';
import { FlagReader } from '../../common/feature-flags';
import { SecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import { QuotaService } from '../billing';
import { ResidencyService } from '../compliance';
import { MessageService } from '../email';
import { IdentityModule } from '../identity';
import { NotificationService } from '../notifications';
import { ConnectorsController } from './connectors.controller';
import { WebhookEndpointsController } from './webhook-endpoints.controller';
import { WorkflowExecutionsController } from './workflow-executions.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowWebhookController } from './workflow-webhook.controller';
import { AbuseService } from './internal/abuse.service';
import { ActionRunner } from './internal/actions';
import { ConnectorService } from './internal/connector.service';
import { GuardedEgressPort, MessageEmailPort, ResidencyTargetPort } from './internal/default-ports';
import { ExecutionEngine } from './internal/engine';
import { ExecutionService } from './internal/execution.service';
import { AutomationJobs } from './internal/jobs';
import { AUTOMATION_CONFIG, loadAutomationConfig, type AutomationConfig } from './internal/model';
import { AiRunPort, DeploymentPort, EgressHttpPort, EmailSendPort, HttpNuzmApiPort, NuzmApiPort, TargetResidencyPort, UnavailableAiRunPort, UnavailableDeploymentPort } from './internal/ports';
import { TriggerService } from './internal/trigger.service';
import { WebhookEndpointService } from './internal/webhook-endpoint.service';
import { WorkflowService } from './internal/workflow.service';

/**
 * Automation (M11 S51-S52): workflow definitions and versions, the durable execution engine, connectors, outbound webhooks and the abuse rules. Everything default OFF
 * (`automation.enabled`, `webhooks.enabled`). The ports for AI runs and deployments are the "unavailable" implementations until M09 is wired (one provider swap each).
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [WorkflowsController, WorkflowExecutionsController, ConnectorsController, WebhookEndpointsController, WorkflowWebhookController],
  providers: [
    { provide: AUTOMATION_CONFIG, useFactory: () => loadAutomationConfig() },
    { provide: FlagReader, useFactory: (db: Db) => new FlagReader(db), inject: [DB] },
    { provide: EgressHttpPort, useFactory: () => new GuardedEgressPort() },
    { provide: NuzmApiPort, useFactory: () => new HttpNuzmApiPort() },
    { provide: AiRunPort, useClass: UnavailableAiRunPort },
    { provide: DeploymentPort, useClass: UnavailableDeploymentPort },
    { provide: EmailSendPort, useFactory: (m: MessageService) => new MessageEmailPort(m), inject: [MessageService] },
    { provide: TargetResidencyPort, useFactory: (r: ResidencyService) => new ResidencyTargetPort(r), inject: [ResidencyService] },
    { provide: ConnectorService, useFactory: (db: Db, a: AuditSink, s: SecretStore) => new ConnectorService(db, a, s, new SafeHttpClient()), inject: [DB, AuditSink, SecretStore] },
    { provide: WorkflowService, useFactory: (db: Db, a: AuditSink, s: SecretStore) => new WorkflowService(db, a, s), inject: [DB, AuditSink, SecretStore] },
    { provide: ExecutionService, useFactory: (db: Db, a: AuditSink, o: OperationsService, q: QuotaService, c: AutomationConfig) => new ExecutionService(db, a, o, q, c), inject: [DB, AuditSink, OperationsService, QuotaService, AUTOMATION_CONFIG] },
    {
      provide: ActionRunner,
      useFactory: (cn: ConnectorService, e: EgressHttpPort, n: NuzmApiPort, em: EmailSendPort, ai: AiRunPort, dp: DeploymentPort, r: TargetResidencyPort, c: AutomationConfig, fl: FlagReader) =>
        new ActionRunner(cn, e, n, em, ai, dp, r, c, async (orgId) => {
          const v = (await fl.value(orgId, 'automation.egress')) as { allow?: string[]; deny?: string[] } | undefined;
          return { allowHosts: v?.allow, denyHosts: v?.deny };
        }),
      inject: [ConnectorService, EgressHttpPort, NuzmApiPort, EmailSendPort, AiRunPort, DeploymentPort, TargetResidencyPort, AUTOMATION_CONFIG, FlagReader],
    },
    { provide: ExecutionEngine, useFactory: (db: Db, o: OperationsService, a: AuditSink, ar: ActionRunner, c: AutomationConfig) => new ExecutionEngine(db, o, a, ar, c), inject: [DB, OperationsService, AuditSink, ActionRunner, AUTOMATION_CONFIG] },
    {
      provide: AbuseService,
      useFactory: (db: Db, a: AuditSink, c: AutomationConfig, n: NotificationService) =>
        new AbuseService(db, a, c, async (orgId, kind, params) => {
          const ids = (await db.withOrg(orgId, async (cl) => (await cl.query(`SELECT DISTINCT m.user_id FROM tenancy.memberships m JOIN tenancy.role_permissions rp ON rp.role = m.role AND rp.permission = 'automation:write' WHERE m.org_id = $1`, [orgId])).rows)) as { user_id: string }[];
          for (const r of ids) await n.notify({ orgId, userId: r.user_id, kind, params });
        }),
      inject: [DB, AuditSink, AUTOMATION_CONFIG, NotificationService],
    },
    { provide: TriggerService, useFactory: (db: Db, s: SecretStore, e: ExecutionService, ab: AbuseService, c: AutomationConfig) => new TriggerService(db, s, e, ab, c), inject: [DB, SecretStore, ExecutionService, AbuseService, AUTOMATION_CONFIG] },
    { provide: WebhookEndpointService, useFactory: (db: Db, a: AuditSink, s: SecretStore, e: EgressHttpPort) => new WebhookEndpointService(db, a, s, e), inject: [DB, AuditSink, SecretStore, EgressHttpPort] },
    {
      provide: AutomationJobs,
      useFactory: (db: Db, o: OperationsService, en: ExecutionEngine, ex: ExecutionService, t: TriggerService, w: WebhookEndpointService, ab: AbuseService) => new AutomationJobs(db, o, en, ex, t, w, ab),
      inject: [DB, OperationsService, ExecutionEngine, ExecutionService, TriggerService, WebhookEndpointService, AbuseService],
    },
  ],
  exports: [ConnectorService, WorkflowService, ExecutionService, ExecutionEngine, TriggerService, WebhookEndpointService, AbuseService, AutomationJobs, ActionRunner, FlagReader, AiRunPort, DeploymentPort, EgressHttpPort, NuzmApiPort, EmailSendPort, TargetResidencyPort],
})
export class AutomationModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(private readonly jobs: AutomationJobs) {}
  onApplicationBootstrap() {
    this.jobs.start(AutomationJobs.intervalFromEnv());
  }
  onModuleDestroy() {
    this.jobs.stop();
  }
}
