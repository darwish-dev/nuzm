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
  UseGuards,
} from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly } from '../identity';
import { KnowledgeLibraryGuard } from './internal/flag';
import { isUuid, type Row } from './internal/model';
import { UploadService } from './internal/upload.service';

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

/** Resumable, quarantined uploads of library packages (SCR-K-01). Nothing in an uploaded package is read or executed here. */
@RealmOnly('admin')
@UseGuards(KnowledgeLibraryGuard)
@Controller('v1/admin/knowledge/uploads')
export class AdminKnowledgeUploadsController {
  constructor(private readonly uploads: UploadService) {}

  @RequirePlatformPermission(MANAGE)
  @Post()
  open(@Platform() who: PlatformContext, @Body() b: unknown) {
    return this.uploads.open(who.userId, body(b));
  }

  @RequirePlatformPermission(READ)
  @Get(':uploadId')
  get(@Param('uploadId') id: string) {
    return this.uploads.get(uuid(id));
  }

  @RequirePlatformPermission(MANAGE)
  @Delete(':uploadId')
  @HttpCode(204)
  async cancel(@Platform() who: PlatformContext, @Param('uploadId') id: string) {
    await this.uploads.cancel(who.userId, uuid(id));
  }

  /** Raw bytes of one part (`application/octet-stream`); `X-Part-Sha256` is required and verified. Sending the same part again replaces it. */
  @RequirePlatformPermission(MANAGE)
  @Put(':uploadId/parts/:partNumber')
  part(
    @Platform() who: PlatformContext,
    @Param('uploadId') id: string,
    @Param('partNumber') n: string,
    @Headers('x-part-sha256') sha: string | undefined,
    @Body() data: unknown,
  ) {
    if (!Buffer.isBuffer(data))
      throw new ProblemException('validation_failed', 'send the part as application/octet-stream');
    return this.uploads.putPart(who.userId, uuid(id), Number(n), sha, data);
  }

  @RequirePlatformPermission(MANAGE)
  @Post(':uploadId/completion')
  @HttpCode(202)
  complete(@Platform() who: PlatformContext, @Param('uploadId') id: string, @Body() b: unknown) {
    return this.uploads.complete(who.userId, can(who, PUBLISH), uuid(id), body(b));
  }
}
