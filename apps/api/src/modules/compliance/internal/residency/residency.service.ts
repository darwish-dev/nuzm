import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { ResidencyEvaluator, ResidencyRequest, ResidencyResult } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import {
  CLASSES,
  evaluate,
  reason,
  type AssessmentRef,
  type DataClass,
  type Floor,
  type Mode,
  type OrgPolicy,
  type ProcessorInfo,
} from './evaluator';
import { belowFloor, parsePolicyBody } from './policy-input';
import type { RegionRegistry } from './regions';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;

export interface ResidencyOptions {
  defaultMode: Mode;
  cacheTtlMs: number;
  maxAssessmentDays: number;
  clock?: () => Date;
}
export interface PolicyView {
  /** 0 = the organization has no policy of its own: the default applies. */
  version: number;
  isDefault: boolean;
  mode: Mode;
  allowedCountriesByClass: Partial<Record<DataClass, string[]>>;
  exceptions: string[];
  floor: { version: number; byClass: Record<DataClass, Mode> };
  updatedAt: string | null;
}

const asPolicy = (r: Row): OrgPolicy => ({
  version: r.version as number,
  mode: r.mode as Mode,
  allowedCountriesByClass: ((
    r.allowed as { allowedCountriesByClass?: OrgPolicy['allowedCountriesByClass'] }
  ).allowedCountriesByClass ?? {}) as OrgPolicy['allowedCountriesByClass'],
  exceptions: (r.exceptions as string[]) ?? [],
});
const asAssessment = (r: Row): AssessmentRef => ({
  id: r.id as string,
  orgId: (r.org_id as string | null) ?? null,
  dataClass: r.data_class as DataClass,
  region: r.region as string,
  processorId: (r.processor_id as string | null) ?? null,
  status: r.status as AssessmentRef['status'],
  expiresAt: r.expires_at as Date,
});

/**
 * Residency (M04 §4 task 7). `evaluate()` is what every module asks BEFORE placing data or calling a vendor or a model: a deterministic decision
 * (evaluator.ts) over the platform floor, the organization's policy and its approved assessments. It FAILS CLOSED: if the policy, the floor or the ROPA
 * cannot be read the answer is deny, on every path. Denials and failures are audited with a decision reference. The organization policy is cached in
 * process for a few seconds and invalidated by this service's own writes; another process may serve a changed policy for at most the cache time.
 */
