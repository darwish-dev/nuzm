import type { Db } from '@nuzm/platform';
import {
  isSupported,
  normalizedError,
  type AccountContext,
  type CapabilityState,
  type OperationResult,
  type RegistrarAdapter,
  type RegistrarCapabilityId,
  type TldSupport,
  type VaultClient,
} from '@nuzm/registrar-contracts';
import { ProblemException } from '../../../common/errors';
import type { Row } from './common';

export interface RegistrarAccount {
  id: string;
  registrarId: string;
  providerCode: string;
  label: string;
  environment: 'sandbox' | 'production';
  vaultRef: string;
  webhookSecretRef: string | null;
  dataRegion: string;
  providerRegionId: string | null;
  currency: string;
  priority: number;
  enabled: boolean;
  registrarEnabled: boolean;
  health: string;
  capabilities: Partial<Record<RegistrarCapabilityId, CapabilityState>>;
  tldSupport: TldSupport[];
  evidenceKind: 'mock' | 'fixture' | 'live' | null;
  probedAt: string | null;
}
export type AdapterFactory = (
  account: RegistrarAccount,
  deps: { vault: VaultClient },
) => RegistrarAdapter;

export const toAccount = (r: Row): RegistrarAccount => ({
  id: r.id as string,
  registrarId: r.registrar_id as string,
  providerCode: r.provider_code as string,
  label: r.label as string,
  environment: r.environment as 'sandbox' | 'production',
  vaultRef: r.vault_ref as string,
  webhookSecretRef: (r.webhook_secret_ref as string | null) ?? null,
  dataRegion: r.data_region as string,
  providerRegionId: (r.provider_region_id as string | null) ?? null,
  currency: (r.currency as string).trim(),
  priority: r.priority as number,
  enabled: r.enabled as boolean,
  registrarEnabled: r.registrar_enabled as boolean,
  health: r.health as string,
  capabilities: (r.capabilities ?? {}) as RegistrarAccount['capabilities'],
  tldSupport: (r.tld_support ?? []) as TldSupport[],
  evidenceKind: (r.evidence_kind as RegistrarAccount['evidenceKind']) ?? null,
  probedAt: r.probed_at ? (r.probed_at as Date).toISOString() : null,
});

const SELECT = `SELECT a.*, r.provider_code, r.enabled AS registrar_enabled FROM domains.registrar_accounts a JOIN domains.registrars r ON r.id = a.registrar_id`;

/** Per-account circuit breaker + token bucket (docs/09 §1 rule 5). Time is injectable for tests. */
export class AccountGuard {
  private fails = 0;
  private openedAt = 0;
  private tokens: number;
  private last: number;
  constructor(
    private readonly clock: () => number,
    private readonly opts = { failureThreshold: 5, cooldownMs: 30_000, burst: 20, perSecond: 10 },
  ) {
    this.tokens = opts.burst;
    this.last = clock();
  }
  state(): 'closed' | 'open' | 'half-open' {
    if (this.fails < this.opts.failureThreshold) return 'closed';
    return this.clock() - this.openedAt >= this.opts.cooldownMs ? 'half-open' : 'open';
  }
  /** `null` = go; otherwise the reason the call must not be sent (so its failure is DEFINITIVE: nothing reached the vendor). */
  admit(): 'circuit_open' | 'local_rate_limit' | null {
    if (this.state() === 'open') return 'circuit_open';
    const now = this.clock();
    this.tokens = Math.min(
      this.opts.burst,
      this.tokens + ((now - this.last) / 1000) * this.opts.perSecond,
    );
    this.last = now;
    if (this.tokens < 1) return 'local_rate_limit';
    this.tokens -= 1;
    return null;
  }
  record(ok: boolean): void {
    if (ok) this.fails = 0;
    else {
      this.fails += 1;
      if (this.fails >= this.opts.failureThreshold) this.openedAt = this.clock();
    }
  }
}

const notSent = <T>(reason: string): OperationResult<T> => ({
  status: 'failed',
  error: normalizedError(
    reason === 'circuit_open' ? 'provider_outage' : 'rate_limit',
    reason,
    reason === 'circuit_open'
      ? 'the registrar circuit breaker is open'
      : 'the account rate limit was reached',
    true,
  ),
  raw: {
    kind: 'mock',
    capturedAt: new Date().toISOString(),
    summary: `${reason}: call was not sent`,
  },
});

