import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Db } from '@nuzm/platform';
import {
  Access,
  AnyAuthenticated,
  Org,
  RequirePermission,
  type AccessContext,
} from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { DB } from '../../common/tokens';
import { CurrentPrincipal, StepUp, UserService, type Principal } from '../identity';
import { InvitationService } from './internal/invitation.service';
import { MemberService } from './internal/member.service';
import { OrgService } from './internal/org.service';
import { etag, parseIfMatch } from './internal/pagination';
import { WorkspaceService } from './internal/workspace.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null)
    throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};

@Controller('v1')
export class TenancyController {
  constructor(
    private readonly orgs: OrgService,
    private readonly members: MemberService,
    private readonly invitations: InvitationService,
    private readonly work: WorkspaceService,
    private readonly users: UserService,
    @Inject(DB) private readonly db: Db,
  ) {}

  // ---- organizations -----------------------------------------------------------------------
  @AnyAuthenticated()
  @Post('organizations')
  @HttpCode(201)
  async createOrg(
    @Body() body: Body_,
    @CurrentPrincipal() p: Principal,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const org = await this.orgs.create(p.userId, b(body) as never);
    void reply.header('etag', etag(org.version));
    return org;
  }

  @AnyAuthenticated()
  @Get('organizations')
  listOrgs(@Query() q: Record<string, unknown>, @CurrentPrincipal() p: Principal) {
    return this.orgs.listForUser(p.userId, q);
  }

  @RequirePermission('org:read')
  @Get('organizations/:orgId')
  async getOrg(@Org() orgId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const org = await this.orgs.get(orgId);
    if (!org) throw new ProblemException('not_found');
    void reply.header('etag', etag(org.version));
    return org;
  }

  @RequirePermission('org:update')
  @Patch('organizations/:orgId')
  async patchOrg(
    @Org() orgId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const org = await this.orgs.update(orgId, ifMatch(req), b(body) as never);
    void reply.header('etag', etag(org.version));
    return org;
  }

  // ---- members -----------------------------------------------------------------------------
  @RequirePermission('member:read')
  @Get('organizations/:orgId/members')
  listMembers(@Org() orgId: string, @Query() q: Record<string, unknown>) {
    return this.members.list(orgId, q);
  }

  @RequirePermission('member:manage')
  @StepUp()
  @Patch('organizations/:orgId/members/:userId')
  async changeRole(
    @Org() orgId: string,
    @Param('userId') userId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Access() a: AccessContext,
  ) {
    const role = b(body).role;
    if (typeof role !== 'string')
      throw new ProblemException('validation_failed', 'role is required');
    const m = await this.members.changeRole(
      orgId,
      { userId: a.actor.userId, role: a.role },
      userId,
      role,
      ifMatch(req),
    );
    void reply.header('etag', etag(m.version));
    return m;
  }

  @RequirePermission('member:manage')
  @Delete('organizations/:orgId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Org() orgId: string,
    @Param('userId') userId: string,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    await this.members.remove(orgId, { userId: a.actor.userId, role: a.role }, userId);
  }

  // ---- invitations -------------------------------------------------------------------------
  @RequirePermission('member:invite')
  @Idempotent()
  @Post('invitations')
  @HttpCode(201)
  async invite(
    @Org() orgId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    const me = await this.users.get(a.actor.userId);
    const inv = await this.invitations.create(
      orgId,
      { userId: a.actor.userId, role: a.role, email: me?.email ?? '' },
      b(body) as never,
      me?.locale ?? 'ar',
    );
    return inv;
  }

  @RequirePermission('member:invite')
  @Get('invitations')
  listInvitations(@Org() orgId: string, @Query() q: Record<string, unknown>) {
    return this.invitations.list(orgId, q);
  }

  @RequirePermission('member:invite')
  @Delete('invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@Org() orgId: string, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProblemException('not_found');
    await this.invitations.revoke(orgId, id);
  }

  /** The invitee is signed in; the token proves possession and the verified email proves identity. */
  @AnyAuthenticated()
  @Post('invitations/:id/acceptance')
  @HttpCode(200)
  async accept(@Param('id') id: string, @Body() body: Body_, @CurrentPrincipal() p: Principal) {
    const u = await this.users.get(p.userId);
    if (!u) throw new ProblemException('unauthenticated');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProblemException('not_found');
    const r = await this.invitations.accept(
      { id: u.id, email: u.email, emailVerified: u.email_verified },
      id,
      b(body).token as string,
    );
    return r;
  }

