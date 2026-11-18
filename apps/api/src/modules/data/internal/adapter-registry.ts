import type {
  AccountContext,
  CacheAdapter,
  DatabaseAdapter,
  DataService,
  MailboxAdapter,
  ObjectStorageAdapter,
  TransactionalEmailAdapter,
} from '@nuzm/adapter-data';

export type AnyDataAdapter =
  | DatabaseAdapter
  | CacheAdapter
  | ObjectStorageAdapter
  | TransactionalEmailAdapter
  | MailboxAdapter;
export interface ServiceAdapters {
  database: DatabaseAdapter;
  cache: CacheAdapter;
  'object-storage': ObjectStorageAdapter;
  'transactional-email': TransactionalEmailAdapter;
  mailbox: MailboxAdapter;
}

/**
 * Which adapters this process can use, keyed by (service, provider code). Production registers none until a provider is decided (D-05..D-09) and its
 * adapter exists: an unregistered provider can never be enabled or used. Local/CI registers the in-memory dev-reference adapters (`mock-*`).
 */
export abstract class DataAdapterRegistry {
  abstract register<S extends DataService>(
    service: S,
    providerCode: string,
    adapter: ServiceAdapters[S],
  ): void;
  abstract get<S extends DataService>(service: S, providerCode: string): ServiceAdapters[S] | null;
  abstract codes(service: DataService): string[];
  /** Milliseconds since epoch (a clock the tests control). */
  abstract nowMs(): number;
  ctx(provider: { id: string; config: Record<string, unknown> }, traceId: string): AccountContext {
    const ref = String(provider.config.credentialRef ?? '');
    return {
      providerAccountId: provider.id,
      credentialRef: /^vault:\/\//.test(ref) ? ref : 'vault://unconfigured',
      traceId,
      deadlineMs: 30_000,
    };
  }
}

export class StaticDataAdapterRegistry extends DataAdapterRegistry {
  private readonly m = new Map<string, AnyDataAdapter>();
  constructor(private readonly clock: () => number = () => Date.now()) {
    super();
  }
  register<S extends DataService>(service: S, providerCode: string, adapter: ServiceAdapters[S]) {
    this.m.set(`${service}:${providerCode}`, adapter);
  }
  get<S extends DataService>(service: S, providerCode: string): ServiceAdapters[S] | null {
    return (this.m.get(`${service}:${providerCode}`) as ServiceAdapters[S] | undefined) ?? null;
  }
  codes(service: DataService): string[] {
    return [...this.m.keys()]
      .filter((k) => k.startsWith(`${service}:`))
      .map((k) => k.slice(service.length + 1));
  }
  nowMs() {
    return this.clock();
  }
}