/** Wraps an adapter so every vendor call passes the per-account guard. A refused call was never sent, so its `failed` result is definitive. */
export function guarded(adapter: RegistrarAdapter, guard: AccountGuard): RegistrarAdapter {
  const wrap =
    <A extends unknown[], T>(fn: (...a: A) => Promise<OperationResult<T>>) =>
    async (...a: A): Promise<OperationResult<T>> => {
      const why = guard.admit();
      if (why) return notSent<T>(why);
      const r = await fn(...a);
      guard.record(
        !(
          r.status === 'uncertain' ||
          (r.status === 'failed' && r.error?.category === 'provider_outage')
        ),
      );
      return r;
    };
  const out = Object.create(adapter) as RegistrarAdapter;
  const w = out as unknown as Record<string, unknown>;
  const a = adapter as unknown as Record<
    string,
    (...x: unknown[]) => Promise<OperationResult<unknown>>
  >;
  for (const m of [
    'register',
    'transferIn',
    'renew',
    'inspect',
    'findByToken',
    'setContacts',
    'setNameservers',
    'setLock',
    'setAutoRenew',
    'authCode',
  ])
    if (typeof a[m] === 'function') w[m] = wrap((...x: unknown[]) => a[m]!.apply(adapter, x));
  const search = adapter.search.bind(adapter);
  out.search = async (ctx, names, tlds) => {
    const why = guard.admit();
    if (why)
      throw new ProblemException('service_unavailable', `registrar search is unavailable (${why})`);
    try {
      const r = await search(ctx, names, tlds);
      guard.record(true);
      return r;
    } catch (e) {
      guard.record(false);
      throw e;
    }
  };
  return out;
}

export interface AccountAccess {
  account: RegistrarAccount;
  adapter: RegistrarAdapter;
  ctx: AccountContext;
  guard: AccountGuard;
}

/** Resolves registrar accounts, their adapters and capability matrix; chooses the account that serves a TLD. */
export class RegistrarAccessService {
  private readonly guards = new Map<string, AccountGuard>();
  constructor(
    private readonly db: Db,
    private readonly factories: Record<string, AdapterFactory>,
    private readonly vault: VaultClient,
    private readonly clock: () => number = () => Date.now(),
    private readonly guardOpts?: {
      failureThreshold: number;
      cooldownMs: number;
      burst: number;
      perSecond: number;
    },
  ) {}

  guardFor(accountId: string): AccountGuard {
    let g = this.guards.get(accountId);
    if (!g) this.guards.set(accountId, (g = new AccountGuard(this.clock, this.guardOpts)));
    return g;
  }

  async listAccounts(): Promise<RegistrarAccount[]> {
    const rows = await this.db.withoutScope(
      async (c) =>
        (await c.query(`${SELECT} ORDER BY a.priority, r.provider_code, a.id`)).rows as Row[],
    );
    return rows.map(toAccount);
  }
  async getAccount(id: string): Promise<RegistrarAccount | null> {
    const rows = await this.db.withoutScope(
      async (c) => (await c.query(`${SELECT} WHERE a.id = $1`, [id])).rows as Row[],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /** The guarded adapter and context for an account; null when no factory exists for its provider (nothing is built for an unknown vendor). */
  async access(
    accountId: string,
    traceId: string,
    deadlineMs = 15_000,
  ): Promise<AccountAccess | null> {
    const account = await this.getAccount(accountId);
    if (!account) return null;
    return this.accessFor(account, traceId, deadlineMs);
  }
  accessFor(account: RegistrarAccount, traceId: string, deadlineMs = 15_000): AccountAccess | null {
    const factory = this.factories[account.providerCode];
    if (!factory) return null;
    const guard = this.guardFor(account.id);
    return {
      account,
      adapter: guarded(factory(account, { vault: this.vault }), guard),
      ctx: { providerAccountId: account.id, credentialRef: account.vaultRef, traceId, deadlineMs },
      guard,
    };
  }

  /** Accounts that may sell right now: enabled registrar + enabled account + not unhealthy + a probe on record. */
  async sellableAccounts(): Promise<RegistrarAccount[]> {
    return (await this.listAccounts()).filter(
      (a) => a.registrarEnabled && a.enabled && a.health !== 'unhealthy' && a.probedAt !== null,
    );
  }
  /** Best account for a TLD (lowest priority number, then oldest). The platform decision (policy) is made by the caller from the returned support. */
  async pick(
    tld: string,
    need: RegistrarCapabilityId[] = [],
  ): Promise<{ account: RegistrarAccount; support: TldSupport } | null> {
    for (const a of await this.sellableAccounts()) {
      const support = a.tldSupport.find((t) => t.tld === tld);
      if (support && need.every((n) => isSupported(a.capabilities, n)))
        return { account: a, support };
    }
    return null;
  }
}
