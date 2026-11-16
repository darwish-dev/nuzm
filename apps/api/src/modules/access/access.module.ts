import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Db } from '@nuzm/platform';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import { AccessGuard } from './access.guard';
import { ApiKeysController } from './api-keys.controller';
import { MeController } from './me.controller';
import { PolicyService } from './policy.service';

@Module({
  imports: [IdentityModule],
  controllers: [MeController, ApiKeysController],
  providers: [
    { provide: PolicyService, useFactory: (db: Db) => new PolicyService(db), inject: [DB] },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [PolicyService],
})
export class AccessModule {}
