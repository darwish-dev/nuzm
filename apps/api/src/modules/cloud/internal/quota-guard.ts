import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';

export interface ComputeLimits {
  maxInstances: number;
  maxVcpu: number;
}
/**
 * Concurrent-resource quotas for compute (`compute.instances.max`, `compute.vcpu.max`, M05 §10). Limits come from the M02 entitlements (meter groups
 * `compute_instances` and `compute_vcpu`, via `billing.effective_limits`); when an org has none, a PROPOSAL default applies (D-23 / HG-02-01 open).
 * Counting + admission happen under one per-org advisory lock inside the creating transaction, so N parallel creates admit exactly the limit.
 */
export class ComputeQuotaGuard {
  constructor(
    private readonly db: Db,
    private readonly defaults: ComputeLimits = {
      maxInstances: Number(process.env.NUZM_COMPUTE_DEFAULT_MAX_INSTANCES ?? 10),
      maxVcpu: Number(process.env.NUZM_COMPUTE_DEFAULT_MAX_VCPU ?? 40),
    },
  ) {}

  async limits(c: PoolClient, orgId: string): Promise<ComputeLimits> {
    const rows = (
      await c.query(
        `SELECT meter_group, limit_value FROM billing.effective_limits($1) WHERE meter_group IN ('compute_instances','compute_vcpu')`,
        [orgId],
      )
    ).rows;
    const by = new Map(
      rows.map((r) => [
        r.meter_group as string,
        r.limit_value === null ? null : Number(r.limit_value),
      ]),
    );
    return {
      maxInstances:
        by.has('compute_instances') && by.get('compute_instances') !== null
          ? by.get('compute_instances')!
          : this.defaults.maxInstances,
      maxVcpu:
        by.has('compute_vcpu') && by.get('compute_vcpu') !== null
          ? by.get('compute_vcpu')!
          : this.defaults.maxVcpu,
    };
  }

  /** Instances that count against the quota: everything that exists or may exist at the provider. */
  async usage(c: PoolClient, orgId: string): Promise<{ instances: number; vcpu: number }> {
    const r = (
      await c.query(
        `SELECT count(*)::int AS n, coalesce(sum((plan->>'vcpu')::int), 0)::int AS v FROM compute.instances WHERE org_id = $1 AND status NOT IN ('deleted','failed')`,
        [orgId],
      )
    ).rows[0]!;
    return { instances: r.n as number, vcpu: r.v as number };
  }

  /** Call inside the transaction that inserts the instance. Serializes admissions per org. */
  async admit(c: PoolClient, orgId: string, addVcpu: number): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compute.quota:${orgId}`]);
    const [limits, usage] = [await this.limits(c, orgId), await this.usage(c, orgId)];
    if (usage.instances + 1 > limits.maxInstances || usage.vcpu + addVcpu > limits.maxVcpu)
      throw new ProblemException(
        'quota_exceeded',
        `the compute quota (${limits.maxInstances} instances / ${limits.maxVcpu} vCPU) would be exceeded; existing resources are untouched`,
      );
  }

  /** vCPU growth of an existing instance (resize): same lock, no new instance. */
  async admitVcpuDelta(c: PoolClient, orgId: string, deltaVcpu: number): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compute.quota:${orgId}`]);
    const [limits, usage] = [await this.limits(c, orgId), await this.usage(c, orgId)];
    if (usage.vcpu + deltaVcpu > limits.maxVcpu)
      throw new ProblemException(
        'quota_exceeded',
        `the compute vCPU quota (${limits.maxVcpu}) would be exceeded; existing resources are untouched`,
      );
  }

  /** Read-only headroom used by offer eligibility (`quotaAllows`). */
  async hasHeadroom(orgId: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const [limits, usage] = [await this.limits(c, orgId), await this.usage(c, orgId)];
      return usage.instances + 1 <= limits.maxInstances && usage.vcpu + 1 <= limits.maxVcpu;
    });
  }
}
