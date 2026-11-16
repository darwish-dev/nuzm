import { createHmac } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { AuditSink, type AuditEvent } from '../../../common/audit';
import { currentRequest } from '../../../common/request-context';

const SECRET_KEY = /secret|token|password|passwd|code|otpauth|authorization|cookie|api[_-]?key/i;

/** Defence in depth: strip anything secret-shaped from free-form audit payloads before persisting. */
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        SECRET_KEY.test(k) ? '[redacted]' : scrub(x, depth + 1),
      ]),
    );
  return typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
}

/**
 * Persistent audit sink: appends to the hash-chained `audit.audit_logs`. The chain link/hash are computed by a
 * database trigger. The row is written in its own transaction AFTER the mutation commits; if the write fails
 * the full event goes to stderr (structured, no secrets) and the error propagates, so an unaudited mutation is
 * never silent. (Same-transaction audit is a tracked follow-up, see the S04 report.)
 */
export class DbAuditSink extends AuditSink {
  constructor(
    private readonly db: Db,
    private readonly hashKey: Uint8Array,
  ) {
    super();
  }

  private h(v: string | undefined): string | null {
    return v ? createHmac('sha256', this.hashKey).update(v).digest('hex').slice(0, 32) : null;
  }

  async record(e: AuditEvent): Promise<void> {
    const req = currentRequest();
    const access = req?.access;
    const principal = req?.principal;
    const impersonator = e.impersonatorUserId ?? principal?.impersonatorUserId;
    const apiKeyId =
      e.actorApiKeyId ?? (access?.actor.kind === 'api_key' ? access.actor.keyId : undefined);
    const userId = e.actorUserId ?? principal?.userId ?? access?.actor.userId;
    const actorType =
      e.actorType ??
      (impersonator ? 'impersonator' : apiKeyId ? 'api_key' : userId ? 'user' : 'system');
    const row = {
      id: uuidv7(),
      orgId: e.orgId ?? null,
      actingOrgId: e.actingOrgId ?? null,
      actorType,
      userId: userId ?? null,
      apiKeyId: apiKeyId ?? null,
      impersonator: impersonator ?? null,
      resourceType: e.resource?.type ?? null,
      resourceId: e.resource?.id ?? null,
      traceId: e.traceId ?? req?.traceId ?? null,
      ip: this.h(e.ip ?? req?.ip),
      ua: this.h(e.userAgent ?? (req?.headers['user-agent'] as string | undefined)),
    };
    const sql = `INSERT INTO audit.audit_logs
      (id, org_id, acting_org_id, actor_type, actor_user_id, actor_api_key_id, impersonator_user_id, action,
       resource_type, resource_id, outcome, trace_id, ip_hash, ua_hash, before, after, detail, prev_hash, hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'','')`;
    const params = [
      row.id,
      row.orgId,
      row.actingOrgId,
      row.actorType,
      row.userId,
      row.apiKeyId,
      row.impersonator,
      e.action,
      row.resourceType,
      row.resourceId,
      e.outcome,
      row.traceId,
      row.ip,
      row.ua,
      e.before ? JSON.stringify(scrub(e.before)) : null,
      e.after ? JSON.stringify(scrub(e.after)) : null,
      JSON.stringify(scrub(e.detail ?? {})),
    ];
    try {
      if (row.orgId) await this.db.withOrg(row.orgId, (c) => c.query(sql, params));
      else await this.db.withoutScope((c) => c.query(sql, params));
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          audit_write_failed: true,
          action: e.action,
          orgId: row.orgId,
          outcome: e.outcome,
          traceId: row.traceId,
          error: (err as Error).message,
        }) + '\n',
      );
      throw err;
    }
  }
}
