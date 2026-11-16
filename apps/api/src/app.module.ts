import { Module } from '@nestjs/common';
import { AccessModule } from './modules/access';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { PlatformModule } from './modules/platform';
import { TenancyModule } from './modules/tenancy';

@Module({ imports: [PlatformModule, IdentityModule, AccessModule, TenancyModule, HealthModule] })
export class AppModule {}
