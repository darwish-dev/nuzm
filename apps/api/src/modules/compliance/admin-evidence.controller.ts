import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { EvidenceService } from './internal/controls/evidence.service';

/** Evidence (docs/04): list automated and manual items; people add manual evidence. Automated items come from the collectors only. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/evidence')
export class AdminEvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Query()
    q: {
      controlId?: string;
      type?: string;
      collector?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.evidence.list({ ...q, limit: parseLimit(q.limit) });
  }

  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async add(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:controls:manage'))
      throw new ProblemException('forbidden', 'permission admin:controls:manage is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const role =
      ['compliance_officer', 'security', 'platform_admin'].find((r) => who.roles.includes(r)) ??
      null;
    const r = await this.evidence.addManual(who.userId, role, key, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.evidence;
  }
}
