import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { RefundService } from './internal/refund.service';

/**
 * Refunds (docs/04: POST /v1/admin/billing/refunds): finance only, admin realm, with a recent MFA verification (step-up) and an
 * Idempotency-Key. 201 when the refund finished, 202 while the PSP has not finished it (reconciled until it has), 200 for a replay.
 */
@RealmOnly('admin')
@Controller('v1/admin/billing/refunds')
export class AdminRefundsController {
  constructor(private readonly refunds: RefundService) {}

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post()
  async create(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:billing:manage'))
      throw new ProblemException('forbidden', 'permission admin:billing:manage is required');
    if (!key)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.refunds.request(who.userId, body ?? {}, key);
    void reply.status(r.httpStatus);
    if (r.httpStatus === 200) void reply.header('idempotent-replayed', 'true');
    return r.refund;
  }
}
