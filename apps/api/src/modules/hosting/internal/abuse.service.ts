import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { tokenFor } from './cloudpanel-adapter';
import { planLimits, planRow } from './plans.service';
import type { HostingAdapter, SiteUsage } from './ports';
import type { Notify } from './usage.service';
import type { SitesService } from './sites.service';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const SOURCES = ['detector', 'report', 'staff'] as const;
export const ACTIONS = ['notify', 'throttle', 'suspend'] as const;
type Severity = (typeof SEVERITIES)[number];
type Action = (typeof ACTIONS)[number];

/** Process names that are never legitimate on shared hosting (PROPOSAL list; the real signature feed is a security-team deliverable). */
export const SUSPICIOUS_PROCESSES = ['xmrig', 'minerd', 'cpuminer', 'kdevtmpfsi', 'nc.traditional'];
/** One core used >= 90 % for this many consecutive hourly reports, and this many blocked SMTP attempts per report (PROPOSALS, HG-04-01 / AUP). */
export const SUSTAINED_CPU_HOURS = 3;
export const SMTP_ATTEMPT_LIMIT = 50;

export interface Detection {
  detector: 'sustained_cpu' | 'smtp_egress' | 'suspicious_process';
  severity: Severity;
  reasonCode: string;
  action: Action;
  evidence: string[];
}

/** Pure detector rules over the signals of one report and the CPU history (oldest first). Fixture-testable without a database. */
export function detect(
  report: Pick<SiteUsage, 'smtpEgressAttempts' | 'processNames'>,
  cpuSecondsHistory: number[],
): Detection[] {
  const out: Detection[] = [];
  const bad = (report.processNames ?? []).filter((n) =>
    SUSPICIOUS_PROCESSES.includes(n.toLowerCase()),
  );
  if (bad.length)
    out.push({
      detector: 'suspicious_process',
      severity: 'critical',
      reasonCode: 'suspicious_process_signature',
      action: 'suspend',
      evidence: bad.map((n) => `process:${n}`),
    });
  if ((report.smtpEgressAttempts ?? 0) >= SMTP_ATTEMPT_LIMIT)
    out.push({
      detector: 'smtp_egress',
      severity: 'high',
      reasonCode: 'outbound_smtp_attempts',
      action: 'suspend',
      evidence: [`smtp_attempts:${report.smtpEgressAttempts}`],
    });
  if (cpuSecondsHistory.length >= SUSTAINED_CPU_HOURS + 1) {
    const deltas = cpuSecondsHistory.slice(1).map((v, i) => v - cpuSecondsHistory[i]!);
    const recent = deltas.slice(-SUSTAINED_CPU_HOURS);
    if (recent.length === SUSTAINED_CPU_HOURS && recent.every((d) => d >= 0.9 * 3600))
      out.push({
        detector: 'sustained_cpu',
        severity: 'medium',
        reasonCode: 'sustained_cpu',
        action: 'throttle',
        evidence: [`cpu_seconds_per_hour:${recent.join(',')}`],
      });
  }
  return out;
}

export interface AbuseCaseDto {
  id: string;
  siteId: string;
  orgId?: string;
  source: string;
  detector: string | null;
  severity: string;
  state: string;
  reasonCode: string;
  actions: { action: string; by: string | null; at: string; note?: string }[];
  evidenceRefs?: string[];
  appeal: { text: string; at: string; decision: string | null; decidedAt: string | null } | null;
  createdAt: string;
  closedAt: string | null;
}

/**
 * Abuse controls (M06 §4 task 15): detectors and staff open cases, actions throttle / suspend / notify carry reason codes and are audited, the customer can appeal and a
 * DIFFERENT person than the one who actioned the case decides the appeal (database CHECK + service rule). The AUP text is a human deliverable (HG-04-01) and is not
 * written here. Evidence is by reference only (a ref names where the proof lives; no content is stored).
 */
