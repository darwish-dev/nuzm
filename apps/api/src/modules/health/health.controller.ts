import { Controller, Get } from '@nestjs/common';
import { Public } from '../identity';
import { buildStatus } from './internal/status';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return buildStatus();
  }
}
