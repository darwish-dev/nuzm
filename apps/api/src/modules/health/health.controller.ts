import { Controller, Get } from '@nestjs/common';
import { buildStatus } from './internal/status';

@Controller()
export class HealthController {
  @Get('healthz')
  healthz() {
    return buildStatus();
  }
}
