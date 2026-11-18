import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { AccountContext } from './m05-contracts';
import type { ComputeProvisioningPort, HostingAdapter } from './ports';
import type { HostingConfig } from './config';
import { ZERO_HASH, auditHash, type AuditEntry } from './agent/agent-runtime';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIMS = ['cpu_millicores', 'memory_mb', 'disk_mb', 'sites'] as const;
export type Dim = (typeof DIMS)[number];

export interface NodeDto {
  id: string;
  name: string;
  computeInstanceId: string;
  region: string;
  dataRegion: string;
  status: string;
  agentId: string | null;
  agentState: string | null;
  agentLastSeenAt: string | null;
  cloudpanelVersion: string | null;
  runtimes: string[];
  overcommitFactor: number;
  health: string;
  lastInventoryAt: string | null;
  version: number;
  createdAt: string;
  pendingOvercommit: {
    changeId: string;
    toFactor: number;
    requestedBy: string;
    approverId: string;
    reason: string;
  } | null;
}
const dto = (r: Row, pending: Row | undefined): NodeDto => ({
  id: r.id as string,
  name: r.name as string,
  computeInstanceId: r.compute_instance_id as string,
  region: r.region as string,
  dataRegion: r.data_region as string,
  status: r.status as string,
  agentId: (r.agent_id as string | null) ?? null,
  agentState: (r.agent_state as string | null) ?? null,
  agentLastSeenAt: iso(r.agent_last_seen),
  cloudpanelVersion: (r.cloudpanel_version as string | null) ?? null,
  runtimes: (r.runtimes as string[]) ?? [],
  overcommitFactor: Number(r.overcommit_factor),
  health: r.health as string,
  lastInventoryAt: iso(r.last_inventory_at),
  version: r.version as number,
  createdAt: iso(r.created_at)!,
  pendingOvercommit: pending
    ? {
        changeId: pending.id as string,
        toFactor: Number(pending.to_factor),
        requestedBy: pending.requested_by as string,
        approverId: pending.approver_id as string,
        reason: pending.reason as string,
      }
    : null,
});
const SELECT = `SELECT n.*, a.state AS agent_state, a.last_seen_at AS agent_last_seen FROM hosting.nodes n LEFT JOIN hosting.node_agents a ON a.id = n.agent_id`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const NODE_STATUSES = ['active', 'draining', 'maintenance', 'retired'] as const;
const ALLOWED: Record<string, string[]> = {
  maintenance: ['active', 'draining', 'retired'],
  active: ['draining', 'maintenance'],
  draining: ['active', 'maintenance', 'retired'],
  retired: [],
};

