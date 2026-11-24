import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { FilesService } from './internal/tools/files.service';

/**
 * The file manager of a website (SFTP as the site's own account, inside the website folder). The path of every call is proven to be inside the folder by the service; the
 * paths and names come from the query/body as RELATIVE paths and are never joined to anything before that proof. NOT VERIFIED against a real node.
 */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteFilesController {
  constructor(private readonly files: FilesService) {}

  @RequirePermission('hosting:files:read')
  @Get(':id/files')
  list(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
  ) {
    return this.files.list(orgId, id, { domain, path });
  }

  @RequirePermission('hosting:files:read')
  @Get(':id/files/download')
  async download(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
  ) {
    const f = await this.files.download(orgId, id, { domain, path });
    // the name is shown to the browser as a download name only: quotes and controls are removed, the real name is in the encoded form
    const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_');
    void reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      );
    return f.data;
  }

  @RequirePermission('hosting:files:read')
  @Get(':id/files/text')
  text(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
  ) {
    return this.files.readText(orgId, id, { domain, path });
  }

  /** Upload: the raw file bytes (`application/octet-stream`), the destination in the query. An existing file is replaced only with `overwrite=true`. */
  @RequirePermission('hosting:files:write')
  @Put(':id/files/content')
  upload(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Buffer,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
    @Query('overwrite') overwrite?: string,
  ) {
    return this.files.upload(
      orgId,
      a.actor.userId,
      id,
      { domain, path, overwrite: overwrite === 'true' },
      body,
    );
  }

  @RequirePermission('hosting:files:write')
  @Put(':id/files/text')
  edit(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: { content?: unknown; expectedSha256?: unknown } | undefined,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
  ) {
    return this.files.edit(orgId, a.actor.userId, id, { domain, path }, body ?? {});
  }

  @RequirePermission('hosting:files:write')
  @Idempotent()
  @Post(':id/files/folders')
  mkdir(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: { domain?: string; path?: string } | undefined,
  ) {
    return this.files.mkdir(orgId, a.actor.userId, id, { domain: body?.domain, path: body?.path });
  }

  @RequirePermission('hosting:files:write')
  @Idempotent()
  @HttpCode(200)
  @Post(':id/files/renames')
  rename(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: { domain?: string; from?: unknown; to?: unknown } | undefined,
  ) {
    return this.files.rename(orgId, a.actor.userId, id, { domain: body?.domain }, body ?? {});
  }

  @RequirePermission('hosting:files:write')
  @Delete(':id/files')
  remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
    @Query('recursive') recursive?: string,
  ) {
    return this.files.remove(orgId, a.actor.userId, id, {
      domain,
      path,
      recursive: recursive === 'true',
    });
  }
}
