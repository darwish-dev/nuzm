import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { VaultClient } from '@nuzm/adapter-contracts';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AdapterRegistry, VAULT } from '../cloud';
import { ProviderCostService } from '../metering';
import { AdminLiveVerificationController } from './admin-live-verification.controller';
import { AdminProviderNetworkController } from './admin-provider-network.controller';
import { NetworkSettingsService } from './network-settings.service';
import { AdminProviderCostsController } from './admin-provider-costs.controller';
import { LiveVerificationService } from './live-verification.service';
import { ProviderCostCapture } from './provider-cost-capture.service';
import { parseVendorConfig, vendorEntries } from './vendor-adapters';

/** Registers the real vendor adapters (Alibaba, Huawei, Contabo) with the cloud registry and serves provider cost capture + the live-verification register. */
class VendorRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly vault: VaultClient,
    private readonly network: NetworkSettingsService,
  ) {}
  async onModuleInit() {
    // console-typed network settings are read once now; a save refreshes them, and a slow reload keeps other processes current
    await this.network
      .refresh()
      .catch((e) =>
        console.error(
          JSON.stringify({ cloud_vendors_warning: `network settings: ${(e as Error).message}` }),
        ),
      );
    setInterval(() => void this.network.refresh().catch(() => undefined), 60_000).unref();
    const config = parseVendorConfig(process.env.CLOUD_VENDOR_CONFIG, (m) =>
      console.error(JSON.stringify({ cloud_vendors_warning: m })),
    );
    for (const e of vendorEntries({
      vault: this.vault,
      redactor: this.registry.redactor,
      config,
      network: this.network,
    }))
      this.registry.register(e);
  }
}

@Module({
  controllers: [
    AdminProviderCostsController,
    AdminLiveVerificationController,
    AdminProviderNetworkController,
  ],
  providers: [
    {
      provide: NetworkSettingsService,
      useFactory: (db: Db, a: AuditSink) => new NetworkSettingsService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: VendorRegistrar,
      useFactory: (r: AdapterRegistry, v: VaultClient, n: NetworkSettingsService) =>
        new VendorRegistrar(r, v, n),
      inject: [AdapterRegistry, VAULT, NetworkSettingsService],
    },
    {
      provide: ProviderCostCapture,
      useFactory: (db: Db, r: AdapterRegistry, c: ProviderCostService, a: AuditSink) =>
        new ProviderCostCapture(db, r, c, a),
      inject: [DB, AdapterRegistry, ProviderCostService, AuditSink],
    },
    {
      provide: LiveVerificationService,
      useFactory: (db: Db, a: AuditSink) => new LiveVerificationService(db, a),
      inject: [DB, AuditSink],
    },
  ],
  exports: [ProviderCostCapture, LiveVerificationService],
})
export class CloudVendorsModule {
  constructor(@Inject(VendorRegistrar) _r: VendorRegistrar) {} // instantiate so onModuleInit runs
}
