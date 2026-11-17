import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { BreachService } from './internal/breach/breach.service';

/** Breach cases (docs/04): open a case, or move one with `{caseId, transition}` (PATCH is not in the spec: SI-M04-2). Nothing here notifies anyone. */
@RealmOnly('admin')
@Controller('v1/admin/compliance/breach-cases')
export class AdminBreachController {
  constructor(private readonly breach: BreachService) {}

  /** `?id=` one case; `&pack=true&reason=...` adds the evidence pack (reads audit across organizations: reason required, audited). */
  @RequirePlatformPermission('admin:compliance:read')
  @Get()
  list(
    @Platform() who: PlatformContext,
    @Query()
    q: {
      id?: string;
      state?: string;
      severity?: string;
      pack?: string;
      reason?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.breach.list(
      {
        id: q.id,
        state: q.state,
        severity: q.severity,
        pack: q.pack === 'true',
        reason: q.reason,
        limit: parseLimit(q.limit),
        cursor: q.cursor,
      },
      who.userId,
    );
  }

  /** Without `caseId` opens a case (201); with `caseId` and `transition` moves it (200). Needs `admin:breach:manage`, a recent MFA check and an Idempotency-Key. */
  @RequirePlatformPermission('admin:compliance:read')
  @StepUp()
  @Post()
  async handle(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:breach:manage'))
      throw new ProblemException('forbidden', 'permission admin:breach:manage is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    if (body?.caseId !== undefined) {
      void reply.status(200);
      return this.breach.transition(who.userId, key, body);
    }
    const r = await this.breach.open(who.userId, key, body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.case;
  }
}