  // ---- roles / permissions catalogue ---------------------------------------------------------
  @AnyAuthenticated()
  @Get('roles')
  async roles() {
    return this.db.withoutScope(async (c) => {
      const roles = (
        await c.query('SELECT name, scope, description FROM tenancy.roles ORDER BY scope, name')
      ).rows;
      const rp = (
        await c.query(
          'SELECT role, permission FROM tenancy.role_permissions ORDER BY role, permission',
        )
      ).rows;
      return {
        items: roles.map((r) => ({
          ...r,
          permissions: rp.filter((x) => x.role === r.name).map((x) => x.permission),
        })),
        nextCursor: null,
      };
    });
  }

  @AnyAuthenticated()
  @Get('permissions')
  async permissions() {
    return this.db.withoutScope(async (c) => ({
      items: (
        await c.query('SELECT name, scope, description FROM tenancy.permissions ORDER BY name')
      ).rows,
      nextCursor: null,
    }));
  }

  // ---- workspaces ----------------------------------------------------------------------------
  @RequirePermission('workspace:create')
  @Idempotent()
  @Post('workspaces')
  @HttpCode(201)
  async createWorkspace(
    @Org() orgId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    const w = await this.work.createWorkspace(orgId, a.actor.userId, b(body) as never);
    return w;
  }
  @RequirePermission('workspace:read')
  @Get('workspaces')
  listWorkspaces(@Org() orgId: string, @Query() q: Record<string, unknown>) {
    return this.work.listWorkspaces(orgId, q);
  }
  @RequirePermission('workspace:read')
  @Get('workspaces/:id')
  async getWorkspace(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const w = await this.work.getWorkspace(orgId, id);
    if (!w) throw new ProblemException('not_found');
    void reply.header('etag', etag(w.version));
    return w;
  }
  @RequirePermission('workspace:update')
  @Patch('workspaces/:id')
  async patchWorkspace(
    @Org() orgId: string,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const w = await this.work.updateWorkspace(orgId, id, ifMatch(req), b(body));
    void reply.header('etag', etag(w.version));
    return w;
  }
  @RequirePermission('workspace:delete')
  @Delete('workspaces/:id')
  @HttpCode(204)
  async deleteWorkspace(@Org() orgId: string, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProblemException('not_found');
    await this.work.deleteWorkspace(orgId, id);
  }

  // ---- projects ------------------------------------------------------------------------------
  @RequirePermission('project:create')
  @Idempotent()
  @Post('projects')
  @HttpCode(201)
  async createProject(
    @Org() orgId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    const p = await this.work.createProject(orgId, a.actor.userId, b(body) as never);
    return p;
  }
  @RequirePermission('project:read')
  @Get('projects')
  listProjects(@Org() orgId: string, @Query() q: Record<string, unknown>) {
    return this.work.listProjects(orgId, q);
  }
  @RequirePermission('project:read')
  @Get('projects/:id')
  async getProject(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.work.getProject(orgId, id);
    if (!p) throw new ProblemException('not_found');
    void reply.header('etag', etag(p.version));
    return p;
  }
  @RequirePermission('project:update')
  @Patch('projects/:id')
  async patchProject(
    @Org() orgId: string,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const p = await this.work.updateProject(orgId, id, ifMatch(req), b(body));
    void reply.header('etag', etag(p.version));
    return p;
  }
  @RequirePermission('project:delete')
  @Delete('projects/:id')
  @HttpCode(204)
  async deleteProject(@Org() orgId: string, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProblemException('not_found');
    await this.work.deleteProject(orgId, id);
  }

  // ---- environments --------------------------------------------------------------------------
  @RequirePermission('project:create')
  @Idempotent()
  @Post('projects/:id/environments')
  @HttpCode(201)
  async createEnvironment(@Org() orgId: string, @Param('id') id: string, @Body() body: Body_) {
    const e = await this.work.createEnvironment(orgId, id, b(body) as never);
    return e;
  }
  @RequirePermission('project:read')
  @Get('projects/:id/environments')
  listEnvironments(@Org() orgId: string, @Param('id') id: string) {
    return this.work.listEnvironments(orgId, id);
  }
  @RequirePermission('project:update')
  @Patch('projects/:id/environments/:envId')
  async patchEnvironment(
    @Org() orgId: string,
    @Param('id') id: string,
    @Param('envId') envId: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const e = await this.work.updateEnvironment(orgId, id, envId, ifMatch(req), b(body));
    void reply.header('etag', etag(e.version));
    return e;
  }
  @RequirePermission('project:delete')
  @Delete('projects/:id/environments/:envId')
  @HttpCode(204)
  async deleteEnvironment(
    @Org() orgId: string,
    @Param('id') id: string,
    @Param('envId') envId: string,
  ) {
    await this.work.deleteEnvironment(orgId, id, envId);
  }
}
