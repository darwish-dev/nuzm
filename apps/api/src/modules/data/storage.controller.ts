import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
import { StorageService } from './internal/storage.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null)
    throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};
const policyMatch = (req: FastifyRequest) => {
  const v = req.headers['if-match'];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return s;
};

/** Object storage (docs/04 §2.8): buckets, access policy, signed URLs, lifecycle. Bucket credentials are vault references; the reveal is PA-15 (not exposed). */
@Controller('v1/storage/buckets')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  /** 202 `status=provisioning` + `operationId`. Needs a `quoteId` of kind `storage`. Private by default; `public`/`policy` cannot be set here. */
  @RequirePermission('data:storage:write')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const d = await this.storage.create(orgId, a.actor.userId, b(body));
    void reply.header('etag', etag(d.etag));
    return d;
  }

  @RequirePermission('data:storage:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.storage.list(orgId, { limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePermission('data:storage:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const d = await this.storage.get(orgId, id.toLowerCase());
    void reply.header('etag', etag(d.etag));
    return d;
  }

  @RequirePermission('data:storage:admin')
  @Patch(':id')
  async patch(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const d = await this.storage.patch(
      orgId,
      a.actor.userId,
      id.toLowerCase(),
      ifMatch(req),
      b(body),
    );
    void reply.header('etag', etag(d.etag));
    return d;
  }

  /** `confirmName` (body or query) must equal the bucket name. An empty bucket only, unless `force=true` (needs `data:storage:admin` and a recent MFA check). */
  @RequirePermission('data:storage:write')
  @Delete(':id')
  @HttpCode(202)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Query() q: { confirmName?: string; force?: string },
    @Req() req: FastifyRequest,
  ) {
    const force = b(body).force === true || q.force === 'true';
    const r = await this.storage.remove(
      orgId,
      a.actor.userId,
      id.toLowerCase(),
      { force, confirmName: b(body).confirmName ?? q.confirmName },
      req,
      a.permissions.has('data:storage:admin'),
    );
    return { ...r.bucket, operationId: r.operationId };
  }

  @RequirePermission('data:storage:read')
  @Get(':id/access-policy')
  async getPolicy(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.storage.getPolicy(orgId, id.toLowerCase());
    void reply.header('etag', `"${p.etag}"`);
    return p;
  }

  /** If-Match is the policy ETag. `access=public-read` needs `confirmPublic=true` and a recent MFA check; it is audited and the console warns. */
  @RequirePermission('data:storage:admin')
  @Put(':id/access-policy')
  async putPolicy(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.storage.putPolicy(
      orgId,
      a.actor.userId,
      id.toLowerCase(),
      policyMatch(req),
      b(body),
      req,
    );
    void reply.header('etag', `"${p.etag}"`);
    return p;
  }

  /** Method-scoped signed URL. TTL default 15 minutes, maximum 7 days (422 `ttl_too_long`). The URL is shown once and never logged. */
  @RequirePermission('data:storage:read')
  @Idempotent()
  @Post(':id/signed-urls')
  @HttpCode(201)
  signUrl(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.storage.signUrl(orgId, a.actor.userId, id.toLowerCase(), b(body), a.permissions);
  }

  @RequirePermission('data:storage:read')
  @Get(':id/lifecycle')
  getLifecycle(@Org() orgId: string, @Param('id') id: string) {
    return this.storage.getLifecycle(orgId, id.toLowerCase());
  }

  @RequirePermission('data:storage:write')
  @Put(':id/lifecycle')
  putLifecycle(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.storage.putLifecycle(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }
}
