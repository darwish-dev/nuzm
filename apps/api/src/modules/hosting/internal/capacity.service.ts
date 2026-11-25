import type { PoolClient } from 'pg';
import { ProblemException } from '../../../common/errors';
import type { HostingConfig } from './config';
import { DIMS, type Dim } from './nodes.service';

export interface Need {
  cpu_millicores: number;
  memory_mb: number;
  disk_mb: number;
  sites: number;
}
export const needOf = (r: {
  cpu_millicores: number;
  memory_mb: number;
  disk_mb: number;
}): Need => ({
  cpu_millicores: r.cpu_millicores,
  memory_mb: r.memory_mb,
  disk_mb: r.disk_mb,
  sites: 1,
});
const ZERO: Need = { cpu_millicores: 0, memory_mb: 0, disk_mb: 0, sites: 0 };

export interface Candidate {
  nodeId: string;
  /** free ratio of the tightest dimension after this need, 0..1 (used by the strategies) */
  freeRatio: number;
}

/**
 * Capacity scheduler (M06 §4 task 5). The reservation model is `node_capacity.reserved` against `sellable`:
 *  - every reservation is ONE conditional UPDATE `reserved = reserved + n WHERE reserved + n <= sellable` per dimension, inside the caller's allocation transaction,
 *    after the node's capacity rows were locked in a fixed order (no deadlocks, no lost updates);
 *  - the database re-checks at commit that reserved equals the sum of the allocation rows (hosting.check_node_reserved) and CHECKs reserved <= sellable;
 *  - there is no overcommit unless a dual-approved factor above 1.0 raised `sellable` (nodes.service);
 *  - a failed reservation leaves nothing behind (the savepoint rolls back the partial update).
 * Every method takes the caller's PoolClient and must run inside `Db.withPlatformScope`: capacity data is platform data.
 */
export class CapacityService {
  constructor(private readonly cfg: HostingConfig) {}

  /** Active, healthy nodes of the given data regions that offer the runtime, ordered by the configured strategy. Region filtering by residency is done by the caller. */
  async candidates(
    c: PoolClient,
    q: { regions: string[]; runtime: string; need: Need; excludeNodeId?: string },
  ): Promise<Candidate[]> {
    if (q.regions.length === 0) return [];
    const rows = (
      await c.query(
        `SELECT n.id, n.runtimes,
                json_object_agg(cap.dim, json_build_object('sellable', cap.sellable, 'reserved', cap.reserved)) AS dims
           FROM hosting.nodes n JOIN hosting.node_capacity cap ON cap.node_id = n.id
          WHERE n.status = 'active' AND n.network_class = 'shared' AND n.health = 'healthy' AND n.data_region = ANY($1::text[]) AND ($2::uuid IS NULL OR n.id <> $2)
          GROUP BY n.id`,
        [q.regions, q.excludeNodeId ?? null],
      )
    ).rows;
    const out: Candidate[] = [];
    for (const r of rows) {
      if (!(r.runtimes as string[]).includes(q.runtime)) continue;
      const dims = r.dims as Record<Dim, { sellable: number; reserved: number }>;
      let tightest = 1;
      let fits = true;
      for (const d of DIMS) {
        const x = dims[d];
        if (!x) {
          fits = false;
          break;
        }
        const free = Number(x.sellable) - Number(x.reserved) - q.need[d];
        if (free < 0) {
          fits = false;
          break;
        }
        tightest = Math.min(tightest, Number(x.sellable) === 0 ? 0 : free / Number(x.sellable));
      }
      if (fits) out.push({ nodeId: r.id as string, freeRatio: tightest });
    }
    // spread: the node with the most free capacity first; binpack: the fullest node that still fits first. Ties by id: deterministic.
    out.sort(
      (a, b) =>
        (this.cfg.strategy === 'spread' ? b.freeRatio - a.freeRatio : a.freeRatio - b.freeRatio) ||
        a.nodeId.localeCompare(b.nodeId),
    );
    return out;
  }

  /** Reserve `need` on ONE node. Returns false (and changes nothing) when any dimension would exceed `sellable`. */
  async tryReserve(c: PoolClient, nodeId: string, need: Need): Promise<boolean> {
    await c.query('SAVEPOINT cap_reserve');
    await c.query(
      `SELECT dim FROM hosting.node_capacity WHERE node_id = $1 ORDER BY dim FOR UPDATE`,
      [nodeId],
    );
    const r = await c.query(
      `WITH u AS (
         UPDATE hosting.node_capacity c SET reserved = c.reserved + v.n, updated_at = now()
           FROM (VALUES ('cpu_millicores', $2::bigint), ('memory_mb', $3::bigint), ('disk_mb', $4::bigint), ('sites', $5::bigint)) AS v(dim, n)
          WHERE c.node_id = $1 AND c.dim = v.dim AND c.reserved + v.n <= c.sellable
        RETURNING c.dim)
       SELECT count(*)::int AS n FROM u`,
      [nodeId, need.cpu_millicores, need.memory_mb, need.disk_mb, need.sites],
    );
    if (r.rows[0]!.n !== 4) {
      await c.query('ROLLBACK TO SAVEPOINT cap_reserve');
      await c.query('RELEASE SAVEPOINT cap_reserve');
      return false;
    }
    await c.query('RELEASE SAVEPOINT cap_reserve');
    return true;
  }

