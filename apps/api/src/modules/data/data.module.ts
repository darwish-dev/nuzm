import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  MockCacheAdapter,
  MockDatabaseAdapter,
  MockMailboxAdapter,
  MockObjectStorageAdapter,
  MockTransactionalEmailAdapter,
} from '@nuzm/adapter-data';
import { OperationsService, type Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { SecretStore } from '../../common/secrets';
import { DB } from '../../common/tokens';
import { EntitlementService, PriceBookService } from '../billing';
import { OrderService, QuotePricerRegistry } from '../commerce';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { NotificationService } from '../notifications';
import { AdminDataProvidersController } from './admin-data-providers.controller';
import { DatabasesController } from './databases.controller';
import { DataAdapterRegistry, StaticDataAdapterRegistry } from './internal/adapter-registry';
import { DataAlerts } from './internal/alerts';
import { DatabaseBindingPort, NoBindings } from './internal/binding.port';
import { DatabaseCatalog } from './internal/catalog';
import { DatabaseFlow } from './internal/database-flow';
import { DatabaseService } from './internal/database.service';
import { DataFlags, localReferenceEnabled } from './internal/flags';
import { DataJobs } from './internal/jobs';
import { DataMetering } from './internal/metering';
import { DATA_CONFIG, loadDataConfig, type DataConfig } from './internal/model';
import { DataOperations } from './internal/operations-port';
import { DatabasePricer } from './internal/pricers';
import { DataProviderService } from './internal/provider.service';
import { RestoreService } from './internal/restore.service';
import { RotationService } from './internal/rotation.service';
import { StorageFlow } from './internal/storage-flow';
import { StoragePricer } from './internal/storage-pricer';
import { StorageService } from './internal/storage.service';
import { StorageController } from './storage.controller';

const PRICERS = Symbol('DATA_PRICERS');

/**
 * Managed data (M08): databases, Redis, object storage; email lives in its own module. No provider is chosen here (D-05..D-09 OPEN): the registry is EMPTY
 * unless `DATA_LOCAL_REFERENCE=true` outside production, which registers the in-memory dev-reference adapters (`mock-*`, NOT VERIFIED). Production
 * therefore answers 422 `unsupported_capability` for every managed-data request until a provider is decided, probed, evidenced and enabled.
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [DatabasesController, StorageController, AdminDataProvidersController],
  providers: [
    { provide: DATA_CONFIG, useFactory: () => loadDataConfig() },
    {
      provide: DataAdapterRegistry,
      useFactory: () => {
        const r = new StaticDataAdapterRegistry();
        if (localReferenceEnabled()) {
          const clock = { now: () => Date.now() };
          r.register('database', 'mock-database', new MockDatabaseAdapter(clock));
          r.register('cache', 'mock-cache', new MockCacheAdapter(clock));
          r.register('object-storage', 'mock-object-storage', new MockObjectStorageAdapter(clock));
          r.register(
            'transactional-email',
            'mock-transactional-email',
            new MockTransactionalEmailAdapter(clock),
          );
          r.register('mailbox', 'mock-mailbox', new MockMailboxAdapter(clock));
        }
        return r;
      },
    },
    { provide: DataFlags, useFactory: (db: Db) => new DataFlags(db), inject: [DB] },
    {
      provide: DataProviderService,
      useFactory: (db: Db, a: AuditSink, r: DataAdapterRegistry, f: DataFlags) =>
        new DataProviderService(db, a, r, f),
      inject: [DB, AuditSink, DataAdapterRegistry, DataFlags],
    },
    {
      provide: DatabaseCatalog,
      useFactory: (p: DataProviderService, r: DataAdapterRegistry) => new DatabaseCatalog(p, r),
      inject: [DataProviderService, DataAdapterRegistry],
    },
    { provide: DatabaseBindingPort, useClass: NoBindings },
    {
      provide: DataOperations,
      useFactory: (o: OperationsService, db: Db) => new DataOperations(o, db),
      inject: [OperationsService, DB],
    },
    {
      provide: DatabaseService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        c: DatabaseCatalog,
        ord: OrderService,
        e: EntitlementService,
        b: DatabaseBindingPort,
        cfg: DataConfig,
      ) => new DatabaseService(db, a, o, c, ord, e, b, cfg),
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DatabaseCatalog,
        OrderService,
        EntitlementService,
        DatabaseBindingPort,
        DATA_CONFIG,
      ],
    },
    {
      provide: DataAlerts,
      useFactory: (db: Db, n: NotificationService) => new DataAlerts(db, n),
      inject: [DB, NotificationService],
    },
    {
      provide: DatabaseFlow,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        p: DataProviderService,
        r: DataAdapterRegistry,
        s: SecretStore,
        res: ResidencyService,
        c: DatabaseCatalog,
        cfg: DataConfig,
      ) => new DatabaseFlow(db, a, o, p, r, s, res, c, cfg),
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DataProviderService,
        DataAdapterRegistry,
        SecretStore,
        ResidencyService,
        DatabaseCatalog,
        DATA_CONFIG,
      ],
    },
    {
      provide: RestoreService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        d: DatabaseService,
        f: DatabaseFlow,
        al: DataAlerts,
        cfg: DataConfig,
        jobs: DataJobs,
      ) => {
        const s = new RestoreService(db, a, o, d, f, al, cfg);
        s.setKicker((org, id) => jobs.kick(org, id));
        return s;
      },
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DatabaseService,
        DatabaseFlow,
        DataAlerts,
        DATA_CONFIG,
        DataJobs,
      ],
    },
    {
      provide: RotationService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        d: DatabaseService,
        f: DatabaseFlow,
        b: DatabaseBindingPort,
        al: DataAlerts,
        s: SecretStore,
        cfg: DataConfig,
        jobs: DataJobs,
      ) => {
        const x = new RotationService(db, a, o, d, f, b, al, s, cfg);
        x.setKicker((org, id) => jobs.kick(org, id));
        return x;
      },
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DatabaseService,
        DatabaseFlow,
        DatabaseBindingPort,
        DataAlerts,
        SecretStore,
        DATA_CONFIG,
        DataJobs,
      ],
    },
    {
      provide: StorageService,
      useFactory: (
        db: Db,
        a: AuditSink,
        o: DataOperations,
        p: DataProviderService,
        r: DataAdapterRegistry,
        ord: OrderService,
        e: EntitlementService,
        res: ResidencyService,
        cfg: DataConfig,
        jobs: DataJobs,
      ) => {
        const s = new StorageService(db, a, o, p, r, ord, e, res, cfg);
        s.setKicker((org, id) => jobs.kick(org, id));
        return s;
      },
      inject: [
        DB,
        AuditSink,
        DataOperations,
        DataProviderService,
        DataAdapterRegistry,
        OrderService,
        EntitlementService,
        ResidencyService,
        DATA_CONFIG,
        DataJobs,
      ],
    },
    {
      provide: StorageFlow,
      useFactory: (f: DatabaseFlow, s: StorageService, al: DataAlerts) => new StorageFlow(f, s, al),
      inject: [DatabaseFlow, StorageService, DataAlerts],
    },
    { provide: DataMetering, useFactory: (db: Db) => new DataMetering(db), inject: [DB] },
    {
      provide: DataJobs,
      useFactory: (db: Db, f: DatabaseFlow, d: DatabaseService, m: DataMetering) =>
        new DataJobs(db, f, d, m),
      inject: [DB, DatabaseFlow, DatabaseService, DataMetering],
    },
    {
      provide: PRICERS,
      useFactory: (
        reg: QuotePricerRegistry,
        db: Db,
        prices: PriceBookService,
        p: DataProviderService,
        c: DatabaseCatalog,
        res: ResidencyService,
        cfg: DataConfig,
        storage: StorageService,
      ) => {
        reg.register(new DatabasePricer(db, prices, p, c, res, cfg.hoursPerMonth));
        reg.register(new StoragePricer(db, prices, storage, res));
        return true;
      },
      inject: [
        QuotePricerRegistry,
        DB,
        PriceBookService,
        DataProviderService,
        DatabaseCatalog,
        ResidencyService,
        DATA_CONFIG,
        StorageService,
      ],
    },
  ],
  exports: [
    DATA_CONFIG,
    DataFlags,
    StorageService,
    StorageFlow,
    DataProviderService,
    DataAdapterRegistry,
    DatabaseService,
    DatabaseFlow,
    RestoreService,
    RotationService,
    DataJobs,
    DataMetering,
    DatabaseBindingPort,
    DataAlerts,
    DataOperations,
  ],
})
export class DataModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly jobs: DataJobs,
    private readonly restores: RestoreService,
    private readonly rotations: RotationService,
    private readonly storageFlow: StorageFlow,
    @Inject(PRICERS) _pricers: boolean,
  ) {}
  onApplicationBootstrap() {
    // background tasks that need services which depend on the jobs object are attached here (no constructor cycle)
    this.jobs.addTask({ name: 'restore-verification', run: (n) => this.restores.verifyDue(n) });
    this.jobs.addTask({ name: 'rotation-window-end', run: (n) => this.rotations.endWindows(n) });
    this.jobs.addTask({
      name: 'storage-usage',
      run: (n) => this.storageFlow.collectUsage(new Date(n.getTime() - 86_400_000)),
    });
    this.jobs.start(DataJobs.intervalFromEnv());
  }
  onApplicationShutdown() {
    this.jobs.stop();
  }
}
