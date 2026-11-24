import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AI_CONFIG, type AiConfig } from '../ai';
import { CmsService } from '../builder';
import { ResidencyService } from '../compliance';
import { DeploymentsController } from './deployments.controller';
import {
  DEPLOY_CONFIG,
  DeployService,
  loadDeployConfig,
  type DeployConfig,
} from './internal/deploy.service';
import { DeployPolicyService } from './internal/policy.service';
import {
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  InMemoryHostingSiteOps,
} from './internal/hosting-target';
import { SIMULATED_STAGING_TARGET } from './internal/targets';
import {
  InMemorySitePublisher,
  SitePublisherPort,
  UnavailableSitePublisher,
} from './internal/ports';

/**
 * Deployments (M09): publish a builder project to a hosting site. The M06 HostingAdapter has no deploy method, so the publish path is the `SitePublisherPort`: EMPTY
 * (`UnavailableSitePublisher`, 422 `unsupported_capability`) unless `AI_LOCAL_REFERENCE=true` outside production registers the in-memory fake node (NOT VERIFIED).
 */
@Global()
@Module({
  controllers: [DeploymentsController],
  providers: [
    { provide: DEPLOY_CONFIG, useFactory: () => loadDeployConfig() },
    {
      provide: SitePublisherPort,
      // `DEPLOY_PUBLISHER=releases` (local reference only) swaps in the release-layout target on the in-memory node: versioned releases, integrity read-back, atomic switch.
      // Still SIMULATED. A real hosting node needs an artifact upload path that does not exist yet (HG-05); until then production has no publisher.
      useFactory: (cfg: AiConfig) =>
        !cfg.localReference
          ? new UnavailableSitePublisher()
          : process.env.DEPLOY_PUBLISHER === 'releases'
            ? new HostingTargetPublisher(
                new InMemoryHostingSiteOps(),
                new InMemoryArtifactTransport(),
                SIMULATED_STAGING_TARGET,
              )
            : new InMemorySitePublisher(),
      inject: [AI_CONFIG],
    },
    {
      provide: DeployPolicyService,
      useFactory: (db: Db, a: AuditSink) => new DeployPolicyService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: DeployService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: OperationsService,
        p: SitePublisherPort,
        r: ResidencyService,
        c: CmsService,
        cfg: DeployConfig,
        pol: DeployPolicyService,
      ) => new DeployService(db, a, o, p, r, c, cfg, pol),
      inject: [
        DB,
        AuditSink,
        OperationsService,
        SitePublisherPort,
        ResidencyService,
        CmsService,
        DEPLOY_CONFIG,
        DeployPolicyService,
      ],
    },
  ],
  exports: [DeployService, DeployPolicyService, SitePublisherPort],
})
export class DeployModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  constructor(@Inject(DeployService) private readonly deploys: DeployService) {}
  onApplicationBootstrap() {
    const kick = process.env.DEPLOY_KICK !== 'off';
    this.deploys.setKicker((o, id) => {
      if (kick)
        setImmediate(
          () =>
            void this.deploys
              .runOne(o, id)
              .catch((e) =>
                process.stderr.write(
                  JSON.stringify({ deploy_run_error: (e as Error).message }) + '\n',
                ),
              ),
        );
    });
    const s = Number(process.env.DEPLOY_SCHEDULER_INTERVAL_SECONDS ?? 0);
    if (s > 0) {
      this.timer = setInterval(() => void this.deploys.tick().catch(() => undefined), s * 1000);
      this.timer.unref();
    }
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