  /** Allocate a site: try the candidates in order; the first whose conditional update succeeds wins. Throws 409 no_capacity (never oversells). */
  async allocate(
    c: PoolClient,
    siteId: string,
    q: { regions: string[]; runtime: string; need: Need; excludeNodeId?: string },
  ): Promise<{ nodeId: string }> {
    const cands = await this.candidates(c, q);
    for (const cand of cands) {
      if (!(await this.tryReserve(c, cand.nodeId, q.need))) continue;
      await c.query(
        `INSERT INTO hosting.site_allocations (site_id, node_id, cpu_millicores, memory_mb, disk_mb, sites) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          siteId,
          cand.nodeId,
          q.need.cpu_millicores,
          q.need.memory_mb,
          q.need.disk_mb,
          q.need.sites,
        ],
      );
      return { nodeId: cand.nodeId };
    }
    throw new ProblemException(
      'no_capacity',
      'no hosting node has capacity for this site right now',
    );
  }

  /** Change a site's reservation (plan change). Growth is a conditional update (409 no_capacity when the node cannot take it); shrinkage releases. */
  async resize(c: PoolClient, siteId: string, next: Need): Promise<void> {
    const cur = (
      await c.query(
        `SELECT node_id, cpu_millicores, memory_mb, disk_mb, sites FROM hosting.site_allocations WHERE site_id = $1 FOR UPDATE`,
        [siteId],
      )
    ).rows[0];
    if (!cur) throw new ProblemException('not_found', 'the site has no allocation');
    const delta: Need = {
      cpu_millicores: next.cpu_millicores - Number(cur.cpu_millicores),
      memory_mb: next.memory_mb - Number(cur.memory_mb),
      disk_mb: next.disk_mb - Number(cur.disk_mb),
      sites: 0,
    };
    await c.query('SAVEPOINT cap_resize');
    await c.query(
      `SELECT dim FROM hosting.node_capacity WHERE node_id = $1 ORDER BY dim FOR UPDATE`,
      [cur.node_id],
    );
    const r = await c.query(
      `WITH u AS (
         UPDATE hosting.node_capacity c SET reserved = c.reserved + v.n, updated_at = now()
           FROM (VALUES ('cpu_millicores', $2::bigint), ('memory_mb', $3::bigint), ('disk_mb', $4::bigint), ('sites', 0::bigint)) AS v(dim, n)
          WHERE c.node_id = $1 AND c.dim = v.dim AND c.reserved + v.n <= c.sellable AND c.reserved + v.n >= 0
        RETURNING c.dim)
       SELECT count(*)::int AS n FROM u`,
      [cur.node_id, delta.cpu_millicores, delta.memory_mb, delta.disk_mb],
    );
    if (r.rows[0]!.n !== 4) {
      await c.query('ROLLBACK TO SAVEPOINT cap_resize');
      await c.query('RELEASE SAVEPOINT cap_resize');
      throw new ProblemException(
        'no_capacity',
        'the site node cannot take the larger plan right now',
      );
    }
    await c.query('RELEASE SAVEPOINT cap_resize');
    await c.query(
      `UPDATE hosting.site_allocations SET cpu_millicores = $2, memory_mb = $3, disk_mb = $4, updated_at = now() WHERE site_id = $1`,
      [siteId, next.cpu_millicores, next.memory_mb, next.disk_mb],
    );
  }

  /** Release a site's reservation (failed create, deletion, migration cut-over). Idempotent. */
  async release(c: PoolClient, siteId: string): Promise<boolean> {
    const cur = (
      await c.query(
        `DELETE FROM hosting.site_allocations WHERE site_id = $1 RETURNING node_id, cpu_millicores, memory_mb, disk_mb, sites`,
        [siteId],
      )
    ).rows[0];
    if (!cur) return false;
    await c.query(
      `SELECT dim FROM hosting.node_capacity WHERE node_id = $1 ORDER BY dim FOR UPDATE`,
      [cur.node_id],
    );
    await c.query(
      `UPDATE hosting.node_capacity c SET reserved = c.reserved - v.n, updated_at = now()
         FROM (VALUES ('cpu_millicores', $2::bigint), ('memory_mb', $3::bigint), ('disk_mb', $4::bigint), ('sites', $5::bigint)) AS v(dim, n)
        WHERE c.node_id = $1 AND c.dim = v.dim`,
      [cur.node_id, cur.cpu_millicores, cur.memory_mb, cur.disk_mb, cur.sites],
    );
    return true;
  }

  /** Move a site's reservation to another node (migration cut-over): reserve on the target first, then release the source, in one transaction. */
  async move(c: PoolClient, siteId: string, targetNodeId: string): Promise<void> {
    const cur = (
      await c.query(
        `SELECT node_id, cpu_millicores, memory_mb, disk_mb, sites FROM hosting.site_allocations WHERE site_id = $1 FOR UPDATE`,
        [siteId],
      )
    ).rows[0];
    if (!cur) throw new ProblemException('not_found', 'the site has no allocation');
    if (cur.node_id === targetNodeId) return;
    const need: Need = {
      cpu_millicores: Number(cur.cpu_millicores),
      memory_mb: Number(cur.memory_mb),
      disk_mb: Number(cur.disk_mb),
      sites: Number(cur.sites),
    };
    // lock order across two nodes: by node id, to stay deadlock free
    if (!(await this.tryReserve(c, targetNodeId, need)))
      throw new ProblemException('no_capacity', 'the target node has no capacity');
    await c.query(
      `UPDATE hosting.node_capacity c SET reserved = c.reserved - v.n, updated_at = now() FROM (VALUES ('cpu_millicores', $2::bigint), ('memory_mb', $3::bigint), ('disk_mb', $4::bigint), ('sites', $5::bigint)) AS v(dim, n) WHERE c.node_id = $1 AND c.dim = v.dim`,
      [cur.node_id, need.cpu_millicores, need.memory_mb, need.disk_mb, need.sites],
    );
    await c.query(
      `UPDATE hosting.site_allocations SET node_id = $2, updated_at = now() WHERE site_id = $1`,
      [siteId, targetNodeId],
    );
  }
}
export { ZERO };
