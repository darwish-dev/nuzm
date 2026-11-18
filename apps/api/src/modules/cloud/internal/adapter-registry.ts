import {
  Redactor,
  VaultError,
  type AccountContext,
  type ComputeAdapter,
  type EgressPolicy,
  type VaultClient,
} from '@nuzm/adapter-contracts';
import {
  FileVaultClient,
  GuardedCompute,
  OffsetClock,
  systemClock,
  type BreakerSnapshot,
  type Clock,
} from '@nuzm/adapter-runtime';
import { MockComputeAdapter } from '@nuzm/adapter-mock-compute';

export interface AdapterEntry {
  adapterId: string;
  /** Mock/fixture-only adapters never run in a production profile (the provider row also carries `environment_policy`). */
  nonProductionOnly: boolean;
  /** Whether verification must resolve the account's vault reference (the simulator holds no credentials). */
  requiresCredentials: boolean;
  egress: EgressPolicy;
  create(): ComputeAdapter;
}

export const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Maps adapter ids to implementations and applies the framework wrapper (docs/09 §1): per-account rate limit + circuit breaker, redaction.
 * Real vendor adapters register here when they exist (S18-S22); until then an account of such a provider fails verification honestly
 * with `adapter_not_available` — nothing is faked.
 */
export class AdapterRegistry {
  readonly redactor = new Redactor();
  private readonly entries = new Map<string, AdapterEntry>();
  private readonly cache = new Map<string, ComputeAdapter>();
  private guard: GuardedCompute;
  constructor(
    readonly clock: Clock = systemClock,
    opts: {
      rate?: { burst: number; perSecond: number };
      breaker?: { failureThreshold: number; cooldownMs: number };
    } = {},
  ) {
    this.guard = new GuardedCompute({ clock, redactor: this.redactor, ...opts });
  }
  register(e: AdapterEntry): this {
    this.entries.set(e.adapterId, e);
    this.cache.delete(e.adapterId);
    return this;
  }
  has(adapterId: string): boolean {
    const e = this.entries.get(adapterId);
    return !!e && !(e.nonProductionOnly && isProduction());
  }
  entry(adapterId: string): AdapterEntry | undefined {
    return this.has(adapterId) ? this.entries.get(adapterId) : undefined;
  }
  /** The guarded adapter, or undefined when none is registered (or it is non-production-only in production). */
  compute(adapterId: string): ComputeAdapter | undefined {
    const e = this.entry(adapterId);
    if (!e) return undefined;
    let a = this.cache.get(adapterId);
    if (!a) {
      a = this.guard.wrap(e.create());
      this.cache.set(adapterId, a);
    }
    return a;
  }
  breaker(accountId: string): BreakerSnapshot {
    return this.guard.breakerSnapshot(accountId);
  }
  noteHealth(accountId: string, state: string): void {
    this.guard.noteHealth(accountId, state === 'healthy' || state === 'degraded');
  }
  ctx(
    account: { id: string; vaultRef: string },
    traceId: string,
    deadlineMs = 15_000,
  ): AccountContext {
    return { providerAccountId: account.id, credentialRef: account.vaultRef, traceId, deadlineMs };
  }
}

/**
 * The dev simulator, registered only outside production. One instance per process (state is in memory). Outside production the registry runs on an
 * `OffsetClock` (wall time + an advanceable offset) shared with the simulator, so tests and demos can move time forward for the whole cloud module.
 */
export function defaultAdapterRegistry(
  clock: Clock = isProduction() ? systemClock : new OffsetClock(),
): AdapterRegistry {
  const r = new AdapterRegistry(clock);
  if (!isProduction()) {
    let shared: MockComputeAdapter | null = null;
    r.register({
      adapterId: 'mock-compute',
      nonProductionOnly: true,
      requiresCredentials: false,
      egress: { adapterId: 'mock-compute', hosts: [] },
      create: () =>
        (shared ??= new MockComputeAdapter({
          clock: clock instanceof OffsetClock ? clock : new OffsetClock(),
        })),
    });
  }
  return r;
}

/** Vault used when none is configured: nothing resolves. In production this is the BLOCKED state (D-12 / HG-01-02). */
export class UnconfiguredVault implements VaultClient {
  async resolve(): Promise<never> {
    throw new VaultError(
      isProduction() ? 'blocked' : 'not_found',
      isProduction()
        ? 'no production vault is configured (BLOCKED on D-12 / HG-01-02)'
        : 'no vault is configured (set NUZM_DEV_VAULT_FILE for the non-production file stub)',
    );
  }
}

export function vaultFromEnv(redactor: Redactor): VaultClient {
  const file = process.env.NUZM_DEV_VAULT_FILE;
  if (file && !isProduction()) return new FileVaultClient({ path: file, redactor });
  return new UnconfiguredVault();
}
