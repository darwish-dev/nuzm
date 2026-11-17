import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { AssessmentService } from './internal/residency/assessment.service';

/** Transfer assessments (docs/04): create, then a DIFFERENT person decides; approved ones expire. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/transfer-assessments')
export class AdminTransferAssessmentsController {
  constructor(private readonly assessments: AssessmentService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Query()
    q: {
      status?: string;
      orgId?: string;
      dataClass?: string;
      expired?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.assessments.list({
      status: q.status,
      orgId: q.orgId,
      dataClass: q.dataClass,
      expired: q.expired === undefined ? undefined : q.expired === 'true',
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async handle(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:compliance:manage'))
      throw new ProblemException('forbidden', 'permission admin:compliance:manage is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.assessments.handle(who.userId, key, body ?? {});
    void reply.status(r.created && body?.assessmentId === undefined ? 201 : 200);
    return r.assessment;
  }
}
