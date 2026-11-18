import type { CacheAdapter, DatabaseAdapter } from '@nuzm/adapter-data';
import { ProblemException } from '../../../common/errors';
import { serviceOfEngine, type Engine } from './model';
import type { DataAdapterRegistry } from './adapter-registry';
import type { DataProviderService } from './provider.service';

export interface DatabaseOffer {
  providerId: string;
  providerCode: string;
  family: string;
  engine: Engine;
  version: string;
  planRef: string;
  providerRegionId: string;
  /** The data region recorded on the instance (`data_region`); equals the provider region unless the provider config maps it otherwise. */
  dataRegion: string;
}

/**
 * What a customer may be offered (docs/09 §8, applied to data services): an enabled provider for the engine's service with a registered adapter,
 * a probe that reports the engine/service as supported, a version listed in the provider config (the matrix is configuration, not code), a plan the
 * adapter's catalog lists as AVAILABLE, and a region the catalog reports (verified, unless the provider is a dev-reference one). Anything else is
 * `422 unsupported_capability`: nothing is invented and nothing is shown for an unprobed capability.
 */
export class DatabaseCatalog {
  constructor(
    private readonly providers: DataProviderService,
    private readonly registry: DataAdapterRegistry,
  ) {}

  async offer(
    orgId: string,
    engine: Engine,
    want: { version: string; planRef: string; region?: string },
  ): Promise<DatabaseOffer> {
    const service = serviceOfEngine(engine);
    const { row, adapter } = await this.providers.resolveEnabled(orgId, service);
    const caps = row.probe?.capabilities ?? {};
    const need = service === 'cache' ? 'cache.provision' : `database.engine.${engine}`;
    if (caps[need] !== 'supported' || !row.probe?.passed)
      throw new ProblemException(
        'unsupported_capability',
        `the provider's probe does not report ${need} as supported`,
      );
    const versions =
      ((row.config.versions as Record<string, string[]> | undefined) ?? {})[engine] ?? [];
    if (!versions.includes(want.version))
      throw new ProblemException(
        'unsupported_capability',
        `version ${want.version} of ${engine} is not in the supported list${versions.length ? ` (${versions.join(', ')})` : ''}`,
      );
    const ctx = this.registry.ctx({ id: row.id, config: row.config }, 'catalog');
    const cat = await (adapter as DatabaseAdapter | CacheAdapter).catalog(ctx);
    const plan = cat.plans.find((p) => p.planRef === want.planRef);
    if (!plan || plan.availability !== 'available')
      throw new ProblemException('unsupported_capability', `plan ${want.planRef} is not available`);
    const configured = row.config.defaultRegion as string | undefined;
    const regionId = want.region ?? configured ?? cat.regions[0]?.providerRegionId;
    const region = cat.regions.find((r) => r.providerRegionId === regionId);
    if (!region || (plan.providerRegionId && plan.providerRegionId !== region.providerRegionId))
      throw new ProblemException(
        'unsupported_capability',
        'the region is not offered for this plan',
      );
    if (region.verifiedAt === null && row.environment !== 'local')
      throw new ProblemException(
        'unsupported_capability',
        'the region is not verified for this account',
      );
    const map = (row.config.regionMap as Record<string, string> | undefined) ?? {};
    return {
      providerId: row.id,
      providerCode: row.providerCode,
      family: row.family,
      engine,
      version: want.version,
      planRef: want.planRef,
      providerRegionId: region.providerRegionId,
      dataRegion: map[region.providerRegionId] ?? region.providerRegionId,
    };
  }
}
