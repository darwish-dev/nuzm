import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseIfMatch, etag } from '../../common/etag';
import { RealmOnly, StepUp } from '../identity';
import { NodesService } from './internal/nodes.service';

const need = (who: PlatformContext, p: string) => {
  if (!who.permissions.has(p))
    throw new ProblemException('forbidden', `permission ${p} is required`);
};
const idemKey = (req: FastifyRequest) => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || k.length < 1 || k.length > 255)
    throw new ProblemException('idempotency_key_required', 'Send an Idempotency-Key header');
  return k;
};

/** Hosting nodes (docs/04 §2.6, M06 §6): platform staff only (`hosting_admin`, `platform_admin`; `support`/`security` read). */
@RealmOnly('admin')
@Controller('v1/admin/hosting/nodes')
export class AdminNodesController {
  constructor(private readonly nodes: NodesService) {}

  @RequirePlatformPermission('admin:hosting:read')
  @Get()
  list(@Query() q: { status?: string; dataRegion?: string }) {
    return this.nodes.list(q).then((items) => ({ items }));
  }

  /** Creating a node replays safely: the same computeInstanceId returns the existing node (200). The panel connection is set afterwards (PUT …/panel). */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Post()
  async create(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    need(who, 'admin:hosting:manage');
    idemKey(req);
    const r = await this.nodes.create(who.userId, body ?? {});
    void reply.status(r.created ? 201 : 200);
    if (r.created) void reply.header('etag', etag(r.node.version));
    return { node: r.node };
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const n = await this.nodes.get(id);
    void reply.header('etag', etag(n.version));
    return n;
  }

  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Patch(':id')
  async patch(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = body ?? {};
    // the approver of an overcommit change holds admin:hosting:approve; every other change needs admin:hosting:manage
    const decides =
      typeof b.overcommit === 'object' &&
      b.overcommit !== null &&
      'decision' in (b.overcommit as object);
    need(who, decides ? 'admin:hosting:approve' : 'admin:hosting:manage');
    const v = parseIfMatch(req.headers['if-match']);
    if (v === null)
      throw new ProblemException('precondition_required', 'Send If-Match with the node version');
    const n = await this.nodes.patch(who.userId, id, v, b);
    void reply.header('etag', etag(n.version));
    return n;
  }

  @RequirePlatformPermission('admin:hosting:read')
  @Get(':id/capacity')
  capacity(@Param('id') id: string) {
    return this.nodes.capacity(id);
  }

  /** Runs the inventory job for one node now (the panel connection must be set): it is also the connection test. */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Post(':id/inventory')
  async inventory(@Platform() who: PlatformContext, @Param('id') id: string) {
    need(who, 'admin:hosting:manage');
    return this.nodes.runInventory(id);
  }

  /**
   * How the node's HestiaCP panel is reached: host (fixed FQDN), port, optional pinned TLS fingerprint, and the access key (typed once, write-only; or a vault reference).
   * Any change clears the node's health: run the inventory again before activating it.
   */
  @RequirePlatformPermission('admin:hosting:read')
  @StepUp()
  @Put(':id/panel')
  async setPanel(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    need(who, 'admin:hosting:manage');
    return this.nodes.setPanel(who.userId, id, body ?? {});
  }
}
