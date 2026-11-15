import { Pool, type PoolClient } from 'pg';
import { PlatformError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  withOrg<T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID.test(orgId)) throw new PlatformError('validation_failed', 'orgId must be a UUID');
    return this.tx({ 'app.org_id': orgId }, fn);
  }

  /** Explicit, audited cross-org scope for the worker claim loop (operations, outbox). */
  withWorkerClaim<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx({ 'app.worker_scope': 'claim' }, fn);
  }

  /** Pre-org lookups that identify the org (API key prefix). */
  withAuthScope<T>(scope: 'api_key_lookup', fn: (c: PoolClient) => Promise<T>): Promise<T> {
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