export class AbuseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sites: SitesService,
    private readonly adapter: HostingAdapter,
    private readonly notify: Notify,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private dto(r: Row, staff: boolean): AbuseCaseDto {
    const d: AbuseCaseDto = {
      id: r.id as string,
      siteId: r.site_id as string,
      source: r.source as string,
      detector: (r.detector as string | null) ?? null,
      severity: r.severity as string,
      state: r.state as string,
      reasonCode: r.reason_code as string,
      actions: ((r.actions as Row[]) ?? []).map((a) => ({
        action: a.action as string,
        by: (a.by as string | null) ?? null,
        at: a.at as string,
        ...(a.note ? { note: a.note as string } : {}),
      })),
      appeal: r.appealed_at
        ? {
            text: r.appeal_text as string,
            at: iso(r.appealed_at)!,
            decision: (r.appeal_decision as string | null) ?? null,
            decidedAt: iso(r.appeal_decided_at),
          }
        : null,
      createdAt: iso(r.created_at)!,
      closedAt: iso(r.closed_at),
    };
    if (staff) {
      d.orgId = r.org_id as string;
      d.evidenceRefs = r.evidence_refs as string[];
    }
    return d;
  }

  /** Open a case (staff endpoint or detector). A detector keeps ONE open case per site and detector. */
  async open(input: {
    siteId: string;
    source: string;
    detector?: string | null;
    severity: string;
    reasonCode: string;
    evidenceRefs?: string[];
    createdBy?: string | null;
    idempotencyKey?: string | null;
    action?: string | null;
  }): Promise<{ case: AbuseCaseDto; created: boolean }> {
    if (!UUID.test(input.siteId)) throw new ProblemException('not_found', 'site not found');
    if (!(SOURCES as readonly string[]).includes(input.source))
      throw new ProblemException(
        'validation_failed',
        `source must be one of ${SOURCES.join(', ')}`,
      );
    if (!(SEVERITIES as readonly string[]).includes(input.severity))
      throw new ProblemException(
        'validation_failed',
        `severity must be one of ${SEVERITIES.join(', ')}`,
      );
    if (!/^[a-z_]{3,60}$/.test(input.reasonCode))
      throw new ProblemException('validation_failed', 'reasonCode must be a snake_case code');
    const refs = input.evidenceRefs ?? [];
    if (
      !Array.isArray(refs) ||
      refs.length > 20 ||
      refs.some((r) => typeof r !== 'string' || r.length < 1 || r.length > 200)
    )
      throw new ProblemException(
        'validation_failed',
        'evidenceRefs must be up to 20 reference strings',
      );
    if (input.action && !(ACTIONS as readonly string[]).includes(input.action))
      throw new ProblemException(
        'validation_failed',
        `action must be one of ${ACTIONS.join(', ')}`,
      );
    const site = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT id, org_id FROM hosting.sites WHERE id = $1`, [input.siteId]))
          .rows[0],
    );
    if (!site) throw new ProblemException('not_found', 'site not found');
    const orgId = site.org_id as string;
    if (input.idempotencyKey && input.createdBy) {
      const prior = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT * FROM hosting.abuse_cases WHERE created_by = $1 AND idempotency_key = $2`,
              [input.createdBy, input.idempotencyKey],
            )
          ).rows[0],
      );
      if (prior) return { case: this.dto(prior, true), created: false };
    }
    const id = uuidv7();
    let row: Row;
    try {
      row = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `INSERT INTO hosting.abuse_cases (id, site_id, org_id, source, detector, severity, reason_code, evidence_refs, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
              [
                id,
                input.siteId,
                orgId,
                input.source,
                input.detector ?? null,
                input.severity,
                input.reasonCode,
                JSON.stringify(refs),
                input.createdBy ?? null,
                input.idempotencyKey ?? null,
              ],
            )
          ).rows[0]!,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && input.detector) {
        const open = await this.db.withPlatformScope(
          async (c) =>
            (
              await c.query(
                `SELECT * FROM hosting.abuse_cases WHERE site_id = $1 AND detector = $2 AND state IN ('open','actioned','appealed')`,
                [input.siteId, input.detector],
              )
            ).rows[0],
        );
        if (open) return { case: this.dto(open, true), created: false }; // the detector keeps firing: one open case
      }
      throw e;
    }
    await this.audit.record({
      action: 'hosting.abuse.case.opened',
      actorUserId: input.createdBy ?? undefined,
      actorType: input.createdBy ? 'user' : 'system',
      orgId,
      resource: { type: 'hosting_abuse_case', id },
      outcome: 'success',
      detail: {
        source: input.source,
        severity: input.severity,
        reasonCode: input.reasonCode,
        detector: input.detector ?? null,
      },
    });
    let dto = this.dto(row, true);
    if (input.action) dto = await this.act(input.createdBy ?? null, id, input.action as Action);
    return { case: dto, created: true };
  }

  /** Apply an action: notify (the owners are told), throttle (halved process/memory limits on the node), suspend (reason code `abuse`). */
  async act(
    staffId: string | null,
    caseId: string,
    action: Action,
    note?: string,
  ): Promise<AbuseCaseDto> {
    const c = await this.load(caseId);
    if (c.state === 'closed') throw new ProblemException('conflict', 'the case is closed');
    const siteId = c.site_id as string;
    const orgId = c.org_id as string;
    const site = await this.db.withPlatformScope(
      async (cl) =>
        (
          await cl.query(
            `SELECT s.*, n.compute_instance_id, p.quotas, p.runtimes, p.reservation, p.key, p.status AS plan_status, p.price_minor, p.currency, p.placeholder, p.name_ar, p.name_en FROM hosting.sites s JOIN hosting.nodes n ON n.id = s.node_id JOIN hosting.plan_definitions p ON p.id = s.plan_id WHERE s.id = $1`,
            [siteId],
          )
        ).rows[0],
    );
    if (!site) throw new ProblemException('not_found', 'site not found');
    if (action === 'suspend') {
      if (site.status === 'active')
        await this.sites.setSuspended(staffId, siteId, true, 'abuse', c.reason_code as string);
    } else if (action === 'throttle') {
      const lim = planLimits(planRow({ ...site, id: site.plan_id, status: site.plan_status }));
      const t = {
        idempotencyToken: tokenFor(orgId, `${caseId}:throttle`, 'throttle'),
        operationId: `abuse-${caseId}`,
      };
      const r = await this.adapter.updateSite(
        this.sites.ctx(t.operationId),
        { nodeId: site.node_id as string, computeInstanceId: site.compute_instance_id as string },
        site.node_name as string,
        {
          limits: {
            ...lim,
            maxProcesses: Math.max(5, Math.floor(lim.maxProcesses / 2)),
            memoryMb: Math.max(64, Math.floor(lim.memoryMb / 2)),
          },
        },
        t,
      );
      if (r.status !== 'succeeded')
        throw new ProblemException(
          'service_unavailable',
          'the node did not confirm the throttle; nothing was changed',
        );
    } else {
      const site2 = await this.db.withPlatformScope(
        async (cl) =>
          (await cl.query(`SELECT name FROM hosting.sites WHERE id = $1`, [siteId])).rows[0],
      );
      await this.notify(orgId, 'hosting.abuse_notice', {
        site: site2!.name as string,
        reason: c.reason_code as string,
      });
    }
    const entry = {
      action,
      by: staffId,
      at: this.clock().toISOString(),
      ...(note ? { note: note.slice(0, 300) } : {}),
    };
    const row = await this.db.withPlatformScope(
      async (cl) =>
        (
          await cl.query(
            `UPDATE hosting.abuse_cases SET actions = actions || $2::jsonb, state = CASE WHEN state = 'open' THEN 'actioned' ELSE state END, actioned_by = coalesce($3, actioned_by), updated_at = now() WHERE id = $1 RETURNING *`,
            [caseId, JSON.stringify([entry]), staffId],
          )
        ).rows[0]!,
    );
    await this.audit.record({
      action: 'hosting.abuse.case.actioned',
      actorUserId: staffId ?? undefined,
      actorType: staffId ? 'user' : 'system',
      orgId,
      resource: { type: 'hosting_abuse_case', id: caseId },
      outcome: 'success',
      detail: { action, reasonCode: c.reason_code as string },
    });
    return this.dto(row, true);
  }
  private async load(id: string): Promise<Row> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'case not found');
    const r = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM hosting.abuse_cases WHERE id = $1`, [id])).rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'case not found');
    return r;
  }

  /** Customer appeal: only an actioned case, 10..2000 characters. */
  async appeal(
    orgId: string,
    siteId: string,
    caseId: string,
    text: unknown,
  ): Promise<AbuseCaseDto> {
    if (typeof text !== 'string' || text.trim().length < 10 || text.length > 2000)
      throw new ProblemException('validation_failed', 'the appeal needs 10..2000 characters');
    await this.sites.row(orgId, siteId);
    if (!UUID.test(caseId)) throw new ProblemException('not_found', 'case not found');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.abuse_cases SET state = 'appealed', appeal_text = $4, appealed_at = now(), updated_at = now() WHERE id = $1 AND site_id = $2 AND org_id = $3 AND state = 'actioned' AND appealed_at IS NULL RETURNING *`,
            [caseId, siteId, orgId, text.trim()],
          )
        ).rows[0],
    );
    if (!row) {
      const exists = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT state FROM hosting.abuse_cases WHERE id = $1 AND site_id = $2 AND org_id = $3`,
              [caseId, siteId, orgId],
            )
          ).rows[0],
      );
      if (!exists) throw new ProblemException('not_found', 'case not found');
      throw new ProblemException(
        'conflict',
        'only an actioned case that was not appealed yet can be appealed',
      );
    }
    await this.audit.record({
      action: 'hosting.abuse.case.appealed',
      orgId,
      actorType: 'user',
      resource: { type: 'hosting_abuse_case', id: caseId },
      outcome: 'success',
    });
    return this.dto(row, false);
  }

  /** Staff decision on an appeal; never by the person who actioned the case. `overturned` lifts what the case did (suspension, throttle). */
  async decideAppeal(
    staffId: string,
    caseId: string,
    decision: unknown,
    note?: string,
  ): Promise<AbuseCaseDto> {
    if (decision !== 'upheld' && decision !== 'overturned')
      throw new ProblemException('validation_failed', "decision must be 'upheld' or 'overturned'");
    const c = await this.load(caseId);
    if (c.state !== 'appealed')
      throw new ProblemException('conflict', 'the case has no open appeal');
    if (c.actioned_by === staffId)
      throw new ProblemException(
        'forbidden',
        'the appeal must be decided by a different person than the one who actioned the case',
      );
    const siteId = c.site_id as string;
    if (decision === 'overturned') {
      const site = await this.db.withPlatformScope(
        async (cl) =>
          (
            await cl.query(
              `SELECT s.*, n.compute_instance_id, p.quotas, p.reservation, p.status AS plan_status, p.runtimes, p.key, p.price_minor, p.currency, p.placeholder, p.name_ar, p.name_en FROM hosting.sites s JOIN hosting.nodes n ON n.id = s.node_id JOIN hosting.plan_definitions p ON p.id = s.plan_id WHERE s.id = $1`,
              [siteId],
            )
          ).rows[0],
      );
      if (site?.status === 'suspended' && site.suspended_by === 'abuse')
        await this.sites.setSuspended(
          staffId,
          siteId,
          false,
          'abuse',
          'appeal overturned the abuse case',
        );
      if (site && (c.actions as Row[]).some((a) => a.action === 'throttle')) {
        const t = {
          idempotencyToken: tokenFor(c.org_id as string, `${caseId}:unthrottle`, 'unthrottle'),
          operationId: `abuse-${caseId}-lift`,
        };
        await this.adapter.updateSite(
          this.sites.ctx(t.operationId),
          { nodeId: site.node_id as string, computeInstanceId: site.compute_instance_id as string },
          site.node_name as string,
          { limits: planLimits(planRow({ ...site, id: site.plan_id, status: site.plan_status })) },
          t,
        );
      }
    }
    const row = await this.db.withPlatformScope(
      async (cl) =>
        (
          await cl.query(
            `UPDATE hosting.abuse_cases SET state = 'closed', closed_at = now(), appeal_decision = $2, appeal_decided_by = $3, appeal_decided_at = now(), updated_at = now(), actions = actions || $4::jsonb WHERE id = $1 RETURNING *`,
            [
              caseId,
              decision,
              staffId,
              JSON.stringify([
                {
                  action: `appeal_${decision}`,
                  by: staffId,
                  at: this.clock().toISOString(),
                  ...(note ? { note: note.slice(0, 300) } : {}),
                },
              ]),
            ],
          )
        ).rows[0]!,
    );
    await this.audit.record({
      action: 'hosting.abuse.case.appeal_decided',
      actorUserId: staffId,
      actorType: 'user',
      orgId: c.org_id as string,
      resource: { type: 'hosting_abuse_case', id: caseId },
      outcome: 'success',
      detail: { decision },
    });
    return this.dto(row, true);
  }

  /** Staff closes a case without an appeal (false positive / resolved). A suspension by this case is lifted. */
  async close(staffId: string, caseId: string, note?: string): Promise<AbuseCaseDto> {
    const c = await this.load(caseId);
    if (c.state === 'closed') return this.dto(c, true);
    const site = await this.db.withPlatformScope(
      async (cl) =>
        (
          await cl.query(`SELECT status, suspended_by FROM hosting.sites WHERE id = $1`, [
            c.site_id,
          ])
        ).rows[0],
    );
    if (site?.status === 'suspended' && site.suspended_by === 'abuse')
      await this.sites.setSuspended(
        staffId,
        c.site_id as string,
        false,
        'abuse',
        note ?? 'abuse case closed',
      );
    const row = await this.db.withPlatformScope(
      async (cl) =>
        (
          await cl.query(
            `UPDATE hosting.abuse_cases SET state = 'closed', closed_at = now(), updated_at = now(), actions = actions || $2::jsonb WHERE id = $1 RETURNING *`,
            [
              caseId,
              JSON.stringify([
                {
                  action: 'closed',
                  by: staffId,
                  at: this.clock().toISOString(),
                  ...(note ? { note: note.slice(0, 300) } : {}),
                },
              ]),
            ],
          )
        ).rows[0]!,
    );
    await this.audit.record({
      action: 'hosting.abuse.case.closed',
      actorUserId: staffId,
      actorType: 'user',
      orgId: c.org_id as string,
      resource: { type: 'hosting_abuse_case', id: caseId },
      outcome: 'success',
    });
    return this.dto(row, true);
  }

  async list(q: {
    state?: string;
    severity?: string;
    siteId?: string;
    limit: number;
  }): Promise<{ items: AbuseCaseDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.abuse_cases WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR severity = $2) AND ($3::uuid IS NULL OR site_id = $3) ORDER BY created_at DESC, id DESC LIMIT $4`,
            [q.state ?? null, q.severity ?? null, q.siteId ?? null, q.limit],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r, true)) };
  }
  async get(id: string): Promise<AbuseCaseDto> {
    return this.dto(await this.load(id), true);
  }
  /** What the customer sees of the cases of ITS site: reason code, state, actions and appeal; never the evidence references. */
  async listForSite(orgId: string, siteId: string): Promise<{ items: AbuseCaseDto[] }> {
    await this.sites.row(orgId, siteId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.abuse_cases WHERE site_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 50`,
            [siteId, orgId],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r, false)) };
  }

  /** The detector pass for one fresh report: opens a case (and applies the default action of the rule) for every detection. */
  async scan(siteId: string, report: SiteUsage): Promise<number> {
    const hist = await this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT cpu_seconds FROM hosting.site_usage_reports WHERE site_id = $1 ORDER BY period_start DESC LIMIT $2`,
          [siteId, SUSTAINED_CPU_HOURS + 1],
        )
      ).rows
        .map((r) => Number(r.cpu_seconds))
        .reverse(),
    );
    let n = 0;
    for (const d of detect(report, hist)) {
      const r = await this.open({
        siteId,
        source: 'detector',
        detector: d.detector,
        severity: d.severity,
        reasonCode: d.reasonCode,
        evidenceRefs: d.evidence,
        action: d.action,
      });
      if (r.created) n++;
    }
    return n;
  }
}
