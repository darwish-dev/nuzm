import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly } from '../identity';
import { KnowledgeLibraryGuard } from './internal/flag';
import { isUuid, type Row } from './internal/model';
import { ResourceService, type ResourceFilters } from './internal/resource.service';

const READ = 'admin:ai_knowledge:read';
const MANAGE = 'admin:ai_knowledge:manage';
const PUBLISH = 'admin:ai_knowledge:publish';
const body = (x: unknown): Row =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {};
const uuid = (x: string) => {
  if (!isUuid(x)) throw new ProblemException('not_found', 'not found');
  return x.toLowerCase();
};
const can = (who: PlatformContext, p: string) => who.permissions.has(p);

/** Library resources: list, read, edit, disable, archive (SCR-K-01). Activation and review arrive with the ingestion slice (S-K2). */
@RealmOnly('admin')
@UseGuards(KnowledgeLibraryGuard)
@Controller('v1/admin/knowledge/resources')
export class AdminKnowledgeResourcesController {
  constructor(private readonly resources: ResourceService) {}

  @RequirePlatformPermission(READ)
  @Get()
  list(@Query() q: ResourceFilters & { limit?: string; cursor?: string }) {
    const { limit, cursor, ...filters } = q;
    return this.resources.list(filters, limit, cursor);
  }

  @RequirePlatformPermission(READ)
  @Get(':id')
  get(@Param('id') id: string) {
    return this.resources.get(uuid(id));
  }

  @RequirePlatformPermission(MANAGE)
  @Patch(':id')
  patch(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() b: unknown,
  ) {
    return this.resources.patch(who.userId, can(who, PUBLISH), uuid(id), ifMatch, body(b));
  }

  @RequirePlatformPermission(READ)
  @Get(':id/versions')
  versions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.resources.versions(uuid(id), limit, cursor);
  }

  @RequirePlatformPermission(MANAGE)
  @Post(':id/deactivation')
  @HttpCode(200)
  disable(@Platform() who: PlatformContext, @Param('id') id: string, @Body() b: unknown) {
    return this.resources.disable(who.userId, uuid(id), body(b).reason);
  }

  @RequirePlatformPermission(MANAGE)
  @Post(':id/archival')
  @HttpCode(200)
  archive(@Platform() who: PlatformContext, @Param('id') id: string, @Body() b: unknown) {
    return this.resources.archive(who.userId, uuid(id), body(b).reason);
  }
}
