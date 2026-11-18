import { Body, Controller, Get, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { PolicyVersionService } from './policy-versions.service';

@RealmOnly('admin')
@Controller('v1/admin/policy-versions')
export class PolicyVersionsController {
  constructor(private readonly svc: PolicyVersionService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  async list(@Query() q: Record<string, string>, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.svc.list({ policyKey: q.policyKey, history: q.history === 'true' });
    if (q.policyKey) void reply.header('etag', `"${await this.svc.currentVersion(q.policyKey)}"`);
    return out;
  }

  /** Publishes version n+1 of a policy key; If-Match carries the current version as an ETag ("0" for a new key). */
  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Put()
  async put(
    @Platform() who: PlatformContext,
    @Body() b: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:compliance:manage'))
      throw new ProblemException('forbidden', 'permission admin:compliance:manage is required');
    const m = /^"?(\d{1,6})"?$/.exec(String(req.headers['if-match'] ?? ''));
    if (!m)
      throw new ProblemException(
        'precondition_required',
        'send the current version as If-Match (0 for a new policy)',
      );
    const v = await this.svc.publish(who.userId, Number(m[1]), b ?? {});
    void reply.status(201).header('etag', `"${v.version}"`);
    return v;
  }
}
