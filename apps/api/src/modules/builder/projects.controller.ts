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
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { etag, parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { AiEnabledGuard } from '../ai';
import { CmsService } from './internal/cms.service';
import { FormsService } from './internal/forms.service';
import { PreviewService } from './internal/preview.service';
import { ProjectService } from './internal/project.service';

type B = Record<string, unknown> | undefined;
const id = (s: string) => s.toLowerCase();

/** Builder projects (docs/04 §2.9, type `website`): project, files, versions, changes, previews, forms and CMS. Gated by the `ai.enabled` flag. */
@UseGuards(AiEnabledGuard)
@Controller('v1/builder/projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectService,
    private readonly previews: PreviewService,
    private readonly forms: FormsService,
    private readonly cms: CmsService,
  ) {}

  @RequirePermission('builder:write')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: B) {
    return this.projects.create(orgId, a.actor.userId, body ?? {});
  }
  @RequirePermission('builder:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.projects.list(orgId, { limit: parseLimit(q.limit), cursor: q.cursor });
  }
  @RequirePermission('builder:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') pid: string,
    @Query() q: { versionId?: string; compareTo?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.projects.get(orgId, id(pid), {
      ...(q.versionId ? { versionId: id(q.versionId) } : {}),
      ...(q.compareTo ? { compareTo: id(q.compareTo) } : {}),
    });
    void reply.header('etag', etag(p.etag));
    return p;
  }
  @RequirePermission('builder:write')
  @Patch(':id')
  async patch(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const m = parseIfMatch(req.headers['if-match']);
    if (m === null)
      throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
    const p = await this.projects.patch(orgId, a.actor.userId, id(pid), m, body ?? {});
    void reply.header('etag', etag(p.etag));
    return p;
  }
  /** Soft delete with a retention window; `confirmName` (body or query) must equal the project name. */
  @RequirePermission('builder:write')
  @Delete(':id')
  remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
    @Query() q: { confirmName?: string },
  ) {
    return this.projects.remove(orgId, a.actor.userId, id(pid), body?.confirmName ?? q.confirmName);
  }

  @RequirePermission('builder:read')
  @Get(':id/files')
  files(@Org() orgId: string, @Param('id') pid: string, @Query() q: { versionId?: string }) {
    return this.projects.files(orgId, id(pid), q.versionId ? id(q.versionId) : undefined);
  }
  @RequirePermission('builder:read')
  @Get(':id/files/content')
  fileContent(
    @Org() orgId: string,
    @Param('id') pid: string,
    @Query() q: { path?: string; versionId?: string },
  ) {
    return this.projects.fileContent(
      orgId,
      id(pid),
      q.path,
      q.versionId ? id(q.versionId) : undefined,
    );
  }

  /** Body {baseVersion, ops[], source: user|ai, label?, assetData?}. 409 `base_outdated` (rebase info), 422 `op_invalid`; `source=ai` is refused here: AI change sets are applied through run approvals. */
  @RequirePermission('builder:write')
  @Post(':id/changes')
  @HttpCode(200)
  async changes(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = body ?? {};
    if (b.source === 'ai')
      throw new ProblemException(
        'approval_required',
        'AI change sets are applied only through a run approval',
      );
    const r = await this.projects.applyChange(orgId, id(pid), {
      baseVersion: String(b.baseVersion ?? ''),
      ops: b.ops,
      source: 'user',
      ...(typeof b.label === 'string' ? { label: b.label } : {}),
      ...(b.assetData && typeof b.assetData === 'object'
        ? { assetData: b.assetData as Record<string, string> }
        : {}),
      userId: a.actor.userId,
    });
    void reply.header('etag', etag(r.etag));
    return r;
  }
  @RequirePermission('builder:read')
  @Get(':id/versions')
  versions(
    @Org() orgId: string,
    @Param('id') pid: string,
    @Query() q: { limit?: string; cursor?: string },
  ) {
    return this.projects.versions(orgId, id(pid), { limit: parseLimit(q.limit), cursor: q.cursor });
  }
  @RequirePermission('builder:write')
  @Idempotent()
  @Post(':id/versions/:vid/restoration')
  @HttpCode(201)
  restore(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Param('vid') vid: string,
  ) {
    return this.projects.restore(orgId, a.actor.userId, id(pid), id(vid));
  }

  @RequirePermission('builder:write')
  @Post(':id/previews')
  @HttpCode(201)
  createPreview(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
  ) {
    return this.previews.create(orgId, a.actor.userId, id(pid), body ?? {});
  }
  @RequirePermission('builder:read')
  @Get(':id/previews')
  listPreviews(@Org() orgId: string, @Param('id') pid: string) {
    return this.previews.list(orgId, id(pid));
  }

  @RequirePermission('builder:read')
  @Get(':id/forms')
  listForms(@Org() orgId: string, @Param('id') pid: string) {
    return this.forms.list(orgId, id(pid));
  }
  @RequirePermission('builder:write')
  @Post(':id/forms')
  @HttpCode(201)
  createForm(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
  ) {
    return this.forms.create(orgId, a.actor.userId, id(pid), body ?? {});
  }
  /** Personal data: masked for roles without `builder:submissions:read` (viewer). */
  @RequirePermission('builder:read')
  @Get(':id/form-submissions')
  submissions(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Query() q: { formId?: string; limit?: string; cursor?: string },
  ) {
    return this.forms.submissions(
      orgId,
      id(pid),
      {
        ...(q.formId ? { formId: id(q.formId) } : {}),
        limit: parseLimit(q.limit),
        cursor: q.cursor,
      },
      a.permissions.has('builder:submissions:read'),
    );
  }
  @RequirePermission('builder:read')
  @Get(':id/cms-collections')
  listCms(@Org() orgId: string, @Param('id') pid: string) {
    return this.cms.list(orgId, id(pid));
  }
  @RequirePermission('builder:write')
  @Post(':id/cms-collections')
  @HttpCode(201)
  upsertCms(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') pid: string,
    @Body() body: B,
  ) {
    return this.cms.upsert(orgId, a.actor.userId, id(pid), body ?? {});
  }
}
