import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { KnowledgeLibraryGuard } from './internal/flag';
import type { Row } from './internal/model';
import { ReviewService } from './internal/review.service';

const READ = 'admin:ai_knowledge:read';
const MANAGE = 'admin:ai_knowledge:manage';
const PUBLISH = 'admin:ai_knowledge:publish';
const body = (x: unknown): Row =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {};

/**
 * Secure ingestion (S-K2a, SCR-K-02): processing jobs and their logs, scan findings, the file inventory, the review gate and activation. Platform scope only;
 * answers 404 while `knowledge.library` is off.
 */
@RealmOnly('admin')
@UseGuards(KnowledgeLibraryGuard)
@Controller('v1/admin/knowledge/resources')
export class AdminKnowledgeProcessingController {
  constructor(private readonly reviews: ReviewService) {}

  @RequirePlatformPermission(READ)
  @Get(':id/processing-jobs')
  jobs(
    @Param('id') id: string,
    @Query('versionId') versionId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reviews.jobs(id, versionId, limit, cursor);
  }

  @RequirePlatformPermission(READ)
  @Get(':id/processing-jobs/:jobId/logs')
  logs(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reviews.logs(id, jobId, limit, cursor);
  }

  @RequirePlatformPermission(MANAGE)
  @Post(':id/processing-jobs/:jobId/cancellation')
  @HttpCode(200)
  cancel(@Platform() who: PlatformContext, @Param('id') id: string, @Param('jobId') jobId: string) {
    return this.reviews.cancel(who.userId, id, jobId);
  }

  @RequirePlatformPermission(READ)
  @Get(':id/versions/:versionId/findings')
  findings(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query('severity') severity?: string,
    @Query('scanner') scanner?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reviews.findings(id, versionId, { severity, scanner }, limit, cursor);
  }

  @RequirePlatformPermission(READ)
  @Get(':id/versions/:versionId/files')
  files(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query('q') q?: string,
    @Query('stored') stored?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reviews.files(id, versionId, { q, stored }, limit, cursor);
  }

  @RequirePlatformPermission(READ)
  @Get(':id/versions/:versionId/review')
  reviewState(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.reviews.state(who.userId, id, versionId);
  }

  @RequirePlatformPermission(MANAGE)
  @Post(':id/versions/:versionId/reprocessing')
  @HttpCode(200)
  reprocess(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.reviews.reprocess(who.userId, id, versionId);
  }

  @RequirePlatformPermission(PUBLISH)
  @Post(':id/reviews')
  review(@Platform() who: PlatformContext, @Param('id') id: string, @Body() b: unknown) {
    return this.reviews.review(who.userId, id, body(b));
  }

  @RequirePlatformPermission(PUBLISH)
  @Post(':id/activation')
  @HttpCode(200)
  activate(@Platform() who: PlatformContext, @Param('id') id: string, @Body() b: unknown) {
    return this.reviews.activate(who.userId, id, body(b));
  }
}
