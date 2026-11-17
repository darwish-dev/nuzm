import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { RopaService } from './internal/ropa.service';

/** Record of processing activities (docs/04): compliance officers and platform admins; versioned, never edited in place. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/ropa')
export class AdminRopaController {
  constructor(private readonly ropa: RopaService) {}

  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Query()
    q: {
      entryKey?: string;
      kind?: string;
      adapterKind?: string;
      status?: string;
      history?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.ropa.list({
      entryKey: q.entryKey,
      kind: q.kind,
      adapterKind: q.adapterKind,
      status: q.status,
      history: q.history === 'true',
      limit: parseLimit(q.limit),
      cursor: q.cursor,
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
    const r = await this.ropa.save(who.userId, key, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.entry;
  }
}
