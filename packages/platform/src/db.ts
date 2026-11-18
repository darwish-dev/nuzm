import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import { PlatformError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The transaction currently running on this async path (set by `Db.tx`, cleared when it ends). */
export interface ActiveTx {
  readonly client: PoolClient;
  /** `app.org_id` of the transaction, if it is org-scoped. */
  readonly orgId?: string;
  /** False once COMMIT/ROLLBACK ran: a late (un-awaited) continuation must never use the released client. */
  open: boolean;
}
const txStore = new AsyncLocalStorage<ActiveTx>();
/** Lets cross-cutting writers (the audit sink) join the caller's transaction so both commit or neither does. */
export const activeTx = (): ActiveTx | undefined => {
  const t = txStore.getStore();
  return t?.open ? t : undefined;
};

/**
 * Transaction helper that applies PostgreSQL row-level-security context. GUCs are set with
 * `set_config(..., is_local = true)`, so they vanish at COMMIT/ROLLBACK and can never leak across
 * pooled connections. Org context must come from verified auth, never from request input.
 */
export class Db {
  readonly pool: Pool;

  constructor(url: string, opts: { max?: number } = {}) {
    this.pool = new Pool({ connectionString: url, max: opts.max ?? 10 });
  }

  private async tx<T>(gucs: Record<string, string>, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [k, v] of Object.entries(gucs))
        await client.query('SELECT set_config($1, $2, true)', [k, v]);
      const entry: ActiveTx = { client, orgId: gucs['app.org_id'], open: true };
      try {
        const result = await txStore.run(entry, () => fn(client));
        entry.open = false;
        await client.query('COMMIT');
        return result;
      } finally {
        entry.open = false;
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Active-org context. Optionally also records the caller (`app.user_id`) for rows scoped to both. */
  withOrg<T>(
    orgId: string,
    fn: (c: PoolClient) => Promise<T>,
    opts: { userId?: string } = {},
  ): Promise<T> {
    if (!UUID.test(orgId)) throw new PlatformError('validation_failed', 'orgId must be a UUID');
    if (opts.userId !== undefined && !UUID.test(opts.userId))
      throw new PlatformError('validation_failed', 'userId must be a UUID');
    return this.tx(
      { 'app.org_id': orgId, ...(opts.userId ? { 'app.user_id': opts.userId } : {}) },
      fn,
    );
  }

  /** Caller-scoped context: lets a user discover THEIR memberships/organizations before picking an org. */
  withUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID.test(userId)) throw new PlatformError('validation_failed', 'userId must be a UUID');
    return this.tx({ 'app.user_id': userId }, fn);
  }

  /** Explicit, audited cross-org scope for the worker claim loop (operations, outbox). */
  withWorkerClaim<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx({ 'app.worker_scope': 'claim' }, fn);
  }

  /**
   * Admin-console scope: cross-organization reads (organizations, memberships, audit) and global flag writes.
   * Call ONLY from the admin module AFTER the access guard has verified a platform permission.
   */
  withPlatformScope<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx({ 'app.platform_scope': 'admin' }, fn);
  }

  /** Pre-org lookups that identify the org (API key prefix). */
  withAuthScope<T>(
    scope: 'api_key_lookup' | 'invitation_accept' | 'psp_webhook' | 'sso_lookup' | 'scim_lookup',
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.tx({ 'app.auth_scope': scope }, fn);
  }

  /** Tenant-less tables only (identity.users/sessions/mfa_*, platform.webhook_events_inbound). */
  withoutScope<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx({}, fn);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
