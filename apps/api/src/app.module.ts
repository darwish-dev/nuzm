import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { PlatformModule } from './modules/platform';

@Module({ imports: [PlatformModule, IdentityModule, HealthModule] })
export class AppModule {}