export class NodesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapter: HostingAdapter,
    private readonly compute: ComputeProvisioningPort,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private ctx(nodeId: string): AccountContext {
    return {
      providerAccountId: 'platform-hosting',
      credentialRef: 'vault://hosting/node-agent-signing',
      traceId: `inv-${nodeId}`,
      deadlineMs: 30_000,
    };
  }
  private async load(c: PoolClient, id: string): Promise<Row> {
    const r = (await c.query(`${SELECT} WHERE n.id = $1`, [id])).rows[0];
    if (!r) throw new ProblemException('not_found', 'node not found');
    return r;
  }
  private async pending(c: PoolClient, nodeId: string): Promise<Row | undefined> {
    return (
      await c.query(
        `SELECT * FROM hosting.node_overcommit_changes WHERE node_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [nodeId],
      )
    ).rows[0];
  }

  async list(q: { status?: string; dataRegion?: string }): Promise<NodeDto[]> {
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `${SELECT} WHERE ($1::text IS NULL OR n.status = $1) AND ($2::text IS NULL OR n.data_region = $2) ORDER BY n.created_at DESC, n.id LIMIT 200`,
          [q.status ?? null, q.dataRegion ?? null],
        )
      ).rows;
      const out: NodeDto[] = [];
      for (const r of rows) out.push(dto(r, await this.pending(c, r.id as string)));
      return out;
    });
  }
  async get(id: string): Promise<NodeDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'node not found');
    return this.db.withPlatformScope(async (c) => {
      const r = await this.load(c, id);
      return dto(r, await this.pending(c, id));
    });
  }

  /** Register a node on a platform-owned compute instance (M05 port). Returns the single-use bootstrap token ONCE. */
  async create(
    actor: string,
    input: Record<string, unknown>,
  ): Promise<{ node: NodeDto; enrolmentToken: string | null; created: boolean }> {
    const name = input.name;
    const instance = input.computeInstanceId;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name))
      throw new ProblemException(
        'validation_failed',
        'name must be 2..63 lowercase letters, digits or dashes',
      );
    if (typeof instance !== 'string' || instance.length < 1 || instance.length > 200)
      throw new ProblemException('validation_failed', 'computeInstanceId is required');
    const info = await this.compute.describe(instance);
    if (!info)
      throw new ProblemException(
        'validation_failed',
        'the compute instance is unknown to compute provisioning (M05)',
      );
    if (info.status !== 'running')
      throw new ProblemException('validation_failed', 'the compute instance is not running');
    return this.db.withPlatformScope(async (c) => {
      const existing = (
        await c.query(`SELECT id FROM hosting.nodes WHERE compute_instance_id = $1`, [instance])
      ).rows[0];
      if (existing)
        return {
          node: dto(await this.load(c, existing.id as string), undefined),
          enrolmentToken: null,
          created: false,
        };
      const id = uuidv7();
      const agentId = uuidv7();
      await c.query(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, name, instance, info.region, info.dataRegion, actor],
      );
      await c.query(`INSERT INTO hosting.node_agents (id, node_id) VALUES ($1,$2)`, [agentId, id]);
      await c.query(`UPDATE hosting.nodes SET agent_id = $2 WHERE id = $1`, [id, agentId]);
      const token = await this.newToken(c, id, agentId, actor);
      await this.audit.record({
        action: 'hosting.node.created',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'hosting_node', id },
        outcome: 'success',
        detail: { dataRegion: info.dataRegion },
      });
      return { node: dto(await this.load(c, id), undefined), enrolmentToken: token, created: true };
    });
  }

  private async newToken(
    c: PoolClient,
    nodeId: string,
    agentId: string,
    actor: string | null,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await c.query(
      `UPDATE hosting.node_enrolment_tokens SET used_at = now() WHERE node_id = $1 AND used_at IS NULL`,
      [nodeId],
    ); // one live token per node
    await c.query(
      `INSERT INTO hosting.node_enrolment_tokens (id, node_id, agent_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), $6)`,
      [uuidv7(), nodeId, agentId, sha256(token), this.cfg.enrolmentTtlMinutes, actor],
    );
    return token;
  }
  /** A fresh bootstrap token (e.g. a re-install). The previous unused token is invalidated. */
  async issueEnrolmentToken(
    actor: string,
    nodeId: string,
  ): Promise<{ token: string; expiresInMinutes: number }> {
    return this.db.withPlatformScope(async (c) => {
      const n = await this.load(c, nodeId);
      if (n.status === 'retired')
        throw new ProblemException('conflict', 'a retired node cannot be enrolled');
      const token = await this.newToken(c, nodeId, n.agent_id as string, actor);
      await this.audit.record({
        action: 'hosting.agent.enrolment_token.issued',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'hosting_node', id: nodeId },
        outcome: 'success',
      });
      return { token, expiresInMinutes: this.cfg.enrolmentTtlMinutes };
    });
  }
  /** Agent bootstrap (called from the agent channel, not over the public HTTP API): single-use token + the client certificate fingerprint. */
  async enrol(
    token: string,
    certFingerprint: string,
    version: string,
  ): Promise<{ nodeId: string; agentId: string }> {
    if (!/^[0-9a-f]{64}$/.test(certFingerprint))
      throw new ProblemException('validation_failed', 'certFingerprint must be a sha256 hex');
    return this.db.withPlatformScope(async (c) => {
      const t = (
        await c.query(
          `SELECT * FROM hosting.node_enrolment_tokens WHERE token_hash = $1 FOR UPDATE`,
          [sha256(token)],
        )
      ).rows[0];
      if (!t || t.used_at || (t.expires_at as Date).getTime() <= this.clock().getTime())
        throw new ProblemException(
          'unauthenticated',
          'the enrolment token is invalid, used or expired',
        );
      await c.query(`UPDATE hosting.node_enrolment_tokens SET used_at = now() WHERE id = $1`, [
        t.id,
      ]);
      await c.query(
        `UPDATE hosting.node_agents SET state = 'enrolled', cert_fingerprint = $2, version = $3, enrolled_at = now(), last_seen_at = now() WHERE id = $1`,
        [t.agent_id, certFingerprint, version.slice(0, 40)],
      );
      await this.audit.record({
        action: 'hosting.agent.enrolled',
        actorType: 'system',
        resource: { type: 'hosting_node', id: t.node_id as string },
        outcome: 'success',
      });
      return { nodeId: t.node_id as string, agentId: t.agent_id as string };
    });
  }
  async rotateCert(actor: string | null, nodeId: string, newFingerprint: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(newFingerprint))
      throw new ProblemException('validation_failed', 'fingerprint must be a sha256 hex');
    await this.db.withPlatformScope(async (c) => {
      const n = await this.load(c, nodeId);
      if (n.agent_state !== 'enrolled')
        throw new ProblemException('conflict', 'the agent is not enrolled');
      await c.query(
        `UPDATE hosting.node_agents SET cert_fingerprint = $2, cert_rotated_at = now() WHERE id = $1`,
        [n.agent_id, newFingerprint],
      );
      await this.audit.record({
        action: 'hosting.agent.cert.rotated',
        actorUserId: actor ?? undefined,
        actorType: actor ? 'user' : 'system',
        resource: { type: 'hosting_node', id: nodeId },
        outcome: 'success',
      });
    });
  }
  /** Revoke the agent: the channel refuses the node until a new enrolment. */
  async revokeAgent(actor: string, nodeId: string): Promise<void> {
    await this.db.withPlatformScope(async (c) => {
      const n = await this.load(c, nodeId);
      await c.query(
        `UPDATE hosting.node_agents SET state = 'revoked', cert_fingerprint = NULL WHERE id = $1`,
        [n.agent_id],
      );
      const agentId = uuidv7();
      await c.query(`INSERT INTO hosting.node_agents (id, node_id) VALUES ($1,$2)`, [
        agentId,
        nodeId,
      ]);
      await c.query(
        `UPDATE hosting.nodes SET agent_id = $2, status = CASE WHEN status = 'active' THEN 'maintenance' ELSE status END, updated_at = now(), version = version + 1 WHERE id = $1`,
        [nodeId, agentId],
      );
      await this.audit.record({
        action: 'hosting.agent.revoked',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'hosting_node', id: nodeId },
        outcome: 'success',
      });
    });
  }

  /** The inventory job: probe + inventory through the adapter; stores versions, health and runtimes and sizes the node's capacity rows. */
  async runInventory(nodeId: string): Promise<NodeDto> {
    const n = await this.db.withPlatformScope(async (c) => this.load(c, nodeId));
    if (n.agent_state !== 'enrolled')
      throw new ProblemException('conflict', 'the node agent is not enrolled');
    const ref = { nodeId, computeInstanceId: n.compute_instance_id as string };
    const probe = await this.adapter.probe(this.ctx(nodeId), ref);
    const inv = await this.adapter.inventory(this.ctx(nodeId), ref);
    return this.db.withPlatformScope(async (c) => {
      if (inv.status !== 'succeeded' || !inv.data) {
        await c.query(`UPDATE hosting.nodes SET health = $2, updated_at = now() WHERE id = $1`, [
          nodeId,
          inv.status === 'uncertain' ? 'unknown' : 'unhealthy',
        ]);
        await this.audit.record({
          action: 'hosting.node.inventory.failed',
          actorType: 'system',
          resource: { type: 'hosting_node', id: nodeId },
          outcome: 'failure',
          detail: { status: inv.status },
        });
        return dto(await this.load(c, nodeId), undefined);
      }
      const d = inv.data;
      const keep = 1 - this.cfg.reservePercent / 100;
      const physical: Record<Dim, number> = {
        cpu_millicores: Math.floor(d.capacity.cpuMillicores * keep),
        memory_mb: Math.floor(d.capacity.memoryMb * keep),
        disk_mb: Math.floor(d.capacity.diskMb * keep),
        sites: this.cfg.maxSitesPerNode,
      };
      const factor = Number(
        (await c.query(`SELECT overcommit_factor FROM hosting.nodes WHERE id = $1`, [nodeId]))
          .rows[0]!.overcommit_factor,
      );
      for (const dim of DIMS) {
        const sellable = Math.floor(physical[dim] * factor);
        // never shrink below what is already reserved: an inventory glitch must not make the invariant fail or evict sites
        await c.query(
          `INSERT INTO hosting.node_capacity (node_id, dim, physical, sellable) VALUES ($1,$2,$3,$4)
           ON CONFLICT (node_id, dim) DO UPDATE SET physical = EXCLUDED.physical, sellable = GREATEST(EXCLUDED.sellable, hosting.node_capacity.reserved), updated_at = now()`,
          [nodeId, dim, physical[dim], sellable],
        );
      }
      await c.query(
        `UPDATE hosting.nodes SET cloudpanel_version = $2, runtimes = $3, health = $4, last_inventory = $5, last_inventory_at = now(), updated_at = now() WHERE id = $1`,
        [
          nodeId,
          d.cloudpanelVersion,
          JSON.stringify(probe.runtimes.length ? probe.runtimes : d.runtimes),
          d.health.state,
          JSON.stringify({
            usage: d.usage,
            clpctlVersion: d.clpctlVersion,
            agentVersion: d.agentVersion,
            capacity: d.capacity,
          }),
        ],
      );
      await c.query(
        `UPDATE hosting.node_agents SET last_seen_at = now(), version = $2 WHERE id = $1`,
        [n.agent_id, d.agentVersion.slice(0, 40)],
      );
      return dto(await this.load(c, nodeId), await this.pending(c, nodeId));
    });
  }

  async capacity(nodeId: string) {
    if (!UUID.test(nodeId)) throw new ProblemException('not_found', 'node not found');
    return this.db.withPlatformScope(async (c) => {
      await this.load(c, nodeId);
      const dims = (
        await c.query(
          `SELECT dim, physical, sellable, reserved FROM hosting.node_capacity WHERE node_id = $1 ORDER BY dim`,
          [nodeId],
        )
      ).rows;
      const allocs = (
        await c.query(
          `SELECT site_id, cpu_millicores, memory_mb, disk_mb, sites, created_at FROM hosting.site_allocations WHERE node_id = $1 ORDER BY created_at, site_id LIMIT 500`,
          [nodeId],
        )
      ).rows;
      return {
        nodeId,
        dimensions: dims.map((r) => ({
          dim: r.dim as string,
          physical: Number(r.physical),
          sellable: Number(r.sellable),
          reserved: Number(r.reserved),
          free: Number(r.sellable) - Number(r.reserved),
        })),
        allocations: allocs.map((r) => ({
          siteId: r.site_id as string,
          cpuMillicores: Number(r.cpu_millicores),
          memoryMb: Number(r.memory_mb),
          diskMb: Number(r.disk_mb),
          sites: Number(r.sites),
          createdAt: iso(r.created_at)!,
        })),
      };
    });
  }

  /** PATCH: status and overcommit (dual approval). `ifMatch` = the node version the caller saw. */
  async patch(
    actor: string,
    nodeId: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<NodeDto> {
    if (!UUID.test(nodeId)) throw new ProblemException('not_found', 'node not found');
    const allowed = new Set(['status', 'overcommit']);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (body.status === undefined && body.overcommit === undefined)
      throw new ProblemException('validation_failed', 'nothing to change');
    return this.db.withPlatformScope(async (c) => {
      const n = await this.load(c, nodeId);
      if (n.version !== ifMatch)
        throw new ProblemException('precondition_failed', 'the node changed since you read it');
      if (body.status !== undefined) await this.changeStatus(c, actor, n, body.status);
      if (body.overcommit !== undefined) await this.overcommit(c, actor, n, body.overcommit);
      await c.query(
        `UPDATE hosting.nodes SET version = version + 1, updated_at = now() WHERE id = $1`,
        [nodeId],
      );
      return dto(await this.load(c, nodeId), await this.pending(c, nodeId));
    });
  }

  private async changeStatus(c: PoolClient, actor: string, n: Row, to: unknown) {
    if (typeof to !== 'string' || !(NODE_STATUSES as readonly string[]).includes(to))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${NODE_STATUSES.join(', ')}`,
      );
    const from = n.status as string;
    if (from === to) return;
    if (!ALLOWED[from]!.includes(to))
      throw new ProblemException('conflict', `a ${from} node cannot become ${to}`);
    if (to === 'active') {
      if (n.agent_state !== 'enrolled')
        throw new ProblemException('conflict', 'the node agent is not enrolled');
      if (n.health !== 'healthy') throw new ProblemException('conflict', 'the node is not healthy');
      const age = n.last_inventory_at
        ? this.clock().getTime() - (n.last_inventory_at as Date).getTime()
        : Infinity;
      if (age > this.cfg.inventoryMaxAgeSeconds * 1000)
        throw new ProblemException('conflict', 'run the inventory first: it is missing or stale');
      if ((n.runtimes as string[]).length === 0)
        throw new ProblemException('conflict', 'the node reported no runtimes');
    }
    if (to === 'retired') {
      const live = (
        await c.query(
          `SELECT count(*)::int AS n FROM hosting.sites WHERE node_id = $1 AND status <> 'deleted'`,
          [n.id],
        )
      ).rows[0]!.n as number;
      if (live > 0)
        throw new ProblemException(
          'conflict',
          `${live} site(s) still live on this node: migrate or offboard them first`,
        );
    }
    await c.query(`UPDATE hosting.nodes SET status = $2 WHERE id = $1`, [n.id, to]);
    await this.audit.record({
      action: 'hosting.node.status.changed',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'hosting_node', id: n.id as string },
      outcome: 'success',
      before: { status: from },
      after: { status: to },
    });
  }

  /** `{factor, reason, approverId}` requests a change; `{changeId, decision}` is the approver deciding. The requester can never approve. */
  private async overcommit(c: PoolClient, actor: string, n: Row, raw: unknown) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (o.decision !== undefined) {
      if (typeof o.changeId !== 'string' || !UUID.test(o.changeId))
        throw new ProblemException('validation_failed', 'changeId is required');
      if (o.decision !== 'approve' && o.decision !== 'reject')
        throw new ProblemException('validation_failed', "decision must be 'approve' or 'reject'");
      const ch = (
        await c.query(
          `SELECT * FROM hosting.node_overcommit_changes WHERE id = $1 AND node_id = $2 FOR UPDATE`,
          [o.changeId, n.id],
        )
      ).rows[0];
      if (!ch) throw new ProblemException('not_found', 'change not found');
      if (ch.status !== 'pending')
        throw new ProblemException('conflict', 'the change was already decided');
      if (ch.approver_id !== actor)
        throw new ProblemException('forbidden', 'only the named approver can decide this change');
      if (ch.requested_by === actor)
        throw new ProblemException('forbidden', 'the requester cannot approve their own change');
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : null;
      await c.query(
        `UPDATE hosting.node_overcommit_changes SET status = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
        [ch.id, o.decision === 'approve' ? 'approved' : 'rejected', note || null],
      );
      if (o.decision === 'approve') {
        const factor = Number(ch.to_factor);
        const caps = (
          await c.query(
            `SELECT dim, physical, reserved FROM hosting.node_capacity WHERE node_id = $1`,
            [n.id],
          )
        ).rows;
        for (const cap of caps) {
          const next = Math.floor(Number(cap.physical) * factor);
          if (next < Number(cap.reserved))
            throw new ProblemException(
              'conflict',
              `the new factor would put sellable ${cap.dim} below what is reserved`,
            );
        }
        // order matters for the database guards: raising = factor first, then sellable; lowering = sellable first, then factor
        const setFactor = () =>
          c.query(
            `UPDATE hosting.nodes SET overcommit_factor = $2, overcommit_change_id = $3 WHERE id = $1`,
            [n.id, factor, ch.id],
          );
        const setSellable = async () => {
          for (const cap of caps)
            await c.query(
              `UPDATE hosting.node_capacity SET sellable = floor(physical * $2::numeric), updated_at = now() WHERE node_id = $1 AND dim = $3`,
              [n.id, factor, cap.dim],
            );
        };
        if (factor >= Number(n.overcommit_factor)) {
          await setFactor();
          await setSellable();
        } else {
          await setSellable();
          await setFactor();
        }
        await this.audit.record({
          action: 'hosting.node.overcommit.changed',
          actorUserId: actor,
          actorType: 'user',
          resource: { type: 'hosting_node', id: n.id as string },
          outcome: 'success',
          before: { factor: Number(n.overcommit_factor) },
          after: { factor },
          detail: { changeId: ch.id as string, requestedBy: ch.requested_by as string },
        });
      }
      return;
    }
    const factor = Number(o.factor);
    if (
      !Number.isFinite(factor) ||
      factor < 0.5 ||
      factor > 2 ||
      Math.round(factor * 100) !== factor * 100
    )
      throw new ProblemException(
        'validation_failed',
        'factor must be between 0.5 and 2.0 with at most two decimals',
      );
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500)
      throw new ProblemException('validation_failed', 'reason is required (10..500 characters)');
    if (typeof o.approverId !== 'string' || !UUID.test(o.approverId))
      throw new ProblemException('validation_failed', 'approverId must be a staff user id');
    if (o.approverId === actor)
      throw new ProblemException('validation_failed', 'the approver must be a different person');
    if (await this.pending(c, n.id as string))
      throw new ProblemException('conflict', 'a change is already pending for this node');
    const approver = (
      await c.query(
        `SELECT 1 FROM tenancy.platform_roles pr JOIN tenancy.role_permissions rp ON rp.role = pr.role WHERE pr.user_id = $1 AND rp.permission = 'admin:hosting:approve'`,
        [o.approverId],
      )
    ).rowCount;
    if (!approver)
      throw new ProblemException(
        'validation_failed',
        'the approver does not hold admin:hosting:approve',
      );
    await c.query(
      `INSERT INTO hosting.node_overcommit_changes (id, node_id, from_factor, to_factor, reason, requested_by, approver_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), n.id, n.overcommit_factor, factor, reason, actor, o.approverId],
    );
    await this.audit.record({
      action: 'hosting.node.overcommit.requested',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'hosting_node', id: n.id as string },
      outcome: 'success',
      after: { toFactor: factor },
    });
  }

  /** The control-plane side of "audit log shipped to the control plane": append entries after verifying the chain continues from the stored head. */
  async shipAudit(nodeId: string, entries: readonly AuditEntry[]): Promise<{ stored: number }> {
    if (!UUID.test(nodeId)) throw new ProblemException('not_found', 'node not found');
    return this.db.withPlatformScope(async (c) => {
      await this.load(c, nodeId);
      const head = (
        await c.query(
          `SELECT agent_seq, hash FROM hosting.node_command_log WHERE node_id = $1 ORDER BY agent_seq DESC LIMIT 1`,
          [nodeId],
        )
      ).rows[0];
      let seq = head ? Number(head.agent_seq) : 0;
      let prev = (head?.hash as string | undefined) ?? ZERO_HASH;
      let stored = 0;
      for (const e of entries) {
        if (e.seq <= seq) continue; // already stored (redelivery)
        const { hash, ...base } = e;
        if (e.seq !== seq + 1 || e.prevHash !== prev || auditHash(base) !== hash)
          throw new ProblemException(
            'conflict',
            `the agent audit chain is broken at entry ${e.seq}`,
          );
        await c.query(
          `INSERT INTO hosting.node_command_log (id, node_id, agent_seq, operation_id, command_id, outcome, reason, envelope_hash, prev_hash, hash, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            uuidv7(),
            nodeId,
            e.seq,
            e.operationId,
            e.commandId,
            e.outcome,
            e.reason,
            e.envelopeHash,
            e.prevHash,
            e.hash,
            e.occurredAt,
          ],
        );
        seq = e.seq;
        prev = e.hash;
        stored++;
      }
      return { stored };
    });
  }
  async commandLog(nodeId: string, limit = 100) {
    if (!UUID.test(nodeId)) throw new ProblemException('not_found', 'node not found');
    return this.db.withPlatformScope(async (c) => {
      await this.load(c, nodeId);
      const rows = (
        await c.query(
          `SELECT agent_seq, operation_id, command_id, outcome, reason, occurred_at FROM hosting.node_command_log WHERE node_id = $1 ORDER BY agent_seq DESC LIMIT $2`,
          [nodeId, Math.min(Math.max(limit, 1), 500)],
        )
      ).rows;
      return rows.map((r) => ({
        seq: Number(r.agent_seq),
        operationId: (r.operation_id as string | null) ?? null,
        commandId: (r.command_id as string | null) ?? null,
        outcome: r.outcome as string,
        reason: (r.reason as string | null) ?? null,
        occurredAt: iso(r.occurred_at)!,
      }));
    });
  }
  async listAgents() {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT a.id, a.node_id, a.state, a.version, a.enrolled_at, a.last_seen_at, a.cert_rotated_at, n.name AS node_name FROM hosting.node_agents a JOIN hosting.nodes n ON n.id = a.node_id ORDER BY a.created_at DESC LIMIT 200`,
        )
      ).rows.map((r) => ({
        id: r.id as string,
        nodeId: r.node_id as string,
        nodeName: r.node_name as string,
        state: r.state as string,
        version: (r.version as string | null) ?? null,
        enrolledAt: iso(r.enrolled_at),
        lastSeenAt: iso(r.last_seen_at),
        certRotatedAt: iso(r.cert_rotated_at),
      })),
    );
  }
}
