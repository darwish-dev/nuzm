import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { fitsEveryLevel, type BudgetLevel } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { isUuid, type AiConfig, type Row } from './model';

export class BudgetDenied extends Error {
  constructor(
    readonly level: string,
    readonly reason: 'credits' | 'tokens',
    readonly availableCredits: bigint,
  ) {
    super(`budget ${level} cannot hold the reservation (${reason})`);
  }
}
export interface Reservation {
  id: string;
  credits: bigint;
  tokens: bigint;
  createdAt: Date;
}
export interface BudgetDoc {
  dailyCredits: number | null;
  runMaxCredits: number | null;
  runMaxTokens: number | null;
  totalCredits: number | null;
  totalTokens: number | null;
  alertThresholds: number[];
  logBodies: boolean;
  bodyRetentionDays: number | null;
  autoApplyLowRisk: boolean;
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const big = (v: unknown): bigint => BigInt(String(v ?? 0));

/**
 * Budgets and the credit balance (M09 S37 task 3). The wallet (ledger account 2100, M02) is the source of truth; `ai.credit_balances` is its PROJECTION minus open
 * reservations. A call needs a PRE-FLIGHT RESERVATION of its worst case (prompt + max_tokens at the rate card) that fits EVERY level at once: balance, run caps,
 * project total, organization daily cap. All of that runs under one row lock per organization, so concurrent calls cannot jointly overspend: spent can never
 * exceed a cap by more than the in-flight reservations, and since a reservation must fit the REMAINING budget, not even by that.
 */
export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cfg: AiConfig,
  ) {}

  /** Lock + refresh the balance row for the organization inside `c`. Returns available credits (wallet − reserved). */
  async lockBalance(
    c: PoolClient,
    orgId: string,
  ): Promise<{ wallet: bigint; reserved: bigint; unit: bigint; available: bigint }> {
    await c.query(`SELECT billing.refresh_wallet($1)`, [orgId]);
    const w = (
      await c.query(
        `SELECT balance_minor FROM billing.wallet_balances WHERE org_id=$1 AND currency=$2`,
        [orgId, this.cfg.currency],
      )
    ).rows[0];
    const walletMinor = big(w?.balance_minor);
    const b = (
      await c.query(
        `INSERT INTO ai.credit_balances (org_id, currency, wallet_minor, credit_unit_minor) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, currency) DO UPDATE SET wallet_minor=EXCLUDED.wallet_minor, credit_unit_minor=EXCLUDED.credit_unit_minor, refreshed_at=now()
         RETURNING reserved_credits`,
        [orgId, this.cfg.currency, walletMinor.toString(), this.cfg.creditUnitMinor],
      )
    ).rows[0]!;
    const unit = BigInt(this.cfg.creditUnitMinor);
    const reserved = big(b.reserved_credits);
    const wallet = walletMinor / unit;
    return { wallet, reserved, unit, available: wallet - reserved };
  }

  async reserve(p: {
    orgId: string;
    callId: string;
    runId?: string;
    projectId?: string;
    credits: bigint;
    tokens: bigint;
    runBudget?: { maxTokens?: number; maxCredits?: number };
  }): Promise<Reservation> {
    return this.db.withOrg(p.orgId, async (c) => {
      const bal = await this.lockBalance(c, p.orgId);
      const existing = (
        await c.query(`SELECT * FROM ai.reservations WHERE org_id=$1 AND call_id=$2`, [
          p.orgId,
          p.callId,
        ])
      ).rows[0] as Row | undefined;
      if (existing) {
        // a retried call id: reuse the open reservation (never double hold)
        if (existing.state === 'held')
          return {
            id: existing.id as string,
            credits: big(existing.credits),
            tokens: big(existing.tokens),
            createdAt: existing.created_at as Date,
          };
        throw new ProblemException('conflict', 'this call id was already settled');
      }
      const orgB = (
        await c.query(`SELECT * FROM ai.budgets WHERE org_id=$1 AND scope='org'`, [p.orgId])
      ).rows[0] as Row | undefined;
      const prjB = p.projectId
        ? ((
            await c.query(
              `SELECT * FROM ai.budgets WHERE org_id=$1 AND scope='project' AND project_id=$2`,
              [p.orgId, p.projectId],
            )
          ).rows[0] as Row | undefined)
        : undefined;
      const sum = async (where: string, params: unknown[]) => {
        const u = (
          await c.query(
            `SELECT coalesce(sum(credits),0) cr, coalesce(sum(tokens_in+tokens_out),0) tk FROM ai.model_usage WHERE org_id=$1 AND ${where}`,
            [p.orgId, ...params],
          )
        ).rows[0]!;
        const h = (
          await c.query(
            `SELECT coalesce(sum(credits),0) cr, coalesce(sum(tokens),0) tk FROM ai.reservations WHERE org_id=$1 AND state='held' AND ${where}`,
            [p.orgId, ...params],
          )
        ).rows[0]!;
        return { credits: big(u.cr) + big(h.cr), tokens: big(u.tk) + big(h.tk) };
      };
      const levels: Record<string, BudgetLevel> = {
        balance: {
          remainingCredits: bal.available < 0n ? 0n : bal.available,
          remainingTokens: null,
        },
      };
      const remaining = (cap: unknown, used: bigint): bigint | null =>
        cap === null || cap === undefined
          ? null
          : BigInt(String(cap)) > used
            ? BigInt(String(cap)) - used
            : 0n;
      if (orgB?.daily_credits !== null && orgB?.daily_credits !== undefined) {
        const day = await sum(
          `created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          [],
        );
        // held reservations are not filtered by day: they are in flight now
        levels.orgDaily = {
          remainingCredits: remaining(orgB.daily_credits, day.credits),
          remainingTokens: null,
        };
      }
      if (p.runId) {
        const run = await sum(`run_id = $2`, [p.runId]);
        const maxCredits = [p.runBudget?.maxCredits, num(orgB?.run_max_credits)].filter(
          (x): x is number => typeof x === 'number',
        );
        const maxTokens = [p.runBudget?.maxTokens, num(orgB?.run_max_tokens)].filter(
          (x): x is number => typeof x === 'number',
        );
        levels.run = {
          remainingCredits: maxCredits.length
            ? remaining(Math.min(...maxCredits), run.credits)
            : null,
          remainingTokens: maxTokens.length ? remaining(Math.min(...maxTokens), run.tokens) : null,
        };
      }
      if (p.projectId && prjB) {
        const prj = await sum(`project_id = $2`, [p.projectId]);
        levels.project = {
          remainingCredits: remaining(prjB.total_credits, prj.credits),
          remainingTokens: remaining(prjB.total_tokens, prj.tokens),
        };
      }
      if (orgB && (orgB.total_credits !== null || orgB.total_tokens !== null)) {
        const all = await sum(`true`, []);
        levels.orgTotal = {
          remainingCredits: remaining(orgB.total_credits, all.credits),
          remainingTokens: remaining(orgB.total_tokens, all.tokens),
        };
      }
      const d = fitsEveryLevel(levels, p.credits, p.tokens);
      if (!d.ok) throw new BudgetDenied(d.level, d.reason, bal.available);
      const id = uuidv7();
      const r = (
        await c.query(
          `INSERT INTO ai.reservations (id, org_id, run_id, project_id, call_id, credits, tokens, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8)) RETURNING created_at`,
          [
            id,
            p.orgId,
            p.runId ?? null,
            p.projectId ?? null,
            p.callId,
            p.credits.toString(),
            p.tokens.toString(),
            this.cfg.reservationTtlSeconds,
          ],
        )
      ).rows[0]!;
      await c.query(
        `UPDATE ai.credit_balances SET reserved_credits = reserved_credits + $3 WHERE org_id=$1 AND currency=$2`,
        [p.orgId, this.cfg.currency, p.credits.toString()],
      );
      if (p.runId)
        await c.query(
          `UPDATE ai.runs SET reserved_credits = reserved_credits + $3 WHERE org_id=$1 AND id=$2`,
          [p.orgId, p.runId, p.credits.toString()],
        );
      return { id, credits: p.credits, tokens: p.tokens, createdAt: r.created_at as Date };
    });
  }

  /** Close a reservation WITHOUT spend (error before any billable result, or a sweep). Idempotent. */
  async release(orgId: string, reservationId: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `UPDATE ai.reservations SET state='released', closed_at=now() WHERE id=$1 AND state='held' RETURNING credits, run_id`,
          [reservationId],
        )
      ).rows[0] as Row | undefined;
      if (!r) return;
      await c.query(
        `UPDATE ai.credit_balances SET reserved_credits = greatest(0, reserved_credits - $3) WHERE org_id=$1 AND currency=$2`,
        [orgId, this.cfg.currency, String(r.credits)],
      );
      if (r.run_id)
        await c.query(
          `UPDATE ai.runs SET reserved_credits = greatest(0, reserved_credits - $3) WHERE org_id=$1 AND id=$2`,
          [orgId, r.run_id, String(r.credits)],
        );
    });
  }

  /** Releases reservations whose call never reported back (a crashed worker). Returns how many were released. */
  async sweepExpired(): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM ai.reservations WHERE state='held' AND expires_at < now() LIMIT 500`,
          )
        ).rows as Row[],
    );
    for (const r of rows) await this.release(r.org_id as string, r.id as string);
    if (rows.length)
      await this.audit.record({
        action: 'ai.reservation.swept',
        actorType: 'system',
        resource: { type: 'ai_reservation' },
        outcome: 'success',
        detail: { count: rows.length },
      });
    return rows.length;
  }

  // ---- budgets documents ---------------------------------------------------------------------------------------------------

  private docOf(r: Row | undefined): BudgetDoc {
    return {
      dailyCredits: num(r?.daily_credits),
      runMaxCredits: num(r?.run_max_credits),
      runMaxTokens: num(r?.run_max_tokens),
      totalCredits: num(r?.total_credits),
      totalTokens: num(r?.total_tokens),
      alertThresholds: (r?.alert_thresholds as number[] | undefined) ?? [50, 80, 100],
      logBodies: (r?.log_bodies as boolean | undefined) ?? false,
      bodyRetentionDays: num(r?.body_retention_days),
      autoApplyLowRisk: (r?.auto_apply_low_risk as boolean | undefined) ?? false,
    };
  }
  async getBudgets(orgId: string): Promise<{
    org: BudgetDoc;
    projects: (Partial<BudgetDoc> & { projectId: string })[];
    version: number;
  }> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM ai.budgets WHERE org_id=$1 ORDER BY scope, project_id`, [
            orgId,
          ])
        ).rows as Row[],
    );
    const org = rows.find((r) => r.scope === 'org');
    return {
      org: this.docOf(org),
      projects: rows
        .filter((r) => r.scope === 'project')
        .map((r) => ({
          projectId: r.project_id as string,
          totalCredits: num(r.total_credits),
          totalTokens: num(r.total_tokens),
        })),
      version: (org?.version as number | undefined) ?? 0,
    };
  }
  private static cap(v: unknown, name: string, max = 1e12): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max)
      throw new ProblemException(
        'validation_failed',
        `${name} must be a non-negative integer or null`,
      );
    return v;
  }
  async putBudgets(
    orgId: string,
    actor: string,
    ifMatch: number,
    body: Record<string, unknown>,
  ): Promise<{ org: BudgetDoc; projects: Row[]; version: number }> {
    const o = (body.org ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object' || Array.isArray(o))
      throw new ProblemException('validation_failed', 'org must be an object');
    const cap = BudgetService.cap;
    const alerts = o.alertThresholds ?? [50, 80, 100];
    if (
      !Array.isArray(alerts) ||
      alerts.length > 6 ||
      alerts.some((a) => !Number.isInteger(a) || a < 1 || a > 100)
    )
      throw new ProblemException(
        'validation_failed',
        'alertThresholds must be up to 6 integers between 1 and 100',
      );
    const logBodies = o.logBodies === true;
    const retention = cap(o.bodyRetentionDays, 'bodyRetentionDays', 365);
    if (logBodies && (retention === null || retention < 1))
      throw new ProblemException(
        'validation_failed',
        'logging prompt bodies needs bodyRetentionDays (D-34)',
      );
    const projects = Array.isArray(body.projects)
      ? (body.projects as Record<string, unknown>[])
      : [];
    for (const p of projects)
      if (!isUuid(p.projectId))
        throw new ProblemException('validation_failed', 'projects[].projectId must be a uuid');
    return this.db
      .withOrg(orgId, async (c) => {
        const cur = (
          await c.query(`SELECT * FROM ai.budgets WHERE org_id=$1 AND scope='org' FOR UPDATE`, [
            orgId,
          ])
        ).rows[0] as Row | undefined;
        const curVersion = (cur?.version as number | undefined) ?? 0;
        if (curVersion !== ifMatch)
          throw new ProblemException('etag_mismatch', 'the budgets changed since they were read');
        const vals = [
          cap(o.dailyCredits, 'dailyCredits'),
          cap(o.runMaxCredits, 'runMaxCredits'),
          cap(o.runMaxTokens, 'runMaxTokens'),
          cap(o.totalCredits, 'totalCredits'),
          cap(o.totalTokens, 'totalTokens'),
          alerts,
          logBodies,
          retention,
          o.autoApplyLowRisk === true,
        ];
        if (!cur) {
          await c.query(
            `INSERT INTO ai.budgets (id, org_id, scope, daily_credits, run_max_credits, run_max_tokens, total_credits, total_tokens, alert_thresholds, log_bodies, body_retention_days, auto_apply_low_risk, updated_by)
           VALUES ($1,$2,'org',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [uuidv7(), orgId, ...vals, actor],
          );
        } else {
          await c.query(
            `UPDATE ai.budgets SET daily_credits=$2, run_max_credits=$3, run_max_tokens=$4, total_credits=$5, total_tokens=$6, alert_thresholds=$7, log_bodies=$8, body_retention_days=$9, auto_apply_low_risk=$10, updated_by=$11, updated_at=now(), version=version+1 WHERE id=$1`,
            [cur.id, ...vals, actor],
          );
        }
        for (const p of projects) {
          await c.query(
            `INSERT INTO ai.budgets (id, org_id, scope, project_id, total_credits, total_tokens, updated_by) VALUES ($1,$2,'project',$3,$4,$5,$6)
           ON CONFLICT (org_id, project_id) WHERE scope = 'project' DO UPDATE SET total_credits=EXCLUDED.total_credits, total_tokens=EXCLUDED.total_tokens, updated_by=EXCLUDED.updated_by, updated_at=now(), version=ai.budgets.version+1`,
            [
              uuidv7(),
              orgId,
              p.projectId,
              cap(p.totalCredits, 'projects[].totalCredits'),
              cap(p.totalTokens, 'projects[].totalTokens'),
              actor,
            ],
          );
        }
        const after = await c.query(
          `SELECT * FROM ai.budgets WHERE org_id=$1 ORDER BY scope, project_id`,
          [orgId],
        );
        const org = after.rows.find((r: Row) => r.scope === 'org') as Row;
        return {
          org: this.docOf(org),
          projects: after.rows.filter((r: Row) => r.scope === 'project') as Row[],
          version: org.version as number,
        };
      })
      .then(async (r) => {
        await this.audit.record({
          action: 'ai.budgets.updated',
          actorUserId: actor,
          actorType: 'user',
          orgId,
          resource: { type: 'ai_budgets' },
          outcome: 'success',
          after: {
            dailyCredits: r.org.dailyCredits,
            runMaxCredits: r.org.runMaxCredits,
            totalCredits: r.org.totalCredits,
            logBodies: r.org.logBodies,
            autoApplyLowRisk: r.org.autoApplyLowRisk,
          },
        });
        return r;
      });
  }

  async org(orgId: string) {
    return (await this.getBudgets(orgId)).org;
  }

  // ---- credits view --------------------------------------------------------------------------------------------------------

  async credits(orgId: string) {
    return this.db.withOrg(orgId, async (c) => {
      const bal = await this.lockBalance(c, orgId);
      const byModel = (
        await c.query(
          `SELECT model_ref, count(*)::int calls, sum(tokens_in)::bigint tin, sum(tokens_out)::bigint tout, sum(credits)::bigint credits FROM ai.model_usage WHERE org_id=$1 AND created_at > now() - interval '30 days' AND outcome='ok' GROUP BY model_ref ORDER BY 5 DESC`,
          [orgId],
        )
      ).rows as Row[];
      const byProject = (
        await c.query(
          `SELECT project_id, count(*)::int calls, sum(credits)::bigint credits FROM ai.model_usage WHERE org_id=$1 AND created_at > now() - interval '30 days' AND outcome='ok' GROUP BY project_id ORDER BY 3 DESC`,
          [orgId],
        )
      ).rows as Row[];
      const month = big(
        (
          await c.query(
            `SELECT coalesce(sum(credits),0) s FROM ai.model_usage WHERE org_id=$1 AND created_at > now() - interval '30 days'`,
            [orgId],
          )
        ).rows[0]!.s,
      );
      return {
        currency: this.cfg.currency,
        creditUnitMinor: this.cfg.creditUnitMinor,
        walletCredits: bal.wallet.toString(),
        reservedCredits: bal.reserved.toString(),
        availableCredits: (bal.available < 0n ? 0n : bal.available).toString(),
        last30DaysCredits: month.toString(),
        lowCredit: bal.available < 100n,
        usage: {
          byModel: byModel.map((r) => ({
            modelRef: r.model_ref,
            calls: r.calls,
            tokensIn: String(r.tin),
            tokensOut: String(r.tout),
            credits: String(r.credits),
          })),
          byProject: byProject.map((r) => ({
            projectId: r.project_id ?? null,
            calls: r.calls,
            credits: String(r.credits),
          })),
        },
      };
    });
  }
}
