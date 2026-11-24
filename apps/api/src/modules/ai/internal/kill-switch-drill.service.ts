import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { AI_KILLSWITCH } from './model';
import type { GatewayService } from './gateway.service';
import type { ModelProviderService } from './provider.service';
import { runKillSwitchDrill, type DrillReport } from './kill-switch-drill';

/**
 * The kill switch drill wired to the real gateway and flag table (P3-S01). One organization is needed because the pre-flight is per organization (credits, residency); it only READS.
 * It sends nothing to any provider. The engage and lift go through `ModelProviderService.setKillSwitch`, so each is audited like a real toggle, and the drill adds its own event.
 */
export class KillSwitchDrillService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly providers: ModelProviderService,
    private readonly gateway: GatewayService,
  ) {}

  async run(actor: string, orgId: string): Promise<DrillReport> {
    return runKillSwitchDrill({
      isEngaged: async () =>
        (
          await this.db.withPlatformScope(
            async (c) =>
              (
                await c.query(
                  `SELECT value FROM platform.feature_flags WHERE key=$1 AND org_id IS NULL`,
                  [AI_KILLSWITCH],
                )
              ).rows,
          )
        ).some(
          (r) => r.value === true || (r.value as { enabled?: unknown } | null)?.enabled === true,
        ),
      setEngaged: async (on) => void (await this.providers.setKillSwitch(actor, on)),
      probe: async () => {
        try {
          await this.gateway.assertAvailable(orgId);
          return 'available';
        } catch (e) {
          return e instanceof ProblemException && e.code === 'ai_unavailable'
            ? 'killswitch'
            : 'other';
        }
      },
      audit: async (detail, outcome) =>
        this.audit.record({
          action: 'ai.killswitch.drill',
          actorUserId: actor,
          actorType: 'user',
          orgId,
          resource: { type: 'ai_killswitch' },
          outcome,
          detail,
        }),
    });
  }
}
