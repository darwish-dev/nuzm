import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { RealmOnly } from '../identity';
import { KnowledgeLibraryGuard } from './internal/flag';
import type { Row } from './internal/model';
import { RetrievalService } from './internal/retrieval.service';

const READ = 'admin:ai_knowledge:read';
const PUBLISH = 'admin:ai_knowledge:publish';
const body = (x: unknown): Row =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {};

/**
 * Retrieval and recommendation (S-K5, SCR-K-07): search over the platform library, the permission-first recommendation with its explanation, the recommendation weights
 * with their audit trail, and the admin defaults. Platform scope only; answers 404 while `knowledge.library` is off. Reading needs `admin:ai_knowledge:read`; changing the
 * weights or the defaults needs `admin:ai_knowledge:publish`.
 */
@RealmOnly('admin')
@UseGuards(KnowledgeLibraryGuard)
@Controller('v1/admin/knowledge')
export class AdminKnowledgeRetrievalController {
  constructor(private readonly retrieval: RetrievalService) {}

  @RequirePlatformPermission(READ)
  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('platform') platform?: string,
    @Query('framework') framework?: string,
    @Query('language') language?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
    @Query('status') status?: string,
    @Query('eligible') eligible?: string,
    @Query('mode') mode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.retrieval.search(
      { q, type, platform, framework, language, category, tag, status, eligible, mode },
      limit,
    );
  }

  /** A computation, not a mutation: it ranks and explains, and writes nothing. */
  @RequirePlatformPermission(READ)
  @Post('recommendations')
  @HttpCode(200)
  recommend(@Body() b: unknown) {
    return this.retrieval.recommend(body(b));
  }

  @RequirePlatformPermission(READ)
  @Get('settings/recommendation')
  settings() {
    return this.retrieval.settings();
  }

  @RequirePlatformPermission(READ)
  @Get('settings/recommendation/revisions')
  revisions(@Query('limit') limit?: string) {
    return this.retrieval.settingsRevisions(limit);
  }

  @RequirePlatformPermission(PUBLISH)
  @Put('settings/recommendation')
  updateSettings(
    @Platform() who: PlatformContext,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() b: unknown,
  ) {
    return this.retrieval.updateSettings(who.userId, ifMatch, body(b));
  }

  @RequirePlatformPermission(READ)
  @Get('defaults')
  defaults() {
    return this.retrieval.defaults();
  }

  @RequirePlatformPermission(PUBLISH)
  @Put('defaults')
  setDefault(@Platform() who: PlatformContext, @Body() b: unknown) {
    return this.retrieval.setDefault(who.userId, body(b));
  }

  @RequirePlatformPermission(PUBLISH)
  @Delete('defaults/:id')
  deleteDefault(@Platform() who: PlatformContext, @Param('id') id: string) {
    return this.retrieval.deleteDefault(who.userId, id);
  }
}
