import type { Db } from '@nuzm/platform';
import type { ResidencyEvaluator } from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import { DIMS, type Dim } from './nodes.service';
import type { Need } from './capacity.service';

type Row = Record<string, unknown>;
export interface PlanDto {
  id: string;
  key: string;
  name: { ar: string; en: string };
  quotas: {
    diskMb: number;
    inodes: number;
    bandwidthGb: number;
    dbCount: number;
    sitesCount: number;
    maxProcesses?: number;
    backupCount?: number;
    backupGb?: number;
  };
  price: { amountMinor: string; currency: string; placeholder: boolean } | null;
  runtimes: string[];
  /** data regions of the eligible nodes; `country` is set when exactly one. */
  regions: string[];
  country: string | null;
}
export interface PlanRow {
  id: string;
  key: string;
  status: string;
  quotas: PlanDto['quotas'];
  runtimes: string[];
  reservation: { cpu_millicores: number; memory_mb: number; disk_mb: number };
  priceMinor: string | null;
  currency: string;
  placeholder: boolean;
  nameAr: string;
  nameEn: string;
}
export const planRow = (r: Row): PlanRow => ({
  id: r.id as string,
  key: r.key as string,
  status: r.status as string,
  quotas: r.quotas as PlanDto['quotas'],
  runtimes: r.runtimes as string[],
  reservation: r.reservation as PlanRow['reservation'],
  priceMinor: r.price_minor === null ? null : String(r.price_minor),
  currency: (r.currency as string).trim(),
  placeholder: r.placeholder as boolean,
  nameAr: r.name_ar as string,
  nameEn: r.name_en as string,
});
export const planNeed = (p: PlanRow): Need => ({
  cpu_millicores: Number(p.reservation.cpu_millicores),
  memory_mb: Number(p.reservation.memory_mb),
  disk_mb: Number(p.reservation.disk_mb),
  sites: 1,
});
export const planLimits = (p: PlanRow) => ({
  diskMb: Number(p.quotas.diskMb),
  inodes: Number(p.quotas.inodes),
  maxProcesses: Number(p.quotas.maxProcesses ?? 50),
  memoryMb: Number(p.reservation.memory_mb),
  bandwidthGbMonth: Number(p.quotas.bandwidthGb),
});

/** A runtime id (`php:8.3`) belongs to a plan family when the plan lists its kind (`php`) or the exact id. */
export const planOffersRuntime = (p: PlanRow, runtime: string) =>
  p.runtimes.includes(runtime) || p.runtimes.includes(runtime.split(':')[0]!);

export class PlansService {
  constructor(
    private readonly db: Db,
    private readonly residency: ResidencyEvaluator,
  ) {}

  async load(id: string): Promise<PlanRow | null> {
    return this.db.withPlatformScope(async (c) => {
      const r = (await c.query(`SELECT * FROM hosting.plan_definitions WHERE id = $1`, [id]))
        .rows[0];
      return r ? planRow(r) : null;
    });
  }

  /**
   * Data regions where an active, healthy node offers `runtime` AND the organization's residency policy allows hosting its data (`orgId` given).
   * Returns `{regions, residencyDenied}`: denied = there are nodes but the policy refuses every region (the API answers 403 residency_denied, not no_capacity).
   */
  async eligibleRegions(
    orgId: string,
    runtime?: string,
  ): Promise<{ regions: string[]; candidateRegions: string[]; residencyDenied: boolean }> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT data_region, runtimes FROM hosting.nodes WHERE status = 'active' AND health = 'healthy'`,
          )
        ).rows,
    );
    const candidate = new Set<string>();
    for (const r of rows)
      if (!runtime || (r.runtimes as string[]).includes(runtime))
        candidate.add(r.data_region as string);
    const allowed: string[] = [];
    for (const region of candidate) {
      const d = await this.residency.evaluate({
        orgId,
        dataClass: 'customer-content',
        targetRegion: region,
        purpose: 'hosting_placement',
        operation: 'write',
      });
      if (d.decision === 'allow') allowed.push(region);
    }
    return {
      regions: allowed.sort(),
      candidateRegions: [...candidate].sort(),
      residencyDenied: candidate.size > 0 && allowed.length === 0,
    };
  }

  /** `GET /v1/hosting/plans`: ONLY plans that have at least one eligible node with room for the plan (capacity-less plans are hidden). */
  async list(orgId: string): Promise<PlanDto[]> {
    const { regions } = await this.eligibleRegions(orgId);
    if (regions.length === 0) return [];
    return this.db.withPlatformScope(async (c) => {
      const plans = (
        await c.query(
          `SELECT * FROM hosting.plan_definitions WHERE status = 'active' ORDER BY price_minor NULLS LAST, key`,
        )
      ).rows.map(planRow);
      const nodes = (
        await c.query(
          `SELECT n.id, n.data_region, n.runtimes, json_object_agg(c.dim, json_build_object('free', c.sellable - c.reserved)) AS free
             FROM hosting.nodes n JOIN hosting.node_capacity c ON c.node_id = n.id
            WHERE n.status = 'active' AND n.health = 'healthy' AND n.data_region = ANY($1::text[]) GROUP BY n.id`,
          [regions],
        )
      ).rows;
      const out: PlanDto[] = [];
      for (const p of plans) {
        const need = planNeed(p);
        const ok = new Set<string>();
        for (const n of nodes) {
          const free = n.free as Record<Dim, { free: number }>;
          const fits = DIMS.every((d) => Number(free[d]?.free ?? 0) >= need[d]);
          const offers = (n.runtimes as string[]).some((rt) => planOffersRuntime(p, rt));
          if (fits && offers) ok.add(n.data_region as string);
        }
        if (ok.size === 0) continue;
        const rt = [
          ...new Set(
            nodes
              .filter((n) => ok.has(n.data_region as string))
              .flatMap((n) => n.runtimes as string[])
              .filter((r) => planOffersRuntime(p, r)),
          ),
        ].sort();
        out.push({
          id: p.id,
          key: p.key,
          name: { ar: p.nameAr, en: p.nameEn },
          quotas: p.quotas,
          price:
            p.priceMinor === null
              ? null
              : { amountMinor: p.priceMinor, currency: p.currency, placeholder: p.placeholder },
          runtimes: rt,
          regions: [...ok].sort(),
          country: ok.size === 1 ? [...ok][0]! : null,
        });
      }
      return out;
    });
  }
}
export { ProblemException };
