import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Db, IdempotencyService, OperationsService } from '@nuzm/platform';
import { IdempotencyInterceptor } from '../../common/idempotency';
import { OperationsController } from './operations.controller';
import { DB } from '../../common/tokens';

/**
 * Shared platform services. The pool connects lazily, so apps and unit tests that never touch the
 * database do not need one. DATABASE_URL must use the least-privilege runtime role (nuzm_app).
 */
@Global()
@Module({
  controllers: [OperationsController],
  providers: [
    { provide: DB, useFactory: () => new Db(process.env.DATABASE_URL ?? '') },
    {
      provide: IdempotencyService,
      useFactory: (db: Db) => new IdempotencyService(db),
      inject: [DB],
    },
    { provide: OperationsService, useFactory: (db: Db) => new OperationsService(db), inject: [DB] },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [DB, IdempotencyService, OperationsService],
})
export class PlatformModule implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onModuleDestroy() {
    await this.db.close();
  }
}
