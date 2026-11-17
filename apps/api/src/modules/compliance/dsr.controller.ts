import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { DsrService, type Caller } from './internal/dsr/dsr.service';
import { ExportService } from './internal/exports/export.service';
import { ComplianceJobs } from './internal/jobs';

const callerOf = (a: AccessContext): Caller => ({
  userId: a.actor.userId,
  canManage: a.permissions.has('privacy:dsr:manage'),
});

/** Data-subject requests (docs/04 §2.4): any member about themselves; owners and admins also about the organization and its end users. */
@Controller('v1/compliance/data-subject-requests')
export class DsrController {
  constructor(
    private readonly dsr: DsrService,
    private readonly jobs: ComplianceJobs,
    private readonly exports: ExportService,
  ) {}

  /** 201 `received` with `dueAt` and `operationId`. A request about another person needs `identityAttestation` (422 `dsr_identity_unverified` otherwise). */
  @RequirePermission('privacy:dsr:self')
  @Idempotent()
  @Post()
  @HttpCode(201)
  async open(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    // the platform interceptor replays whole responses; the key is also stored on the row so a retry after a crash cannot open a second request
    const key = String(req.headers['idempotency-key'] ?? '');
    const r = await this.dsr.open(orgId, callerOf(a), key, body ?? {});
    if (r.created) this.jobs.kick({ orgId, operationId: r.request.operationId });
    return r.request;
  }

  @RequirePermission('privacy:dsr:self')
  @Get()
  list(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query()
    q: { status?: string; type?: string; subject?: string; limit?: string; cursor?: string },
  ) {
    return this.dsr.list(orgId, callerOf(a), {
      status: q.status,
      type: q.type,
      subject: q.subject,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  /** The request; with `?download=<token>` the archive of an access or portability request (only that request's; 410 when the link or archive expired). */
  @RequirePermission('privacy:dsr:self')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Query() q: { download?: string },
  ) {
    const dto = await this.dsr.get(orgId, callerOf(a), id.toLowerCase());
    if (q.download === undefined) return dto;
    const f = await this.exports.download(orgId, a.actor.userId, q.download, {
      dsrRequestId: dto.id,
    });
    return new StreamableFile(f.bytes, {
      type: 'application/gzip',
      disposition: `attachment; filename="${f.filename}"`,
    });
  }
}
