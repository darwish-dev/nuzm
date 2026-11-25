import { createHash } from 'node:crypto';
import { builderTools } from '@nuzm/domain';
import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { ResidencyService } from '../../../compliance';
import { flagOn } from '../flag.guard';
import { OrgBudgetPort } from '../ports/m09';
import type { ExecutionBudgetPort, ExecutionPurpose } from './lifecycle.types';

const L = builderTools.lifecycle;

/** a stable uuid for a metering resource key (the usage table keys resources by uuid) */
const uuidFrom = (key: string): string => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * `builder.billing_separation` (default OFF = today's behaviour: every sandbox start needs AI credit). ON: execution work (a release build, an agent build) is gated by the plan's
 * build allowance and the platform ceilings instead of the AI wallet; inference stays gated by the wallet through the model gateway (ADR-061). See `lifecycle/policy.ts` and
 * REPORT-05 "Phase 2" for the finding and the design.
 */
export const BILLING_SEPARATION_FLAG = 'builder.billing_separation';
/** the quota group of the build allowance (`billing.quota_meters` maps it to `builder.build_minutes`; the row is a CONTRACT request, absent today = "unmeasured") */
export const BUILD_QUOTA_GROUP = 'builder';

/** the billing side of the QuotaService, narrowed to what the gate needs */
export interface QuotaPort {
  check(
    orgId: string,
    group: string,
    projected: string,
  ): Promise<{ allowed: boolean; measured: boolean }>;
}
/**
 * One gate for every start of EXECUTION: residency, the platform ceilings, and then either the legacy AI-wallet rule or the build allowance. It decides with the pure
 * `decideExecutionStart` (tested for both settings) and writes an audit event with the gates it evaluated, so a refusal and an admission are both explainable.
 */
export class ExecutionGate {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly wallet: OrgBudgetPort,
    private readonly quota: QuotaPort | null,
    private readonly cfg: { nodeRegion: string; concurrentPerOrg: number },
  ) {}

  async facts(
    orgId: string,
    opts: { checkCeilings: boolean },
  ): Promise<builderTools.lifecycle.StartFacts> {
    const separationEnabled = await flagOn(this.db, orgId, BILLING_SEPARATION_FLAG);
    const residencyAllowed = opts.checkCeilings
      ? (
          await this.residency.evaluate({
            orgId,
            dataClass: 'customer-content',
            targetRegion: this.cfg.nodeRegion,
            purpose: 'sandbox_placement',
            operation: 'write',
          })
        ).decision === 'allow'
      : true;
    const platformCeilingOk = opts.checkCeilings
      ? (await this.activeSandboxes(orgId)) < this.cfg.concurrentPerOrg
      : true;
    // the wallet is read only when a rule can use it
    const aiCreditMinor = await this.wallet.remainingMinor(orgId);
    // one minute is the smallest thing worth asking the allowance about; a missing quota row reads as "unmeasured", never as "unlimited"
    const q = this.quota ? await this.quota.check(orgId, BUILD_QUOTA_GROUP, '1') : null;
    return {
      separationEnabled,
      residencyAllowed,
      platformCeilingOk,
      aiCreditMinor,
      buildQuota: { allowed: q ? q.allowed : true, measured: q ? q.measured : false },
    };
  }

  private async activeSandboxes(orgId: string): Promise<number> {
    return this.db.withOrg(orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*)::int n FROM builder.sandboxes WHERE org_id = $1 AND state IN ('starting','ready','terminating')`,
            [orgId],
          )
        ).rows[0]!.n,
      ),
    );
  }

  async decide(
    orgId: string,
    purpose: ExecutionPurpose,
    opts: { checkCeilings: boolean },
  ): Promise<builderTools.lifecycle.StartDecision> {
    const d = L.decideExecutionStart(purpose, await this.facts(orgId, opts));
    await this.audit.record({
      action: 'builder.execution.start_decided',
      orgId,
      actorType: 'system',
      resource: { type: 'organization', id: orgId },
      outcome: d.allowed ? 'success' : 'failure',
      detail: { purpose, gates: d.gates, ...(d.allowed ? {} : { code: d.code, gate: d.gate }) },
    });
    return d;
  }
}

/** The gate for the lifecycle's own execution steps (agent builds). */
export class ExecutionBudgetService implements ExecutionBudgetPort {
  constructor(
    private readonly gate: ExecutionGate,
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly region: string,
  ) {}

  async assertStart(orgId: string, purpose: ExecutionPurpose) {
    const d = await this.gate.decide(orgId, purpose, { checkCeilings: true });
    if (!d.allowed) {
      const messages: Record<string, string> = {
        residency_denied: 'execution is not allowed in this region by the residency policy',
        sandbox_quota_exceeded: 'the concurrent execution limit of this organization is reached',
        budget_required: 'the organization has no AI credit left for this run',
        quota_exceeded: 'the build allowance of the plan is used up; new builds are blocked',
      };
      throw new ProblemException(d.code, messages[d.code] ?? 'execution may not start');
    }
    return { gates: d.gates };
  }

  /**
   * One metering event per execution, idempotent by `eventKey`. A SIMULATED execution (a mock port) is NOT usage: nothing ran, so nothing is billed; it is audited as
   * simulated instead. A real execution always emits `builder.build_minutes`.
   */
  async meter(
    orgId: string,
    projectId: string,
    e: {
      eventKey: string;
      profile: string;
      durationMs: number;
      origin: 'MOCK' | 'REAL';
      at: string;
    },
  ): Promise<void> {
    if (e.origin === 'MOCK') {
      await this.audit.record({
        action: 'builder.execution.simulated',
        orgId,
        actorType: 'system',
        resource: { type: 'project', id: projectId },
        outcome: 'success',
        detail: { profile: e.profile, key: e.eventKey, billed: false },
      });
      return;
    }
    const start = new Date(e.at);
    const end = new Date(start.getTime() + Math.max(1, e.durationMs));
    await this.db.withOrg(orgId, (c) =>
      emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: 'builder.build_minutes',
          resourceId: uuidFrom(e.eventKey),
          windowStart: start.toISOString(),
        }),
        orgId,
        meterId: 'builder.build_minutes',
        quantity: (Math.max(1, e.durationMs) / 60_000).toFixed(3),
        unit: 'minute',
        resourceId: uuidFrom(e.eventKey),
        projectId,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        occurredAt: end.toISOString(),
        dimensions: { project_type: 'webapp' },
        dataRegion: this.region,
        source: 'builder@S05',
      }),
    );
  }
}

/**
 * The budget port of the SANDBOX that builds a release (a second `SandboxService` instance shares the runtime and the database with the first one). While the separation switch
 * is OFF it answers exactly what the AI wallet answers (today's behaviour: positive only with AI credit). ON, a release build needs the build allowance, not the wallet: it answers a positive amount when the
 * gate admits and 0 when it does not, which the sandbox reads as "no". The sandbox itself still checks residency, capacity and the concurrent limit atomically.
 */
export class ReleaseBuildBudget extends OrgBudgetPort {
  constructor(private readonly gate: ExecutionGate) {
    super();
  }
  async remainingMinor(orgId: string): Promise<number> {
    // switch OFF: the decision IS the legacy rule (AI credit > 0); ON: the build allowance. Either way the sandbox only asks "more than zero?"
    const d = await this.gate.decide(orgId, 'release_build', { checkCeilings: false });
    return d.allowed ? 1 : 0;
  }
}
