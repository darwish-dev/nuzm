import type { Db } from '@nuzm/platform';

export const BILLING_DOMAINS = ['billing', 'invoicing', 'payments', 'finrec', 'metering'] as const;

export interface AuditFilter {
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Exact action (`tenancy.member.removed`) or a domain/resource prefix ending in `.*` (`tenancy.*`). */
  action?: string;
  outcome?: 'success' | 'failure';
  from?: Date;
  to?: Date;
  /** Admin only: restrict to one target organization. */
  orgId?: string;
  limit: number;
  cursor?: string | null;
  /** Restrict to billing-domain actions (billing_admin without `audit:read_all`). */
  billingOnly?: boolean;
}

export interface AuditItem {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  orgId: string | null;
  actor: {
    type: string;
    userId: string | null;
    apiKeyId: string | null;
    impersonatorUserId: string | null;
  };
  resource: { type: string | null; id: string | null };
  traceId: string | null;
  before: unknown;
  after: unknown;
  detail: unknown;
  chainSeq: number;
  hash: string;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  action: string;
  outcome: string;
  org_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  impersonator_user_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  trace_id: string | null;
  before: unknown;
  after: unknown;
  detail: unknown;
  chain_seq: string;
  hash: string;
}

const cursorOf = (t: Date, id: string) =>
  Buffer.from(`${t.toISOString()}|${id}`).toString('base64url');
function parseCursor(raw: string | null | undefined): { t: string; id: string } | null {
  if (!raw) return null;
  const [t, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  return t && id && !Number.isNaN(Date.parse(t)) && /^[0-9a-f-]{36}$/i.test(id) ? { t, id } : null;
}

/** Read side of the audit store. RLS does the tenant isolation; filters only narrow within scope. */
export class AuditQueryService {
  constructor(private readonly db: Db) {}

  private build(f: AuditFilter) {
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      p.push(v);
      where.push(sql.replace('?', `$${p.length}`));
    };
    if (f.actorUserId) add('actor_user_id = ?', f.actorUserId);
    if (f.resourceType) add('resource_type = ?', f.resourceType);
    if (f.resourceId) add('resource_id = ?', f.resourceId);
    if (f.outcome) add('outcome = ?', f.outcome);
    if (f.orgId) add('org_id = ?', f.orgId);
    if (f.from) add('occurred_at >= ?', f.from);
    if (f.to) add('occurred_at < ?', f.to);
    if (f.action) {
      if (f.action.endsWith('.*'))
        add('action LIKE ?', f.action.slice(0, -1).replace(/[%_\\]/g, '\\$&') + '%');
      else add('action = ?', f.action);
    }
    if (f.billingOnly) add(`split_part(action, '.', 1) = ANY(?::text[])`, [...BILLING_DOMAINS]);
    const cur = parseCursor(f.cursor);
    if (cur) {
      p.push(cur.t, cur.id);
      where.push(`(occurred_at, id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
    }
    p.push(f.limit + 1);
    const sql = `SELECT id, occurred_at, action, outcome, org_id, actor_type, actor_user_id, actor_api_key_id,
        impersonator_user_id, resource_type, resource_id, trace_id, before, after, detail, chain_seq, hash
      FROM audit.audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY occurred_at DESC, id DESC LIMIT $${p.length}`;
    return { sql, p };
  }

  private page(rows: AuditRow[], limit: number) {
    const items: AuditItem[] = rows.slice(0, limit).map((r) => ({
      id: r.id,
      occurredAt: (r.occurred_at as Date).toISOString(),
      action: r.action,
      outcome: r.outcome,
      orgId: r.org_id,
      actor: {
        type: r.actor_type,
        userId: r.actor_user_id,
        apiKeyId: r.actor_api_key_id,
        impersonatorUserId: r.impersonator_user_id,
      },
      resource: { type: r.resource_type, id: r.resource_id },
      traceId: r.trace_id,
      before: r.before,
      after: r.after,
      detail: r.detail,
      chainSeq: Number(r.chain_seq),
      hash: r.hash,
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? cursorOf(last.occurred_at, last.id) : null };
  }

  /** The caller's own organization only (RLS: app.org_id). */
  async listForOrg(orgId: string, f: AuditFilter) {
    const { sql, p } = this.build({ ...f, orgId: undefined });
    return this.page(
      await this.db.withOrg(orgId, async (c) => (await c.query<AuditRow>(sql, p)).rows),
      f.limit,
    );
  }

  /** Cross-organization (admin console). Callers must have verified `admin:audit:read`. */
  async listAll(f: AuditFilter) {
    const { sql, p } = this.build(f);
    return this.page(
      await this.db.withPlatformScope(async (c) => (await c.query<AuditRow>(sql, p)).rows),
      f.limit,
    );
  }
}
