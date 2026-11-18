import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import { AdminAgentsController } from './admin-agents.controller';
import { AdminNodesController } from './admin-nodes.controller';
import { CloudPanelHostingAdapter } from './internal/cloudpanel-adapter';
import { loadHostingConfig, type HostingConfig } from './internal/config';
import { InMemoryComputeProvisioning } from './internal/mock/mocks';
import { NodesService } from './internal/nodes.service';
import { COMPUTE_PROVISIONING, type CloudPanelTransport, type ComputeProvisioningPort, type HostingAdapter } from './internal/ports';
import { HOSTING_ADAPTER, HOSTING_CONFIG } from './internal/tokens';

/** Until a real node agent channel exists (HG-06-01) the transport answers `uncertain`/unavailable: nothing is simulated in a running API. */
class UnavailableTransport implements CloudPanelTransport {
  readonly mode = 'node-agent' as const;
  async send() {
    return { status: 'failed' as const, reason: 'unsupported', result: 'the node agent channel is not configured', rawSummary: 'no agent channel' };
  }
}

/**
 * Shared hosting (M06). Everything M05/M07/M08 will provide is a PORT with a mock default (docs/reports/M06-m05-interface-assumptions.md);
 * tests replace the ports through `overrideProvider`. Production wiring of the real ports is a one-line change per provider.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [AdminNodesController, AdminAgentsController],
  providers: [
    { provide: HOSTING_CONFIG, useFactory: () => loadHostingConfig() },
    { provide: HOSTING_ADAPTER, useFactory: () => new CloudPanelHostingAdapter(new UnavailableTransport()) },
    { provide: COMPUTE_PROVISIONING, useFactory: () => new InMemoryComputeProvisioning() },
    {
      provide: NodesService,
      useFactory: (db: Db, a: AuditSink, ad: HostingAdapter, cp: ComputeProvisioningPort, cfg: HostingConfig) => new NodesService(db, a, ad, cp, cfg),
      inject: [DB, AuditSink, HOSTING_ADAPTER, COMPUTE_PROVISIONING, HOSTING_CONFIG],
    },
  ],
  exports: [NodesService, HOSTING_ADAPTER, HOSTING_CONFIG, COMPUTE_PROVISIONING],
})
export class HostingModule {}
