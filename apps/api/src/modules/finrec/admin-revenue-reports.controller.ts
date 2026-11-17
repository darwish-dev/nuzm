import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly } from '../identity';
import { ReportService, toCsv } from './internal/reports.service';

/** Revenue and finance reports (docs/04): finance and platform admins (`admin:reports:read`). Every read is audited. `format=csv` downloads a file. */
@RealmOnly('admin')
@Controller('v1/admin/billing/revenue-reports')
export class AdminRevenueReportsController {
  constructor(private readonly reports: ReportService) {}

  @RequirePlatformPermission('admin:reports:read')
  @Get()
  async get(
    @Platform() who: PlatformContext,
    @Query() q: { report?: string; from?: string; to?: string; format?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const format = q.format ?? 'json';
    if (format !== 'json' && format !== 'csv')
      throw new ProblemException('validation_failed', "format must be 'json' or 'csv'");
    const r = await this.reports.generate(who.userId, q.report ?? '', {
      from: q.from,
      to: q.to,
      format,
    });
    if (format === 'json') return r;
    void reply.header(
      'content-disposition',
      `attachment; filename="${r.report}-${r.from}-${r.to}.csv"`,
    );
    return new StreamableFile(Buffer.from(toCsv(r), 'utf8'), { type: 'text/csv; charset=utf-8' });
  }
}