export class ResidencyService implements ResidencyEvaluator {
  private floor: { at: number; value: Floor } | null = null;
  private readonly orgs = new Map<string, { at: number; policy: OrgPolicy | null }>();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private regions: RegionRegistry,
    private readonly opts: ResidencyOptions,
  ) {}
  private now() {
    return this.opts.clock ? this.opts.clock() : new Date();
  }
  /** M05: replace the region registry (the cloud module installs one backed by `cloud.provider_regions`, falling back to the mock fixtures). */
  useRegionRegistry(r: RegionRegistry) {
    this.regions = r;
  }
  invalidate(orgId?: string) {
    if (orgId) this.orgs.delete(orgId);
    else this.orgs.clear();
    if (!orgId) this.floor = null;
  }

  private async loadFloor(): Promise<Floor> {
    const t = this.now().getTime();
    if (this.floor && t - this.floor.at < this.opts.cacheTtlMs) return this.floor.value;
    const r = (
      await this.db.withoutScope((c) =>
        c.query(
          `SELECT version, allowed FROM compliance.residency_policies WHERE org_id IS NULL ORDER BY version DESC LIMIT 1`,
        ),
      )
    ).rows[0];
    const byClass = (r?.allowed as { floorByClass?: Record<string, Mode> } | undefined)
      ?.floorByClass;
    if (!r || !byClass || CLASSES.some((c) => !byClass[c]))
      throw new Error('the platform residency floor is missing or incomplete');
    const value: Floor = { version: r.version as number, byClass: byClass as Floor['byClass'] };
    this.floor = { at: t, value };
    return value;
  }
  private async loadPolicy(orgId: string): Promise<OrgPolicy | null> {
    const t = this.now().getTime();
    const hit = this.orgs.get(orgId);
    if (hit && t - hit.at < this.opts.cacheTtlMs) return hit.policy;
    const r = (
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `SELECT * FROM compliance.residency_policies WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
          [orgId],
        ),
      )
    ).rows[0];
    const policy = r ? asPolicy(r) : null;
    this.orgs.set(orgId, { at: t, policy });
    return policy;
  }
  private async loadAssessments(orgId: string, ids: string[]): Promise<AssessmentRef[]> {
    if (ids.length === 0) return [];
    return (
      await this.db.withOrg(orgId, (c) =>
        c.query(`SELECT * FROM compliance.transfer_assessments WHERE id = ANY($1::uuid[])`, [ids]),
      )
    ).rows.map(asAssessment);
  }
  private async loadProcessor(name: string): Promise<ProcessorInfo> {
    const rows = (
      await this.db.withPlatformScope((c) =>
        c.query(
          `SELECT p->'dataClasses' AS classes
             FROM (SELECT DISTINCT ON (entry_key) * FROM compliance.ropa_entries WHERE org_id IS NULL ORDER BY entry_key, version DESC) e,
                  jsonb_array_elements(e.processors) p
            WHERE p->>'name' = $1`,
          [name],
        ),
      )
    ).rows;
    return {
      exists: rows.length > 0,
      dataClasses: [...new Set(rows.flatMap((r) => (r.classes as string[]) ?? []))],
    };
  }

  async evaluate(req: ResidencyRequest): Promise<ResidencyResult> {
    if (
      !req ||
      !UUID.test(String(req.orgId)) ||
      !(CLASSES as readonly string[]).includes(req.dataClass) ||
      typeof req.targetRegion !== 'string' ||
      req.targetRegion === '' ||
      (req.operation !== 'write' && req.operation !== 'read') ||
      typeof req.purpose !== 'string' ||
      req.purpose === ''
    )
      throw new ProblemException(
        'validation_failed',
        'a residency request needs orgId, dataClass, targetRegion, purpose and operation',
      );
    let result: ResidencyResult;
    try {
      const [floor, policy] = await Promise.all([this.loadFloor(), this.loadPolicy(req.orgId)]);
      const [assessments, processor] = await Promise.all([
        this.loadAssessments(req.orgId, policy?.exceptions ?? []),
        req.processorId !== undefined && req.dataClass !== 'public'
          ? this.loadProcessor(req.processorId)
          : Promise.resolve(null),
      ]);
      result = evaluate({
        orgId: req.orgId,
        dataClass: req.dataClass,
        target: await this.regions.resolve(req.targetRegion),
        ...(req.processorId !== undefined ? { processorId: req.processorId } : {}),
        policy,
        floor,
        defaultMode: this.opts.defaultMode,
        assessments,
        processor,
        now: this.now(),
      });
    } catch (e) {
      // FAIL CLOSED: anything that stops the check from running is a refusal, never a pass
      result = {
        decision: 'deny',
        reasons: [reason('residency_unavailable')],
        policyVersion: null,
        floorVersion: null,
        assessmentId: null,
        evidenceRef: `rd_unavailable_${uuidv7().slice(-12)}`,
      };
      await this.record('compliance.residency.evaluate_failed', req, result, {
        error: (e as Error).message.slice(0, 200),
      });
      return result;
    }
    if (result.decision !== 'allow')
      await this.record('compliance.residency.evaluate_denied', req, result);
    return result;
  }

  private async record(
    action: 'compliance.residency.evaluate_denied' | 'compliance.residency.evaluate_failed',
    req: ResidencyRequest,
    r: ResidencyResult,
    extra: Record<string, unknown> = {},
  ) {
    try {
      await this.audit.record({
        action,
        orgId: req.orgId,
        resource: { type: 'residency_decision', id: r.evidenceRef },
        outcome: 'failure',
        detail: {
          decision: r.decision,
          reasons: r.reasons.map((x) => x.code),
          dataClass: req.dataClass,
          targetRegion: req.targetRegion.slice(0, 64),
          processorId: req.processorId ?? null,
          purpose: req.purpose.slice(0, 100),
          operation: req.operation,
          policyVersion: r.policyVersion,
          floorVersion: r.floorVersion,
          ...extra,
        },
      });
    } catch {
      /* the decision stands: a failed audit write never turns a refusal into a pass */
    }
  }

  // ---- the organization's policy -------------------------------------------------------------------------------------------

  async getPolicy(orgId: string): Promise<PolicyView> {
    this.invalidate(orgId);
    const [floor, row] = await Promise.all([
      this.loadFloor(),
      this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM compliance.residency_policies WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
              [orgId],
            )
          ).rows[0] as Row | undefined,
      ),
    ]);
    const p = row ? asPolicy(row) : null;
    return {
      version: p?.version ?? 0,
      isDefault: p === null,
      mode: p?.mode ?? this.opts.defaultMode,
      allowedCountriesByClass: p?.allowedCountriesByClass ?? {},
      exceptions: p?.exceptions ?? [],
      floor,
      updatedAt: row ? (row.created_at as Date).toISOString() : null,
    };
  }

  /**
   * Set the organization's policy: version 1 needs no precondition, a replacement needs the current version (428 / 412). An organization may only
   * tighten the platform floor (422 `policy_below_floor`). Every exception must be an approved, unexpired assessment that applies to this organization.
   */
  async putPolicy(
    orgId: string,
    actorUserId: string,
    raw: Record<string, unknown>,
    expectedVersion: number | null,
  ): Promise<PolicyView> {
    const body = parsePolicyBody(raw);
    const floor = await this.loadFloor();
    const now = this.now();
    const view = await this.db.withOrg(orgId, async (c) => {
      // serialize writers of one organization's policy (the runtime role has no UPDATE grant, so no FOR UPDATE)
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `residency:${orgId}`,
      ]);
      const prior = (
        await c.query(
          `SELECT * FROM compliance.residency_policies WHERE org_id = $1 ORDER BY version DESC LIMIT 1`,
          [orgId],
        )
      ).rows[0];
      if (prior) {
        if (expectedVersion === null)
          throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
        if (prior.version !== expectedVersion)
          throw new ProblemException(
            'precondition_failed',
            'the residency policy changed; reload it',
          );
      }
      const ex = body.exceptions.length
        ? (
            await c.query(
              `SELECT * FROM compliance.transfer_assessments WHERE id = ANY($1::uuid[])`,
              [body.exceptions],
            )
          ).rows.map(asAssessment)
        : [];
      for (const id of body.exceptions) {
        const a = ex.find((x) => x.id === id);
        if (!a || a.status !== 'approved' || (a.orgId !== null && a.orgId !== orgId))
          throw new ProblemException(
            'validation_failed',
            'an exception must be an approved transfer assessment that applies to this organization',
            [{ field: 'exceptions', message: `${id} is not usable` }],
          );
        if (a.expiresAt.getTime() <= now.getTime())
          throw new ProblemException('assessment_expired', `the assessment ${id} has expired`);
      }
      const below = belowFloor(
        body,
        floor,
        ex.map((a) => a.dataClass),
      );
      if (below.length)
        throw new ProblemException(
          'policy_below_floor',
          'an organization may only tighten the platform floor',
          below,
        );
      const row = (
        await c.query(
          `INSERT INTO compliance.residency_policies (id, org_id, version, mode, allowed, exceptions, change_note, created_by)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7,$8) RETURNING *`,
          [
            uuidv7(),
            orgId,
            prior ? Number(prior.version) + 1 : 1,
            body.mode,
            JSON.stringify({ allowedCountriesByClass: body.allowedCountriesByClass }),
            body.exceptions,
            body.changeNote,
            actorUserId,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.residency.policy_updated',
        actorUserId,
        orgId,
        resource: { type: 'residency_policy', id: row.id as string },
        outcome: 'success',
        before: prior ? { version: prior.version, mode: prior.mode } : undefined,
        after: {
          version: row.version,
          mode: body.mode,
          countries: Object.fromEntries(
            Object.entries(body.allowedCountriesByClass).map(([k, v]) => [k, v.length]),
          ),
          exceptions: body.exceptions.length,
        },
      });
      return row;
    });
    this.invalidate(orgId);
    const p = asPolicy(view);
    return {
      version: p.version,
      isDefault: false,
      mode: p.mode,
      allowedCountriesByClass: p.allowedCountriesByClass,
      exceptions: p.exceptions,
      floor,
      updatedAt: (view.created_at as Date).toISOString(),
    };
  }
}
