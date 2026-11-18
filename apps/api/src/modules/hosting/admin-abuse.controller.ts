import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { AbuseService } from './internal/abuse.service';

/** Abuse cases (docs/04 §2.6, PA-14): `hosting_admin`, `support`, `security`, `platform_admin` (admin:hosting:abuse); reads need admin:hosting:read. */
@RealmOnly('admin')
@Controller('v1/admin/hosting/abuse-cases')
export class AdminAbuseController {
  constructor(private readonly abuse: AbuseService) {}

  @RequirePlatformPermission('admin:hosting:read')
  @Get()
  list(@Query() q: { state?: string; severity?: string; siteId?: string; limit?: string }) {
    return this.abuse.list({
      state: q.state,
      severity: q.severity,
      siteId: q.siteId,
      limit: parseLimit(q.limit),
    });
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.abuse.get(id);
  }

  /** `{siteId, source, severity, reasonCode, evidenceRefs, action?}`: 201 when opened, 200 on an idempotent replay. Audited. */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Post()
  async open(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!who.permissions.has('admin:hosting:abuse'))
      throw new ProblemException('forbidden', 'permission admin:hosting:abuse is required');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const b = body ?? {};
    for (const k of Object.keys(b))
      if (!['siteId', 'source', 'severity', 'reasonCode', 'evidenceRefs', 'action'].includes(k))
        throw new ProblemException('validation_failed', `unknown member ${k}`);
    const r = await this.abuse.open({
      siteId: String(b.siteId ?? ''),
      source: String(b.source ?? ''),
      severity: String(b.severity ?? ''),
      reasonCode: String(b.reasonCode ?? ''),
      evidenceRefs: b.evidenceRefs as string[] | undefined,
      action: (b.action as string | undefined) ?? null,
      createdBy: who.userId,
      idempotencyKey: key,
    });
    void reply.status(r.created ? 201 : 200);
    return r.case;
  }

  /** `{action: notify|throttle|suspend|close, note?}` or `{decision: upheld|overturned, note?}` (the appeal; never by the person who actioned the case). */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Patch(':id')
  async patch(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!who.permissions.has('admin:hosting:abuse'))
      throw new ProblemException('forbidden', 'permission admin:hosting:abuse is required');
    const b = body ?? {};
    for (const k of Object.keys(b))
      if (!['action', 'decision', 'note'].includes(k))
        throw new ProblemException('validation_failed', `unknown member ${k}`);
    const note = typeof b.note === 'string' ? b.note : undefined;
    if (b.decision !== undefined) return this.abuse.decideAppeal(who.userId, id, b.decision, note);
    if (b.action === 'close') return this.abuse.close(who.userId, id, note);
    if (b.action !== 'notify' && b.action !== 'throttle' && b.action !== 'suspend')
      throw new ProblemException(
        'validation_failed',
        "action must be 'notify', 'throttle', 'suspend' or 'close'",
      );
    return this.abuse.act(who.userId, id, b.action, note);
  }
}
