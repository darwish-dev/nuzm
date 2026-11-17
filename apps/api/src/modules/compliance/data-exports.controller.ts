import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { ExportService } from './internal/exports/export.service';
import { ComplianceJobs } from './internal/jobs';

/** Organization data exports (docs/04 §2.4): owners and admins. Async; the archive is encrypted in the export sink and downloaded through a signed, expiring link. */
@Controller('v1/compliance/data-exports')
export class DataExportsController {
  constructor(
    private readonly exports: ExportService,
    private readonly jobs: ComplianceJobs,
  ) {}

  /** 202 with the export (pending). 422 `no_export_sink` when the deployment has no sink; 422 `quota_exceeded` past the concurrency limit. */
  @RequirePermission('privacy:export:manage')
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 255)
      throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
    const r = await this.exports.request(orgId, a.actor.userId, key, body ?? {});
    if (r.created) this.jobs.kick({ orgId, operationId: r.export.id });
    else void reply.status(200);
    return r.export;
  }

  /** The list (status, expiry, size, hash, a signed link when ready); `?download=<token>` returns the archive of that link (410 when the link or the archive expired). */
  @RequirePermission('privacy:export:manage')
  @Get()
  async list(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query() q: { download?: string; limit?: string; cursor?: string },
  ) {
    if (q.download !== undefined) {
      const f = await this.exports.download(orgId, a.actor.userId, q.download);
      return new StreamableFile(f.bytes, {
        type: 'application/gzip',
        disposition: `attachment; filename="${f.filename}"`,
      });
    }
    return this.exports.list(orgId, { limit: parseLimit(q.limit), cursor: q.cursor });
  }
}
