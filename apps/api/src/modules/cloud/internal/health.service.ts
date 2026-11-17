import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { AdapterRegistry } from './adapter-registry';
import { isProduction } from './adapter-registry';
import type { Row } from './common';

/**
 * Scheduled account health (S16 task 5): asks each active account's adapter for its health, feeds the circuit breaker, and stores
 * `health_state` + the breaker snapshot (exposed by the admin API). A failing health check never throws out of the sweep.
 */
export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapters: AdapterRegistry,
  ) {}

  async checkAccount(accountId: string): Promise<{ state: string; changed: boolean } | null> {
    const a = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.id, a.vault_ref, a.health_state, p.adapter_id, p.environment_policy FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE a.id = $1 AND a.status = 'active' AND p.status = 'active'`,
            [accountId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!a || (a.environment_policy === 'non_production_only' && isProduction())) return null;
    const adapter = this.adapters.compute(a.adapter_id as string);
    if (!adapter) return null;
    const report = await adapter
      .health(
        this.adapters.ctx(
          { id: accountId, vaultRef: a.vault_ref as string },
          `health-${accountId}`,
          10_000,
        ),
      )
      .catch(() => ({ state: 'unhealthy' as const, checkedAt: new Date().toISOString() }));
    this.adapters.noteHealth(accountId, report.state);
    const changed = a.health_state !== report.state;
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE cloud.provider_accounts SET health_state = $2, last_health_at = now(), breaker_state = $3 WHERE id = $1`,
        [accountId, report.state, JSON.stringify(this.adapters.breaker(accountId))],
      );
      if (changed)
        await this.audit.record({
          action: 'provider.account.health_changed',
          resource: { type: 'provider_account', id: accountId },
          outcome: 'success',
          detail: { from: a.health_state, to: report.state },
        });
    });
    return { state: report.state, changed };
  }

  async sweep(): Promise<number> {
    const ids = await this.db.withPlatformScope(async (c) =>
      (await c.query(`SELECT id FROM cloud.provider_accounts WHERE status = 'active'`)).rows.map(
        (r) => r.id as string,
      ),
    );
    let n = 0;
    for (const id of ids) if (await this.checkAccount(id).catch(() => null)) n++;
    return n;
  }
}
