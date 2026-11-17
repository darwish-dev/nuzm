import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { ValidationService } from './internal/validations.service';

/** The regulatory validation register (docs/04, docs/10 §7): versioned; `validated` needs a document and a named human. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/regulatory-validations')
export class AdminValidationsController {
  constructor(private readonly validations: ValidationService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Query()
    q: {
      validationKey?: string;
      status?: string;
      applicability?: string;
      history?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.validations.list({
      ...q,
      history: q.history === 'true',
      limit: parseLimit(q.limit),
    });
  }

  /** Needs `admin:compliance:manage`, a recent MFA check and an Idempotency-Key. 201 when a version was written, 200 on a replay. */
  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async save(
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
    const r = await this.validations.save(who.userId, key, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.validation;
  }
}
