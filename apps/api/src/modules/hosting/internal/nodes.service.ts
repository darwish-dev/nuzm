import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { AccountContext } from './m05-contracts';
import type { ComputeProvisioningPort, HostingAdapter } from './ports';
import type { HostingConfig } from './config';
import type { SealedVault } from '../../../common/sealed-vault';
import { isFingerprint, isPanelHost } from './hestia/client';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
export const DIMS = ['cpu_millicores', 'memory_mb', 'disk_mb', 'sites'] as const;
export type Dim = (typeof DIMS)[number];

export interface NodeDto {
  id: string;
  name: string;
  computeInstanceId: string;
  region: string;
  dataRegion: string;
  status: string;
  panelKind: string;
  /** `shared` (Nuzm's hosting network) or `customer_vps` (a customer's own server: outside it, never receives shared sites) */
  networkClass: string;
  panelVersion: string | null;
  panelHost: string | null;
  panelPort: number | null;
  /** a panel host AND an access key are set: the node can be probed. The key itself is never returned. */
  panelConfigured: boolean;
  /** the panel certificate is pinned by fingerprint (a self-signed certificate); false = validated by a certificate authority */
  panelTlsPinned: boolean;
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
  panelKind: r.panel_kind as string,
  networkClass: (r.network_class as string | undefined) ?? 'shared',
  panelVersion: (r.panel_version as string | null) ?? null,
  panelHost: (r.panel_host as string | null) ?? null,
  panelPort: r.panel_port === null || r.panel_port === undefined ? null : Number(r.panel_port),
  panelConfigured: !!r.panel_host && !!r.panel_key_ref,
  panelTlsPinned: !!r.panel_tls_pin,
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
const SELECT = `SELECT n.* FROM hosting.nodes n`;
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
    /** where a typed panel access key goes (sealed store, non-production). Absent = typed keys are refused. */
    private readonly sealed?: SealedVault,
  ) {}

  private ctx(nodeId: string): AccountContext {
    return {
      providerAccountId: 'platform-hosting',
      credentialRef: 'vault://hosting/panel-access',
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

  /** Register a node on a platform-owned compute instance (M05 port). The panel connection is set next (`setPanel`). */
  async create(
    actor: string,
    input: Record<string, unknown>,
  ): Promise<{ node: NodeDto; created: boolean }> {
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
          created: false,
        };
      const id = uuidv7();
      await c.query(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, name, instance, info.region, info.dataRegion, actor],
      );
      await this.audit.record({
        action: 'hosting.node.created',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'hosting_node', id },
        outcome: 'success',
        detail: { dataRegion: info.dataRegion },
      });
      return { node: dto(await this.load(c, id), undefined), created: true };
    });
  }

  // ---- S04: a customer's VPS that runs HestiaCP --------------------------------------------------------------------------------
  /**
   * Registers the customer's own VPS as a node of class `customer_vps`: outside the shared-hosting network (placement, capacity and plans only ever read `shared` nodes), owned by one
   * organization, `maintenance` for good (a shared site is never placed on it), with a READ-ONLY panel key. Idempotent per compute instance.
   */
  async registerCustomerVps(a: {
    orgId: string;
    instanceId: string;
    name: string;
    region: string;
    dataRegion: string;
    panelHost: string;
    panelPort: number;
    tlsPinSha256: string | null;
    keyRef: string;
    panelVersion: string | null;
  }): Promise<{ nodeId: string }> {
    if (!isPanelHost(a.panelHost))
      throw new ProblemException('validation_failed', 'panel host is not an fqdn');
    if (a.tlsPinSha256 && !isFingerprint(a.tlsPinSha256))
      throw new ProblemException('validation_failed', 'invalid TLS fingerprint');
    return this.db.withPlatformScope(async (c) => {
      const existing = (
        await c.query(
          `SELECT id, network_class, owner_org_id FROM hosting.nodes WHERE compute_instance_id = $1`,
          [a.instanceId],
        )
      ).rows[0];
      if (existing) {
        if (existing.network_class !== 'customer_vps' || existing.owner_org_id !== a.orgId)
          throw new ProblemException(
            'conflict',
            'this compute instance is already a different kind of node',
          );
        await c.query(
          `UPDATE hosting.nodes SET panel_host = $2, panel_port = $3, panel_tls_pin = $4, panel_key_ref = $5, panel_version = COALESCE($6, panel_version), updated_at = now() WHERE id = $1`,
          [existing.id, a.panelHost, a.panelPort, a.tlsPinSha256, a.keyRef, a.panelVersion],
        );
        return { nodeId: existing.id as string };
      }
      const id = uuidv7();
      await c.query(
        `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, network_class, owner_org_id, panel_host, panel_port, panel_tls_pin, panel_key_ref, panel_version)
         VALUES ($1,$2,$3,$4,$5,'maintenance','customer_vps',$6,$7,$8,$9,$10,$11)`,
        [
          id,
          a.name,
          a.instanceId,
          a.region,
          a.dataRegion,
          a.orgId,
          a.panelHost,
          a.panelPort,
          a.tlsPinSha256,
          a.keyRef,
          a.panelVersion,
        ],
      );
      await this.audit.record({
        action: 'hosting.node.created',
        orgId: a.orgId,
        actorType: 'system',
        resource: { type: 'hosting_node', id },
        outcome: 'success',
        detail: { networkClass: 'customer_vps', dataRegion: a.dataRegion },
      });
      return { nodeId: id };
    });
  }

  async retireCustomerVps(nodeId: string): Promise<void> {
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.nodes SET status = 'retired', health = 'unknown', updated_at = now() WHERE id = $1 AND network_class = 'customer_vps'`,
        [nodeId],
      ),
    );
  }

  /** Read-only readiness of a customer VPS panel: health (one documented read), the version it reports, and the proof that the key is as narrow as intended. */
  async checkCustomerVps(nodeId: string) {
    const n = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT compute_instance_id, network_class FROM hosting.nodes WHERE id = $1`,
            [nodeId],
          )
        ).rows[0],
    );
    if (!n || n.network_class !== 'customer_vps')
      throw new ProblemException('not_found', 'node not found');
    const ref = { nodeId, computeInstanceId: n.compute_instance_id as string };
    const h = await this.adapter.health(this.ctx(nodeId), ref);
    let profile: 'read_only' | 'too_broad' | 'unknown' = 'unknown';
    if (h.state === 'healthy')
      profile = (await this.adapter.verifyReadOnlyKey?.(this.ctx(nodeId), ref)) ?? 'unknown';
    await this.db.withPlatformScope((c) =>
      c.query(`UPDATE hosting.nodes SET health = $2, updated_at = now() WHERE id = $1`, [
        nodeId,
        h.state,
      ]),
    );
    const panelVersion = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT panel_version FROM hosting.nodes WHERE id = $1`, [nodeId])).rows[0]
          ?.panel_version,
    )) as string | null;
    return { health: h.state, panelVersion, profile, ...(h.detail ? { code: h.detail } : {}) };
  }

  /** The inventory job: probe + inventory through the adapter; stores versions, health and runtimes and sizes the node's capacity rows. */
  async runInventory(nodeId: string): Promise<NodeDto> {
    const n = await this.db.withPlatformScope(async (c) => this.load(c, nodeId));
    if (!n.panel_host || !n.panel_key_ref)
      throw new ProblemException('conflict', 'the node has no panel connection yet');
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
        `UPDATE hosting.nodes SET panel_version = $2, runtimes = $3, health = $4, last_inventory = $5, last_inventory_at = now(), updated_at = now() WHERE id = $1`,
        [
          nodeId,
          d.panelVersion,
          JSON.stringify(probe.runtimes.length ? probe.runtimes : d.runtimes),
          d.health.state,
          JSON.stringify({ usage: d.usage, panelKind: d.panelKind, capacity: d.capacity }),
        ],
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
      if (!n.panel_host || !n.panel_key_ref)
        throw new ProblemException('conflict', 'the node has no panel connection yet');
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

  /**
   * Sets how the node's HestiaCP panel is reached: a fixed FQDN, a port (default 8083), an optional pinned TLS fingerprint (a self-signed panel certificate) and the access key,
   * typed here (write-only, sealed) or as a vault reference. Any change clears the node's health: it must be probed again before it can serve (inventory).
   */
  async setPanel(actor: string, nodeId: string, body: Record<string, unknown>): Promise<NodeDto> {
    if (!UUID.test(nodeId)) throw new ProblemException('not_found', 'node not found');
    const allowed = new Set(['host', 'port', 'tlsPinSha256', 'credentials', 'vaultRef']);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (typeof body.host !== 'string' || !isPanelHost(body.host.trim().toLowerCase()))
      throw new ProblemException(
        'validation_failed',
        "host must be the panel's fully qualified domain name",
      );
    const host = body.host.trim().toLowerCase();
    const port = body.port === undefined ? 8083 : body.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new ProblemException('validation_failed', 'port must be an integer 1..65535');
    let pin: string | null = null;
    if (body.tlsPinSha256 !== undefined && body.tlsPinSha256 !== null && body.tlsPinSha256 !== '') {
      if (typeof body.tlsPinSha256 !== 'string' || !isFingerprint(body.tlsPinSha256.trim()))
        throw new ProblemException(
          'validation_failed',
          'tlsPinSha256 must be a SHA-256 fingerprint (32 colon-separated hex pairs)',
        );
      pin = body.tlsPinSha256.trim().toUpperCase();
    }
    let keyRef: string | null = null;
    if (body.credentials !== undefined && body.credentials !== null) {
      const c = body.credentials as Record<string, unknown>;
      if (
        typeof c !== 'object' ||
        Array.isArray(c) ||
        Object.keys(c).some((k) => k !== 'accessKey')
      )
        throw new ProblemException('validation_failed', 'credentials must be {accessKey}');
      if (
        typeof c.accessKey !== 'string' ||
        !/^[A-Za-z0-9]{8,64}:[\x21-\x7E]{8,128}$/.test(c.accessKey.trim())
      )
        throw new ProblemException(
          'validation_failed',
          'accessKey must be ACCESS_KEY_ID:SECRET_ACCESS_KEY',
        );
      if (body.vaultRef)
        throw new ProblemException('validation_failed', 'send credentials or vaultRef, not both');
      if (!this.sealed || process.env.NODE_ENV === 'production')
        throw new ProblemException(
          'unsupported_capability',
          'storing the key here is not available in this profile: the production vault is not decided yet (D-12); send a vault reference (vaultRef)',
        );
      keyRef = await this.sealed.putFields(`hosting-panel-${nodeId}`, {
        accessKey: c.accessKey.trim(),
      });
    } else if (body.vaultRef !== undefined && body.vaultRef !== null && body.vaultRef !== '') {
      if (
        typeof body.vaultRef !== 'string' ||
        !/^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$/.test(body.vaultRef)
      )
        throw new ProblemException(
          'credential_value_rejected',
          'vaultRef must be a vault:// reference',
        );
      keyRef = body.vaultRef;
    }
    return this.db.withPlatformScope(async (c) => {
      const n = await this.load(c, nodeId);
      if (n.status === 'retired')
        throw new ProblemException('conflict', 'a retired node cannot be changed');
      if (!keyRef && !n.panel_key_ref)
        throw new ProblemException(
          'validation_failed',
          'an access key (credentials or vaultRef) is required the first time',
        );
      await c.query(
        `UPDATE hosting.nodes SET panel_host = $2, panel_port = $3, panel_tls_pin = $4, panel_key_ref = COALESCE($5, panel_key_ref),
                health = 'unknown', last_inventory_at = NULL, status = CASE WHEN status = 'active' THEN 'maintenance' ELSE status END, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [nodeId, host, port, pin, keyRef],
      );
      await this.audit.record({
        action: 'hosting.node.panel_set',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'hosting_node', id: nodeId },
        outcome: 'success',
        after: { host, port, pinned: pin !== null, keyChanged: keyRef !== null },
      });
      return dto(await this.load(c, nodeId), await this.pending(c, nodeId));
    });
  }
}
