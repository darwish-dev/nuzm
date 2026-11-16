import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { AdjustmentService } from './internal/adjustment.service';

/**
 * Manual ledger adjustments (docs/04: POST /v1/admin/billing/adjustments). Two bodies on the one documented endpoint:
 * `{orgId, reason, reverses | lines}` files a request (finance, `admin:billing:manage`), and `{adjustmentId, decision, note?}`
 * decides it (a DIFFERENT person with `admin:billing:approve`). The ledger is touched only by an approval.
 */
@RealmOnly('admin')
@Controller('v1/admin/billing/adjustments')
export class AdminAdjustmentsController {
  constructor(private readonly adjustments: AdjustmentService) {}

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post()
  @HttpCode(201)
  async handle(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = body ?? {};
    if ('adjustmentId' in b) {
      if (!who.permissions.has('admin:billing:approve'))
        throw new ProblemException('forbidden', 'permission admin:billing:approve is required');
      void reply.status(200);
      return this.adjustments.decide(who.userId, b);
    }
    if (!who.permissions.has('admin:billing:manage'))
      throw new ProblemException('forbidden', 'permission admin:billing:manage is required');
    if (!key)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.adjustments.request(who.userId, b, key);
    if (r.replayed) {
      void reply.status(200);
      void reply.header('idempotent-replayed', 'true');
    }
    return r.adjustment;
  }
}
