import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { StepUp } from '../identity';
import { DatabaseService } from './internal/database.service';
import { RestoreService } from './internal/restore.service';
import { RotationService } from './internal/rotation.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** Managed databases (docs/04 §2.8). Customers see the vault REFERENCE only; the secret is never returned by any endpoint on this controller. */
@Controller('v1/databases')
export class DatabasesController {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly restores: RestoreService,
    private readonly rotations: RotationService,
  ) {}

  /** 202 `status=provisioning` + `operationId`. Needs a `quoteId` of kind `database`. */
  @RequirePermission('data:db:write')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const d = await this.dbs.create(orgId, a.actor.userId, b(body));
    void reply.header('etag', etag(d.etag));
    return d;
  }

  @RequirePermission('data:db:read')
  @Get()
  list(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; engine?: string; status?: string },
  ) {
    return this.dbs.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      engine: q.engine,
      status: q.status,
    });
  }

  @RequirePermission('data:db:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const d = await this.dbs.get(orgId, id.toLowerCase());
    void reply.header('etag', etag(d.etag));
    return d;
  }

  /** `name` needs `data:db:write`; `backupPolicy` and `plan` need `data:db:admin`. Requires If-Match. */
  @RequirePermission('data:db:write')
  @Patch(':id')
  async patch(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const v = parseIfMatch(req.headers['if-match']);
    if (v === null)
      throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
    const input = b(body);
    if (
      (input.backupPolicy !== undefined || input.plan !== undefined) &&
      !a.permissions.has('data:db:admin')
    )
      throw new ProblemException(
        'forbidden',
        'permission data:db:admin is required to change the backup policy or the plan',
      );
    const d = await this.dbs.patch(orgId, a.actor.userId, id.toLowerCase(), v, input);
    void reply.header('etag', etag(d.etag));
    return d;
  }

  /** 202 + operation. `confirmName` (body or query) must equal the database name. 409 `in_use` while a site or app is bound to it. */
  @RequirePermission('data:db:admin')
  @Delete(':id')
  @HttpCode(202)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Query() q: { confirmName?: string },
  ) {
    const r = await this.dbs.remove(orgId, a.actor.userId, id.toLowerCase(), {
      confirmName: b(body).confirmName ?? q.confirmName,
    });
    return { ...r.database, operationId: r.operationId };
  }

  @RequirePermission('data:db:write')
  @Idempotent()
  @Post(':id/backups')
  @HttpCode(202)
  createBackup(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.dbs.createBackup(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }

  @RequirePermission('data:db:read')
  @Get(':id/backups')
  listBackups(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query() q: { limit?: string; cursor?: string },
  ) {
    return this.restores.listBackupsWithRestores(orgId, id.toLowerCase(), {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  /** Restore-to-NEW by default. `target=inplace` needs `confirmInPlace=true`, `confirmName`, a recent MFA check and takes an automatic pre-restore backup. */
  @RequirePermission('data:db:admin')
  @Idempotent()
  @Post(':id/restores')
  @HttpCode(202)
  async restore(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
  ) {
    const input = b(body);
    if (input.target === 'inplace') await this.stepUp(req);
    return this.restores.request(orgId, a.actor.userId, id.toLowerCase(), input);
  }

  /** Dual-credential window (proposal 24 h): the new secret is stored in the vault, consumers are notified, the old credential is revoked at the window end. */
  @RequirePermission('data:db:admin')
  @StepUp()
  @Idempotent()
  @Post(':id/credential-rotations')
  @HttpCode(202)
  rotate(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.rotations.request(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }

  // The same freshness rule as @StepUp(), applied only to the in-place branch (the decorator is per route).
  private async stepUp(req: FastifyRequest): Promise<void> {
    await this.restores.assertRecentMfa(req);
  }
}
